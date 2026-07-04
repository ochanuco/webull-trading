import type { Context } from 'hono'
import { loadSymbolUniverse, type SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { escapeHtml } from '../../shared/format'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { and, asc, gte, lte, type SQL } from 'drizzle-orm'
import { createMacroEventCalendarDb, createMacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import { earningsCalendar } from '../../infrastructure/db/schema'
import type { EarningsCalendarRow, MacroEventCalendarRow } from '../../infrastructure/db/schema'
import { extractActor, recordChange } from '../../infrastructure/db/configAuditLog'
import { type DashboardBindings, renderLayout } from './layout'
import { displaySymbol, esc, inactiveTooltip, isSymbolInactive, unavailable } from './shared'

// #293 calendar events management UI helpers ===============================

/**
 * `<input value="...">` で再表示する form 入力。バリデーション失敗時は
 * 入力値を保ったまま再描画する。
 */
export interface EventsEarningsFormEcho {
  symbol: string
  earningsDate: string
  notes: string
}

export interface EventsMacroFormEcho {
  /** macro `event_type` (FOMC / CPI / NFP …)。 */
  eventType: string
  /** 自由 text の国コード (US / JP …)。schema 上は notes に集約する。 */
  country: string
  eventDate: string
  notes: string
}

export interface EventsBodyArgs {
  earnings: EarningsCalendarRow[]
  macros: MacroEventCalendarRow[]
  from: string
  to: string
  universe: SymbolUniverse | null
  errors: { section: 'earnings' | 'macro'; message: string } | null
  formEcho: {
    earnings: EventsEarningsFormEcho | null
    macro: EventsMacroFormEcho | null
  } | null
  /** 非ブロッキング警告 (例: universe 外 symbol を seed 成功した時)。 */
  notice: { section: 'earnings' | 'macro'; message: string } | null
}

/**
 * dashboard で表示する範囲 = now-30d 〜 now+30d (= "実際に gate が見る窓")。
 * `evaluateEarningsGate` / `evaluateMacroEventGate` は近未来の数営業日しか
 * 見ないので、それを内包しつつ「今月 + 来月」程度を一覧する目安。
 */
export function eventsDisplayRange(now: Date): { from: string; to: string } {
  const ms = now.getTime()
  const from = new Date(ms - 30 * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(ms + 30 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

/**
 * earnings_calendar を ([fromYmd, toYmd]) 範囲で読む。`fetchByRange` は
 * symbol 単位 read なので、ここでは全 symbol の range read を直接 SQL で発行
 * する (dashboard 一覧は universe 全体を横断するため)。
 */
export async function loadEarningsInRange(
  db: D1Database,
  fromYmd: string,
  toYmd: string,
): Promise<EarningsCalendarRow[]> {
  return createDb(db)
    .select()
    .from(earningsCalendar)
    .where(
      and(
        gte(earningsCalendar.earningsDate, fromYmd),
        lte(earningsCalendar.earningsDate, toYmd),
      ),
    )
    .orderBy(asc(earningsCalendar.earningsDate), asc(earningsCalendar.symbol))
}

export interface ValidationOkEarnings {
  ok: true
  symbol: string
  earningsDate: string
  notes: string | null
  /**
   * symbol が universe.allowedSymbols に無い場合に立つ非ブロッキング警告。
   * spec: "universe 外 symbol は保存を許す + UI で warning 表示" — save は通すが
   * dashboard 側で operator に対して typo の可能性を知らせる。universe が null
   * (load 失敗) の場合は判定スキップ (= warning なし)。
   */
  warning: string | null
}

export interface ValidationFail {
  ok: false
  error: string
}

/**
 * earnings 1 行 form を validate する。
 *   - symbol: 1〜16 chars, upper-case 正規化。universe にあれば pass; 無くても
 *     pass (warn のみ)。「inactive 銘柄でも入れさせる」spec に合わせ active
 *     判定は無視 (= 入力 → DB は raw に通す)。
 *   - earnings_date: ISO YYYY-MM-DD, round-trip valid, now-90d 〜 now+365d。
 *   - notes (= form の `notes` field): 任意, 256 chars 上限。
 */
export function validateEarningsForm(
  echo: EventsEarningsFormEcho,
  universe: SymbolUniverse | null,
): ValidationOkEarnings | ValidationFail {
  const sym = echo.symbol.trim().toUpperCase()
  if (sym.length === 0 || sym.length > 16) {
    return { ok: false, error: 'symbol は 1〜16 文字で入力してください' }
  }
  // universe 不在は warning にとどめ拒否しない (POC 姿勢、operator が unknown
  // 銘柄を seed したい場合もある、=> notes に書く運用)。
  const date = echo.earningsDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: 'event_date は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: 'event_date は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesRaw = echo.notes.trim()
  if (notesRaw.length > 256) {
    return { ok: false, error: 'notes (source) は 256 文字以内にしてください' }
  }
  // universe が読めた場合のみ allowedSymbols 照合 (case-insensitive)。null の時は
  // load 失敗なので照合をスキップ — false-positive 警告を避ける。
  let warning: string | null = null
  if (universe) {
    const inUniverse = universe.allowedSymbols.some((s) => s.toUpperCase() === sym)
    if (!inUniverse) {
      warning = `symbol "${sym}" は symbol_config (universe) に存在しません。typo でなければ symbol 管理から追加してください。`
    }
  }
  return {
    ok: true,
    symbol: sym,
    earningsDate: date,
    notes: notesRaw.length === 0 ? null : notesRaw,
    warning,
  }
}

export interface ValidationOkMacro {
  ok: true
  eventType: string
  eventDate: string
  notes: string | null
}

/**
 * macro 1 行 form を validate する。
 *
 * macro schema は `event_kind` / `country` を別 column で持たないため,
 * country は notes に prefix で混ぜる (`"US — Federal Reserve press release"`)。
 * spec 上 "country: 自由 text、escapeHtml on render" なので分離保持は必須ではない。
 */
export function validateMacroForm(echo: EventsMacroFormEcho): ValidationOkMacro | ValidationFail {
  const kindRaw = echo.eventType.trim()
  if (kindRaw.length === 0 || kindRaw.length > 32) {
    return { ok: false, error: 'event_kind は 1〜32 文字で入力してください' }
  }
  // schema 制約 `[A-Z0-9_]{1,32}` に合うよう upper-case 化し空白を `_` に
  // 置換 (`'NFP REV'` → `'NFP_REV'`)。それでも regex に外れる場合は reject。
  const kind = kindRaw.toUpperCase().replace(/\s+/g, '_')
  if (!/^[A-Z0-9_]{1,32}$/.test(kind)) {
    return {
      ok: false,
      error: 'event_kind は半角英数 + アンダースコアのみ使えます (例: FOMC / CPI / NFP)',
    }
  }
  const country = echo.country.trim()
  if (country.length > 16) {
    return { ok: false, error: 'country は 16 文字以内にしてください' }
  }
  const date = echo.eventDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: 'event_date は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: 'event_date は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesPlain = echo.notes.trim()
  // notes に "country — notes" を畳む。country / notes ともに空なら null。
  const combined =
    country.length > 0 && notesPlain.length > 0
      ? `${country} — ${notesPlain}`
      : country.length > 0
        ? country
        : notesPlain
  if (combined.length > 256) {
    return { ok: false, error: 'country + notes (source) の合計は 256 文字以内にしてください' }
  }
  return {
    ok: true,
    eventType: kind,
    eventDate: date,
    notes: combined.length === 0 ? null : combined,
  }
}

/** `YYYY-MM-DD` の文法 + 実在日付チェック (admin route の isYmd と同じ)。 */
export function isYmdRoundTrip(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === value
}

/**
 * 過去 90 日 〜 未来 365 日 (両端含む) に入っているか。date-only 比較。
 *
 * 入力は `YYYY-MM-DD` を UTC 0:00 として解釈。`now` も同じ UTC YMD に丸めた
 * 上で ±90d / ±365d する。`+ 86_400_000` の slack を付けると 91d / 366d も
 * 通ってしまうので、UTC YMD epoch ms で純粋に inclusive 比較する。
 */
export function withinClampRange(ymd: string, now: Date): boolean {
  const t = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(t)) return false
  const nowYmd = now.toISOString().slice(0, 10)
  const nowDayMs = Date.parse(`${nowYmd}T00:00:00.000Z`)
  const earliest = nowDayMs - 90 * 86_400_000
  const latest = nowDayMs + 365 * 86_400_000
  return t >= earliest && t <= latest
}

/**
 * バリデーション失敗時 / delete failure 時の再描画 helper。一覧を再 load して
 * エラーメッセージ + 入力 echo つきの events ページを返す。HTTP status は 400
 * (operator 入力起因 — 5xx ではない) を返して PRG 経由ではないことを明示。
 */
export async function renderEventsWithError(
  c: Context<DashboardBindings>,
  args: {
    section: 'earnings' | 'macro'
    message: string
    earningsEcho: EventsEarningsFormEcho | null
    macroEcho: EventsMacroFormEcho | null
  },
): Promise<Response> {
  if (!c.env.DB) {
    return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
  }
  const universe = await loadSymbolUniverse(c.env).catch(() => null)
  const { from, to } = eventsDisplayRange(new Date())
  const macroRepo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
  const [earnings, macros] = await Promise.all([
    loadEarningsInRange(c.env.DB, from, to).catch(() => [] as EarningsCalendarRow[]),
    macroRepo.fetchAll({ fromYmd: from, toYmd: to }).catch(() => [] as MacroEventCalendarRow[]),
  ])
  return c.html(
    renderLayout(
      c,
      'イベント',
      eventsBody({
        earnings,
        macros,
        from,
        to,
        universe,
        errors: { section: args.section, message: args.message },
        formEcho: { earnings: args.earningsEcho, macro: args.macroEcho },
        notice: null,
      }),
    ),
    400,
  )
}

/**
 * 保存は成功したが non-blocking 警告 (universe 外 symbol など) を operator に
 * 知らせる必要がある時の再描画 helper。HTTP status は 200 (= 保存済み)。
 */
export async function renderEventsWithNotice(
  c: Context<DashboardBindings>,
  args: {
    section: 'earnings' | 'macro'
    message: string
  },
): Promise<Response> {
  if (!c.env.DB) {
    return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
  }
  const universe = await loadSymbolUniverse(c.env).catch(() => null)
  const { from, to } = eventsDisplayRange(new Date())
  const macroRepo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
  const [earnings, macros] = await Promise.all([
    loadEarningsInRange(c.env.DB, from, to).catch(() => [] as EarningsCalendarRow[]),
    macroRepo.fetchAll({ fromYmd: from, toYmd: to }).catch(() => [] as MacroEventCalendarRow[]),
  ])
  return c.html(
    renderLayout(
      c,
      'イベント',
      eventsBody({
        earnings,
        macros,
        from,
        to,
        universe,
        errors: null,
        formEcho: null,
        notice: { section: args.section, message: args.message },
      }),
    ),
  )
}

/**
 * `/dashboard/events` の HTML 本文。earnings (上) + macro (下) の 2 セクション。
 * 各セクションは「+ 追加」`<details>` 内に form, 一覧テーブルに 削除 form。
 * 行が無いセクションは空配列メッセージで表示する (= "未登録" を明示)。
 */
export function eventsBody(args: EventsBodyArgs): string {
  const { earnings, macros, from, to, universe, errors, formEcho, notice } = args
  const earningsErr =
    errors && errors.section === 'earnings'
      ? `<p class="err"><strong>エラー:</strong> ${esc(errors.message)}</p>`
      : ''
  const macroErr =
    errors && errors.section === 'macro'
      ? `<p class="err"><strong>エラー:</strong> ${esc(errors.message)}</p>`
      : ''
  const earningsNotice =
    notice && notice.section === 'earnings'
      ? `<p class="warn"><strong>注意:</strong> ${esc(notice.message)}</p>`
      : ''
  const macroNotice =
    notice && notice.section === 'macro'
      ? `<p class="warn"><strong>注意:</strong> ${esc(notice.message)}</p>`
      : ''
  // form が前回 submit で開いていた場合は再描画でも開いた状態を維持したい (operator
  // が値を確認しながら修正できる)。エラー有りなら details[open]、無しなら閉じる。
  const earningsFormOpen = errors?.section === 'earnings' ? ' open' : ''
  const macroFormOpen = errors?.section === 'macro' ? ' open' : ''
  const eEcho = formEcho?.earnings ?? { symbol: '', earningsDate: '', notes: '' }
  const mEcho =
    formEcho?.macro ?? { eventType: '', country: '', eventDate: '', notes: '' }

  const earningsTable =
    earnings.length === 0
      ? '<p class="muted">この範囲には登録された決算がありません。</p>'
      : `<table>
    <thead><tr>
      <th>銘柄<br><span class="muted" style="font-size:10px">symbol</span></th>
      <th>決算日<br><span class="muted" style="font-size:10px">event_date</span></th>
      <th>備考<br><span class="muted" style="font-size:10px">notes</span></th>
      <th>操作</th>
    </tr></thead>
    <tbody>${earnings
      .map((r) => {
        const inactive = isSymbolInactive(r.symbol, universe)
        const sym = `<span${inactive ? ' class="symbol-disabled"' : ''}>${esc(displaySymbol(r.symbol, universe))}</span>${
          inactive
            ? ` <span class="muted" style="font-size:11px">(inactive — ${esc(inactiveTooltip(r.symbol, universe))})</span>`
            : ''
        }`
        return `<tr>
          <td>${sym}</td>
          <td>${esc(r.earningsDate)}</td>
          <td>${esc(r.notes ?? '-')}</td>
          <td><form method="post" action="/dashboard/events/earnings/${r.id}/delete" onsubmit="return confirm('${esc(r.symbol)} ${esc(r.earningsDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table>`

  const macroTable =
    macros.length === 0
      ? '<p class="muted">この範囲には登録されたマクロイベントがありません。</p>'
      : `<table>
    <thead><tr>
      <th>イベント種別<br><span class="muted" style="font-size:10px">event_type</span></th>
      <th>備考<br><span class="muted" style="font-size:10px">国 / notes</span></th>
      <th>発生日<br><span class="muted" style="font-size:10px">event_date</span></th>
      <th>操作</th>
    </tr></thead>
    <tbody>${macros
      .map((r) => {
        return `<tr>
          <td><code>${esc(r.eventType)}</code></td>
          <td>${esc(r.notes ?? '-')}</td>
          <td>${esc(r.eventDate)}</td>
          <td><form method="post" action="/dashboard/events/macro/${r.id}/delete" onsubmit="return confirm('${esc(r.eventType)} ${esc(r.eventDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table>`

  return `<p class="muted">期間: ${esc(from)} 〜 ${esc(to)} (now-30d 〜 now+30d)。<code>earnings_calendar</code> / <code>macro_event_calendar</code> は risk gate の avoid ソースです。
  add は <code>now-90d 〜 now+365d</code> の範囲に clamp します。delete は audit に記録されます。</p>

<h2 style="font-size:15px;margin:20px 0 6px 0">決算 (earnings)</h2>
${earningsErr}
${earningsNotice}
<details${earningsFormOpen} style="margin-bottom:12px">
  <summary style="cursor:pointer">+ 追加</summary>
  <form method="post" action="/dashboard/events/earnings/seed" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <label>銘柄<br><input name="symbol" value="${esc(eEcho.symbol)}" placeholder="AAPL / 7203" required maxlength="16" style="padding:4px 8px;width:140px"></label>
    <label>決算日<br><input name="earnings_date" type="date" value="${esc(eEcho.earningsDate)}" required style="padding:4px 8px"></label>
    <label>備考 (任意)<br><input name="notes" value="${esc(eEcho.notes)}" placeholder="Q2 2026 BMO" maxlength="256" style="padding:4px 8px;min-width:240px"></label>
    <button type="submit" style="padding:6px 14px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">追加</button>
  </form>
</details>
${earningsTable}

<h2 style="font-size:15px;margin:24px 0 6px 0">マクロイベント (macro)</h2>
${macroErr}
${macroNotice}
<details${macroFormOpen} style="margin-bottom:12px">
  <summary style="cursor:pointer">+ 追加</summary>
  <form method="post" action="/dashboard/events/macro/seed" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <label>イベント種別<br><input name="event_type" value="${esc(mEcho.eventType)}" placeholder="FOMC / CPI / NFP" required maxlength="32" style="padding:4px 8px;width:160px"></label>
    <label>国 (任意)<br><input name="country" value="${esc(mEcho.country)}" placeholder="US / JP" maxlength="16" style="padding:4px 8px;width:100px"></label>
    <label>発生日<br><input name="event_date" type="date" value="${esc(mEcho.eventDate)}" required style="padding:4px 8px"></label>
    <label>備考 (任意)<br><input name="notes" value="${esc(mEcho.notes)}" placeholder="June FOMC" maxlength="256" style="padding:4px 8px;min-width:240px"></label>
    <button type="submit" style="padding:6px 14px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">追加</button>
  </form>
</details>
${macroTable}`
}

/**
 * dashboard 側 form handler 用の audit log writer (#293)。admin.ts の
 * writeAuditLog と同形だが route layer が違うので local copy。actor は Access
 * middleware が `c.set('actor', ...)` 済み (ない場合は extractActor が throw
 * するので try/catch で潰す — admin 同様 audit 欠落で 500 を返したくない)。
 */
export async function writeEventsAuditLog(
  c: Context<DashboardBindings>,
  endpoint: string,
  targetKey: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (!c.env.DB) return
  try {
    const actor = extractActor(c.get('actor'))
    await recordChange(c.env.DB, {
      actor,
      endpoint,
      targetKey,
      before,
      after,
      requestId: c.get('requestId') ?? null,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'config_audit_log_write_failed',
        endpoint,
        targetKey,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
