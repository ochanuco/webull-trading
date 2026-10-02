import type { Context } from 'hono'
import { loadSymbolUniverse, type SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { and, asc, gte, lte } from 'drizzle-orm'
import { createMacroEventCalendarDb, createMacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import { earningsCalendar } from '../../infrastructure/db/schema'
import type { EarningsCalendarRow, MacroEventCalendarRow } from '../../infrastructure/db/schema'
import { extractActor, recordChange } from '../../infrastructure/db/configAuditLog'
import { type DashboardBindings, renderLayout } from './layout'
import { displaySymbol, esc, inactiveTooltip, isSymbolInactive, unavailable } from './shared'
import { FIELD_STYLE } from './webullToken'

/** Form input echoed back on a validation failure so the operator doesn't retype it. */
export interface EventsEarningsFormEcho {
  symbol: string
  earningsDate: string
  notes: string
}

export interface EventsMacroFormEcho {
  eventType: string
  /** Free-text country (US / JP …); the schema has no dedicated column, so this folds into `notes`. */
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
  /** Non-blocking, e.g. a save that succeeded despite the symbol being outside the universe. */
  notice: { section: 'earnings' | 'macro'; message: string } | null
}

// ±30d is a superset of the few business days evaluateEarningsGate / evaluateMacroEventGate
// actually look at — wide enough to browse "this month + next" at a glance.
export function eventsDisplayRange(now: Date): { from: string; to: string } {
  const ms = now.getTime()
  const from = new Date(ms - 30 * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(ms + 30 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

// Direct SQL range read across all symbols, not the per-symbol `fetchByRange`: the dashboard
// list spans the whole universe, not one symbol at a time.
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
  /** Set when `symbol` isn't in `universe.allowedSymbols` — flags a likely typo without blocking the save. */
  warning: string | null
}

export interface ValidationFail {
  ok: false
  error: string
}

export function validateEarningsForm(
  echo: EventsEarningsFormEcho,
  universe: SymbolUniverse | null,
): ValidationOkEarnings | ValidationFail {
  const sym = echo.symbol.trim().toUpperCase()
  if (sym.length === 0 || sym.length > 16) {
    return { ok: false, error: '銘柄は 1〜16 文字で入力してください' }
  }
  const date = echo.earningsDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: '日付は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: '日付は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesRaw = echo.notes.trim()
  if (notesRaw.length > 256) {
    return { ok: false, error: '備考は 256 文字以内にしてください' }
  }
  // universe===null means the load itself failed, not "no symbols" — skip the check rather
  // than raise a false-positive "unknown symbol" warning.
  let warning: string | null = null
  if (universe) {
    const inUniverse = universe.allowedSymbols.some((s) => s.toUpperCase() === sym)
    if (!inUniverse) {
      warning = `銘柄 "${sym}" は銘柄一覧に登録されていません。typo でなければ銘柄管理画面から追加してください。`
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

export function validateMacroForm(echo: EventsMacroFormEcho): ValidationOkMacro | ValidationFail {
  const kindRaw = echo.eventType.trim()
  if (kindRaw.length === 0 || kindRaw.length > 32) {
    return { ok: false, error: 'イベント種別は 1〜32 文字で入力してください' }
  }
  // Normalizes toward the schema's `[A-Z0-9_]{1,32}` constraint (e.g. 'NFP REV' -> 'NFP_REV')
  // before the regex check below rejects whatever still doesn't fit.
  const kind = kindRaw.toUpperCase().replace(/\s+/g, '_')
  if (!/^[A-Z0-9_]{1,32}$/.test(kind)) {
    return {
      ok: false,
      error: 'イベント種別は半角英数とアンダースコアのみ使えます (例: FOMC / CPI / NFP)',
    }
  }
  const country = echo.country.trim()
  if (country.length > 16) {
    return { ok: false, error: '国は 16 文字以内にしてください' }
  }
  const date = echo.eventDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: '日付は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: '日付は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesPlain = echo.notes.trim()
  const combined =
    country.length > 0 && notesPlain.length > 0
      ? `${country} — ${notesPlain}`
      : country.length > 0
        ? country
        : notesPlain
  if (combined.length > 256) {
    return { ok: false, error: '国と備考の合計は 256 文字以内にしてください' }
  }
  return {
    ok: true,
    eventType: kind,
    eventDate: date,
    notes: combined.length === 0 ? null : combined,
  }
}

function isYmdRoundTrip(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === value
}

// Both `ymd` and `now` are floored to UTC-midnight epoch ms before the ±90d/±365d bound check.
// Padding either bound by one extra day of slack would let +91d/+366d through, so the bounds
// are compared as exact day-aligned ms, not with a fudge factor.
function withinClampRange(ymd: string, now: Date): boolean {
  const t = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(t)) return false
  const nowYmd = now.toISOString().slice(0, 10)
  const nowDayMs = Date.parse(`${nowYmd}T00:00:00.000Z`)
  const earliest = nowDayMs - 90 * 86_400_000
  const latest = nowDayMs + 365 * 86_400_000
  return t >= earliest && t <= latest
}

// Returns 400, not the PRG redirect's usual 303: an operator input error, not a server failure.
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

// Returns 200, not a redirect: the save already succeeded, this just surfaces a non-blocking
// warning (e.g. symbol outside the universe) instead of erroring it out.
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
  const earningsFormOpen = errors?.section === 'earnings' ? ' open' : ''
  const macroFormOpen = errors?.section === 'macro' ? ' open' : ''
  const eEcho = formEcho?.earnings ?? { symbol: '', earningsDate: '', notes: '' }
  const mEcho =
    formEcho?.macro ?? { eventType: '', country: '', eventDate: '', notes: '' }

  const earningsTable =
    earnings.length === 0
      ? '<p class="empty">この範囲には登録された決算がありません。</p>'
      : `<div class="tablewrap"><table>
    <thead><tr>
      <th>銘柄</th>
      <th>決算日</th>
      <th>備考</th>
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
          <td><form method="post" action="/dashboard/events/earnings/${r.id}/delete" onsubmit="return confirm('${esc(r.symbol)} ${esc(r.earningsDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" class="btn-sm danger">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table></div>`

  const macroTable =
    macros.length === 0
      ? '<p class="empty">この範囲には登録されたマクロイベントがありません。</p>'
      : `<div class="tablewrap"><table>
    <thead><tr>
      <th>イベント種別</th>
      <th>備考 (国)</th>
      <th>発生日</th>
      <th>操作</th>
    </tr></thead>
    <tbody>${macros
      .map((r) => {
        return `<tr>
          <td><code>${esc(r.eventType)}</code></td>
          <td>${esc(r.notes ?? '-')}</td>
          <td>${esc(r.eventDate)}</td>
          <td><form method="post" action="/dashboard/events/macro/${r.id}/delete" onsubmit="return confirm('${esc(r.eventType)} ${esc(r.eventDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" class="btn-sm danger">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table></div>`

  return `<style>${FIELD_STYLE}</style>
  <p class="muted" style="margin:0 0 12px">期間: ${esc(from)} 〜 ${esc(to)} (今日の前後30日)。登録した日付は判定処理の見送り判断に使われる。
  追加できる日付は過去90日から未来365日まで。削除は監査ログに記録される。</p>

  <div class="card">
    <div class="card-head"><h2 class="card-title">決算 (earnings)</h2></div>
    <div class="card-body">
      ${earningsErr}
      ${earningsNotice}
      <details${earningsFormOpen} style="margin-bottom:12px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">+ 追加</summary>
        <form method="post" action="/dashboard/events/earnings/seed" class="field-row" style="margin-top:10px">
          <div class="field"><label>銘柄</label><input name="symbol" value="${esc(eEcho.symbol)}" placeholder="AAPL / 7203" required maxlength="16" style="width:140px"></div>
          <div class="field"><label>決算日</label><input name="earnings_date" type="date" value="${esc(eEcho.earningsDate)}" required></div>
          <div class="field"><label>備考 (任意)</label><input name="notes" value="${esc(eEcho.notes)}" placeholder="Q2 2026 BMO" maxlength="256" style="min-width:240px"></div>
          <div class="field"><button type="submit" class="btn primary">追加</button></div>
        </form>
      </details>
      ${earningsTable}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2 class="card-title">マクロイベント (macro)</h2></div>
    <div class="card-body">
      ${macroErr}
      ${macroNotice}
      <details${macroFormOpen} style="margin-bottom:12px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">+ 追加</summary>
        <form method="post" action="/dashboard/events/macro/seed" class="field-row" style="margin-top:10px">
          <div class="field"><label>イベント種別</label><input name="event_type" value="${esc(mEcho.eventType)}" placeholder="FOMC / CPI / NFP" required maxlength="32" style="width:160px"></div>
          <div class="field"><label>国 (任意)</label><input name="country" value="${esc(mEcho.country)}" placeholder="US / JP" maxlength="16" style="width:100px"></div>
          <div class="field"><label>発生日</label><input name="event_date" type="date" value="${esc(mEcho.eventDate)}" required></div>
          <div class="field"><label>備考 (任意)</label><input name="notes" value="${esc(mEcho.notes)}" placeholder="June FOMC" maxlength="256" style="min-width:240px"></div>
          <div class="field"><button type="submit" class="btn primary">追加</button></div>
        </form>
      </details>
      ${macroTable}
    </div>
  </div>`
}

// extractActor throws when Access middleware hasn't set `actor` yet — caught here so a missing
// audit trail never turns into a 500 for the operator's actual form submission.
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
