import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog, tradeJournal } from '../../infrastructure/db/schema'
import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import { LOG_COPY_ALL_BTN, currencyOfSymbol, displaySymbol, esc, fmtJst, fmtNumber, fmtPct, fmtPctSigned, fmtPriceCcy, inactiveTooltip, isSymbolInactive, logCopyRowBtn, parseJsonObject, renderLogCopyScript, renderPaginationNav, safeJsonScript } from './shared'

/**
 * Strategy / sizing が出力する英語 reason を **初心者にも分かる日本語** に翻訳
 * する display helper。ログ DB は英語 canonical のまま、表示層でのみ翻訳
 * (tests / journal の契約に影響させない)。
 *
 * 統一テンプレ: `[判定ラベル]: [事実] ([具体値])`
 *
 * 判定ラベル (10 種):
 *   - 保有前の評価系 4 種: 様子見 / 買い / 発注中 / データ不足
 *   - 保有中の exit 系 4 種: 利食い / 損切り / 時間切れ / 保有継続
 *   - 発注不成立系 2 種: 発注スキップ (pre-submit) / 発注失敗 (broker submit 失敗)
 *
 * `発注スキップ` は sizing / 同グループ建玉上限 / 売買単位未満などで
 * **注文送出前** に止めた場合 (decision=SKIP)。`発注失敗` は broker に送ったが
 * 成立しなかった場合 (broker submit error) — 確定拒否 (REJECT) か一時的失敗
 * (ERROR) かは decision 列が区別する。
 *
 * trading-strategist review に基づき、日本株・信用取引の伝統語 (押し目 /
 * 含み損益 / 建玉 / 単元 / 移動平均線割れ / 日柄 / 手仕舞い / 騰落率 / ロスカット
 * 派生の損切りライン) と証券アプリ準拠の英字 (SMA50, ATR) を混在。
 */
export function localizeReason(en: string | null | undefined): string {
  if (!en) return '-'
  let s = en

  // === 発注中 / 取引停止 (entry 前ガード) ===
  s = s.replace(/^pending order in flight$/, '発注中: 直前注文の約定待ち')
  // cooldown の timestamp は UTC ISO で emit されるが operator 向けには JST 表記が
  // 読みやすい。fmtJst は parse 失敗時に原文字列を返すので安全 (CodeRabbit)。
  s = s.replace(
    /^cooldown active until (.+)$/,
    (_m, ts) => `様子見: 取引停止中 (${fmtJst(ts)} まで)`,
  )
  s = s.replace(/^pending order already in flight$/, '発注中: 同銘柄の注文処理中')

  // === 保有中の exit 判定 ===
  // 「含み益/含み損」= 未実現損益の日本株標準語。strategy.ts の pnlPct は
  // (現値 - 取得価格)/取得価格 で未実現なのでこちらを採用。
  s = s.replace(
    /^take-profit hit: pnl (\S+) >= (\S+)$/,
    (_m, p, t) => `利食い: 利確目標到達 (含み損益 ${fmtPct(p)} ≥ 目標 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^stop-loss hit: pnl (\S+) <= (\S+)$/,
    (_m, p, t) => `損切り: 損切りライン到達 (含み損益 ${fmtPct(p)} ≤ ライン ${fmtPct(t)})`,
  )
  s = s.replace(
    /^time-stop hit: held (\S+) >= (\S+)$/,
    '時間切れ: 保有期限到達 (保有 $1 ≥ 上限 $2)',
  )
  s = s.replace(
    /^holding: pnl (\S+) within \(([^,]+),\s*([^)]+)\)$/,
    (_m, p, low, high) =>
      `保有継続: 含み損益 ${fmtPct(p)} (利食い ${fmtPct(high)} / 損切り ${fmtPct(low)} の範囲内)`,
  )

  // === 未保有の entry 判定 (様子見) ===
  // 「移動平均線割れ」は日本株の慣用表現。
  // #318: trend filter の reason は `20d return ...`、historical decision_log
  // 行は `50d return ...` (#318 前) を含むので両方を受ける。
  s = s.replace(
    /^(?:20d|50d) return (\S+) <= (\S+) trend threshold$/,
    (_m, r, t) =>
      `様子見: 上昇トレンド未成立 (騰落率 ${fmtPct(r)} ≤ 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^price (\S+) <= sma50 (\S+)$/,
    '様子見: 50日移動平均線割れ (株価 $1 ≤ 移動平均 $2)',
  )
  // #318: invalid high reason も新旧両形式を受ける。
  s = s.replace(/^invalid (?:10d|20d) high$/, 'データ不足: 直近高値を算出できず')
  s = s.replace(
    /^pullback (\S+) > (\S+) \(not deep enough\)$/,
    (_m, p, t) => `様子見: 押し目が浅い (下落率 ${fmtPct(p)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^pullback (\S+) < (\S+) \(too deep\)$/,
    (_m, p, t) =>
      `様子見: 押し目が深すぎる/下落転換懸念 (下落率 ${fmtPct(p)} < 許容 ${fmtPct(t)})`,
  )
  // #strategy-overextension-guards: 過熱 / ボラ過熱 ガード。
  s = s.replace(
    /^sma50 deviation (\S+) > (\S+) \(overextended\)$/,
    (_m, d, t) => `様子見: 過熱 (移動平均からの上方乖離 ${fmtPct(d)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^atr ratio (\S+) > (\S+) \(volatility elevated\)$/,
    (_m, r, t) => `様子見: ボラ過熱 (ATR比 ${r}倍 > 条件 ${t}倍)`,
  )

  // === BUY signal (押し目買い成立) ===
  // #318: BUY reason は `20d return ...`、historical 行 (`50d return ...`) も受ける。
  s = s.replace(
    /^pullback (\S+) in uptrend \((?:20d|50d) return (\S+)\)$/,
    (_m, p, r) =>
      `買い: 上昇トレンド中の押し目買い (下落率 ${fmtPct(p)}、騰落率 ${fmtPct(r)})`,
  )

  // === Sizing 系 (買付余力不足で発注見送り) ===
  s = s.replace(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
    '買付余力不足: 売買単位未満 ($1 株 < 1単元 $2 株、株価 $4)',
  )
  s = s.replace(
    /^sizing rejected: insufficient-risk-budget \(budget (\S+)\)$/,
    '買付余力不足: リスク予算残 $1',
  )
  s = s.replace(/^sizing rejected: atr-floor$/, '発注見送り: ボラティリティ低下 (ATR 下限割れ)')
  s = s.replace(/^sizing rejected: symbol-cap$/, '発注見送り: 銘柄別投資上限超過')
  s = s.replace(
    /^sizing rejected: invalid-stop \(stopDistance (\S+)\)$/,
    '発注見送り: 損切り幅が算出不能 ($1)',
  )
  s = s.replace(/^sizing rejected: zero qty$/, '買付余力不足: 1株分の余力なし')

  // === Per-symbol risk gate: spread guard (#547) ===
  // spread reject は臨時休場 (session gate をルールで書けない閉場) のバック
  // ストップを兼ねる。鮮度 suffix があれば「板が古い = 休場・閉場中の可能性」を
  // 明示する。suffix なし (旧形式 / asOf 欠落) は従来通り数値のみ。
  s = s.replace(
    /^spread ([\d.]+)% exceeds (US|JP) limit ([\d.]+)%(?: \(quote asOf ([^,]+), ([\d.]+)h stale\))?$/,
    (_m, pct, mkt, lim, asOf, hours) =>
      `発注スキップ: 気配スプレッド過大 (${pct}% > ${mkt} 上限 ${lim}%${
        asOf ? `、板情報は ${fmtJst(asOf)} 時点 / ${hours}時間前 — 休場・閉場中の可能性` : ''
      })`,
  )

  // === Scheduler inline ===
  s = s.replace(/^SELL without position$/, '発注スキップ: 手仕舞い対象の建玉なし')
  s = s.replace(/^insufficient bars for indicators$/, 'データ不足: 指標計算に必要な日柄不足')
  s = s.replace(/^invalid price: (\S+)$/, 'データ不足: 株価が無効 ($1)')
  s = s.replace(/^invalid notional:/, 'データ不足: 発注金額が無効:')
  s = s.replace(/^invalid position qty: (\S+)$/, 'データ不足: 建玉数が無効 ($1)')
  s = s.replace(/^invalid expiresAt/, 'データ不足: 注文有効期限が無効')
  s = s.replace(/^bar fetch: /, 'データ不足: 日足取得失敗 — ')
  s = s.replace(/^broker submit error: /, '発注失敗: 証券会社への発注が成立せず — ')

  return s
}

/** 戦略判定 1 行 (decision log + journal post_submit JOIN、#143)。 */
export interface DecisionRow {
  id: number
  timestamp: string
  requestId: string | null
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson: string | null
  clientOrderId: string | null
  traceJson: string | null
  filledPrice: number | null
  filledQty: number | null
  realizedPnl: number | null
  brokerStatus: string | null
}

/**
 * strategy_decision_log を trade_journal の post_submit と LEFT JOIN して
 * 実 fill / realized_pnl 付きで取る (#143)。戦略判定ページとチャート銘柄タブの
 * 判定履歴 (#decisions-chart-unify) が共用する — 同じ判定が 2 画面で違う形に
 * ならないよう、ローダーはここ 1 本に寄せる。
 */
export async function loadDecisionRows(
  db: ReturnType<typeof createDb>,
  opts: { symbol?: string; clientOrderId?: string; limit: number; before?: number },
): Promise<DecisionRow[]> {
  const baseQuery = db
    .select({
      id: strategyDecisionLog.id,
      timestamp: strategyDecisionLog.timestamp,
      requestId: strategyDecisionLog.requestId,
      symbol: strategyDecisionLog.symbol,
      decision: strategyDecisionLog.decision,
      reason: strategyDecisionLog.reason,
      price: strategyDecisionLog.price,
      indicatorsJson: strategyDecisionLog.indicatorsJson,
      clientOrderId: strategyDecisionLog.clientOrderId,
      traceJson: strategyDecisionLog.traceJson,
      filledPrice: tradeJournal.filledPrice,
      filledQty: tradeJournal.filledQty,
      realizedPnl: tradeJournal.realizedPnl,
      brokerStatus: tradeJournal.brokerStatus,
    })
    .from(strategyDecisionLog)
    .leftJoin(
      tradeJournal,
      and(
        eq(strategyDecisionLog.clientOrderId, tradeJournal.clientOrderId),
        eq(tradeJournal.tradeEventType, 'post_submit'),
      ),
    )
  const conditions: SQL[] = []
  if (opts.symbol) conditions.push(eq(strategyDecisionLog.symbol, opts.symbol))
  // trades の「判定→」逆リンク用 (#nav-links)。coid index 済 (schema)。
  if (opts.clientOrderId) conditions.push(eq(strategyDecisionLog.clientOrderId, opts.clientOrderId))
  if (opts.before !== undefined) conditions.push(lt(strategyDecisionLog.id, opts.before))
  const q = conditions.length > 0
    ? baseQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : baseQuery
  return q.orderBy(desc(strategyDecisionLog.id)).limit(opts.limit)
}

/**
 * 戦略判定ページの銘柄レール (#decisions-chart-unify)。チャート銘柄タブの
 * レールと同じ見た目 (CSS 共用) で、先頭に「ALL (全銘柄)」を置く。
 * limit は URL に伝搬する。
 */
export function renderCronSymbolRail(
  universe: SymbolUniverse | null | undefined,
  activeSymbol: string | undefined,
  limit: number,
): string {
  const symbols = universe ? [...universe.allowedSymbols, ...universe.inactiveSymbols] : []
  if (symbols.length === 0) return ''
  const limitQs = `&limit=${limit}`
  const allItem = `<a class="rail-item${activeSymbol === undefined ? ' active' : ''}" href="/dashboard/cron?${limitQs.slice(1)}">
    <span class="rail-sym">ALL</span><span class="rail-name">全銘柄</span>
  </a>`
  const items = symbols
    .map((sym) => {
      const inactive = isSymbolInactive(sym, universe)
      const isFocus = sym === activeSymbol
      const name = universe?.symbolName[sym.toUpperCase()] ?? ''
      const cls = ['rail-item', isFocus ? 'active' : '', inactive ? 'inactive' : '']
        .filter(Boolean)
        .join(' ')
      const titleAttr = inactive
        ? ` title="${esc(inactiveTooltip(sym, universe))}"`
        : name
          ? ` title="${esc(name)}"`
          : ''
      return `<a class="${cls}" href="/dashboard/cron?symbol=${encodeURIComponent(sym)}${limitQs}"${titleAttr}>
        <span class="rail-sym">${esc(sym)}</span>${name ? `<span class="rail-name">${esc(name)}</span>` : ''}
      </a>`
    })
    .join('')
  return `<aside class="symbol-rail"><div class="rail-head">銘柄</div>${allItem}${items}</aside>`
}

export function cronBody(
  rows: DecisionRow[],
  limit: number,
  symbolFilter: string | undefined,
  universe?: SymbolUniverse | null,
  before?: number,
  hasMore = false,
  clientOrderIdFilter?: string,
): string {
  const copyAllBtn = rows.length > 0 ? LOG_COPY_ALL_BTN : ''
  const baseHref = clientOrderIdFilter
    ? `/dashboard/cron?clientOrderId=${encodeURIComponent(clientOrderIdFilter)}&limit=${limit}`
    : symbolFilter
      ? `/dashboard/cron?symbol=${encodeURIComponent(symbolFilter)}&limit=${limit}`
      : `/dashboard/cron?limit=${limit}`
  const header = clientOrderIdFilter
    ? `<p class="muted">注文 <code>${esc(clientOrderIdFilter)}</code> の判定のみ表示。<a href="/dashboard/trades?clientOrderId=${encodeURIComponent(clientOrderIdFilter)}">約定を見る</a> / <a href="/dashboard/cron">全件へ戻る</a> ${copyAllBtn}</p>`
    : symbolFilter
      ? `<p class="muted">Showing ${rows.length} decisions for <strong>${esc(displaySymbol(symbolFilter, universe))}</strong>。<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbolFilter)}">チャートで見る</a> / <a href="/dashboard/trades?symbol=${encodeURIComponent(symbolFilter)}">約定を見る</a> / <a href="/dashboard/cron">全銘柄へ戻る</a> / <a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a> ${copyAllBtn}</p>`
      : `<p class="muted">Showing ${rows.length} decisions。<code>?symbol=SOXL</code> で絞り込み可能。<a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a> ${copyAllBtn}</p>`
  const pagination = renderPaginationNav({
    baseHref,
    before,
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore,
  })
  const rail = renderCronSymbolRail(universe, symbolFilter, limit)
  const main =
    rows.length === 0
      ? `${header}<p class="muted">判定ログがまだありません。</p>${pagination}`
      : `${header}
  ${renderDecisionTable(rows, universe, {
    copyVarName: '__cronCopy',
    showSymbol: true,
    filterLabel: `symbol=${symbolFilter ?? 'all'}${clientOrderIdFilter ? `, clientOrderId=${clientOrderIdFilter}` : ''}, limit=${limit}`,
  })}${pagination}`
  return rail ? `<div class="symbol-layout">${rail}<div class="symbol-main">${main}</div></div>` : main
}

/**
 * 戦略判定テーブル (#decisions-chart-unify)。戦略判定ページ (全銘柄) と
 * チャート銘柄タブの判定履歴が共用する。reason の判定ラダー・AI 用コピー
 * (行 = trace 含む完全版 / 全件 = trace 省略) を内包する。
 */
export function renderDecisionTable(
  rows: DecisionRow[],
  universe: SymbolUniverse | null | undefined,
  opts: { copyVarName: string; showSymbol: boolean; filterLabel: string },
): string {
  const tbody = rows
    .map((r) => {
      const cls =
        r.decision === 'BUY'
          ? 'ok'
          : r.decision === 'SELL'
            ? 'warn'
            : r.decision === 'ERROR' || r.decision === 'REJECT'
              ? 'err'
              : r.decision === 'SKIP'
                ? 'warn'
                : 'muted'
      // 実 fill 結果 (trade_journal post_submit から JOIN、#143)
      // realized_pnl は主に SELL で非 null (利確/損切のドル額)。BUY の realized は null。
      const realizedCell =
        r.realizedPnl === null || r.realizedPnl === undefined
          ? '-'
          : formatRealizedPnl(r.realizedPnl)
      // fill があるときは clientOrderId で trades の該当注文 (lifecycle 全行) へ
      // 飛べるようにする (#nav-links)。
      const fillText =
        r.filledPrice === null || r.filledPrice === undefined
          ? '-'
          : `${fmtNumber(r.filledPrice, 2)} × ${r.filledQty ?? '?'}`
      const fillCell =
        fillText !== '-' && r.clientOrderId
          ? `<a href="/dashboard/trades?clientOrderId=${encodeURIComponent(r.clientOrderId)}" title="この注文の約定履歴を見る">${esc(fillText)}</a>`
          : esc(fillText)
      const inactive = isSymbolInactive(r.symbol, universe)
      const symbolClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(r.symbol, universe))}"` : ''
      // 銘柄リンクはチャート銘柄タブへ (判定 pin / ラダー / 入場距離と同じ文脈で
      // 見られる)。cron 内絞り込みは ▼ で残す。
      const symbolCell = opts.showSymbol
        ? `<td><a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}"${titleAttr}><strong><span${symbolClass}>${esc(displaySymbol(r.symbol, universe))}</span></strong></a> <a href="/dashboard/cron?symbol=${encodeURIComponent(r.symbol)}" class="muted" title="この銘柄の判定だけに絞り込み" style="font-size:11px;text-decoration:none">▼</a></td>`
        : ''
      return `<tr>
        <td>${logCopyRowBtn(r.id)}</td>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        ${symbolCell}
        <td class="${cls}">${esc(r.decision)}</td>
        <td>${cronReasonCell(r)}</td>
        <td>${r.price === null ? '-' : fmtNumber(r.price, 2)}</td>
        <td class="muted">${fillCell}</td>
        <td>${realizedCell}</td>
      </tr>`
    })
    .join('')
  return `<table>
    <thead><tr>
      <th></th><th>timestamp (JST)</th>${opts.showSymbol ? '<th>symbol</th>' : ''}<th>decision</th><th>reason (評価時の含み損益など)</th><th>price</th><th>実 fill (価格 × 数量)</th><th>実 損益</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  ${safeJsonScript(opts.copyVarName, {
    meta: {
      page: 'strategy_decision_log (戦略判定)',
      filter: `${opts.filterLabel} (copy-all は trace 省略、行コピーは trace 含む)`,
      generatedAt: new Date().toISOString(),
    },
    // copy-all 用は trace を省略 (200 行 × 判定ラダーで肥大するため)。
    rows: rows.map((r) => ({ ...cronDecisionJson(r), requestId: r.requestId })),
    // 行コピー用の完全版 (trace 含む) — AI への単発相談はこちらが本命。
    full: rows.map((r) => ({
      ...cronDecisionJson(r),
      requestId: r.requestId,
      trace: parseJsonObject(r.traceJson ?? null),
    })),
  })}
  ${renderLogCopyScript(opts.copyVarName)}`
}

export function cronReasonCell(row: {
  id: number
  timestamp: string
  requestId: string | null
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  traceJson?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}): string {
  const localized = localizeReason(row.reason)
  const rawReason = row.reason ?? '-'
  const decisionJson = JSON.stringify(cronDecisionJson(row), null, 2)
  const humanDetails = describeCronReason(row.reason)
  const ladder = renderDecisionLadder(
    row.traceJson ?? null,
    row.decision,
    localized || rawReason,
    currencyOfSymbol(row.symbol),
  )

  return `<details class="reason-details">
    <summary>${esc(localized || '-')}</summary>
    <div class="reason-panel">
      ${ladder}
      <div><strong>読み方</strong>${humanDetails}</div>
      <div><strong>RUNID</strong><br><code>${esc(row.requestId ?? '-')}</code></div>
      <div><strong>raw reason</strong><br><code>${esc(rawReason)}</code></div>
      <div><strong>decision id / clientOrderId</strong><br><code>${row.id}</code> / ${row.clientOrderId ? `<a href="/dashboard/trades?clientOrderId=${encodeURIComponent(row.clientOrderId)}" title="この注文の約定履歴を見る"><code>${esc(row.clientOrderId)}</code></a>` : '<code>-</code>'}</div>
      <div><strong>JSON</strong><br><pre>${esc(decisionJson)}</pre></div>
    </div>
  </details>`
}

// trace 識別子 → 左辺 (変数) の表示名 + 単位、必要なら右辺 (閾値) の名前。
// 左の値が「何の数字か」を明示するため (#trace-readability)。識別子は
// decision_log 互換で英語据え置き、ここで表示名と単位を与える。
export const TRACE_OPERAND: Record<string, { name: string; unit: 'price' | 'pct' | 'mult' | 'days'; thr?: string }> = {
  'entry.trend_50d_return': { name: '20日騰落率', unit: 'pct' },
  'entry.trend_20d_return': { name: '20日騰落率', unit: 'pct' },
  'entry.above_sma50': { name: '株価', unit: 'price', thr: 'SMA50' },
  'entry.not_overextended': { name: '移動平均乖離率', unit: 'pct' },
  'entry.not_blowoff': { name: 'SMA50乖離率', unit: 'pct' },
  'entry.vol_not_elevated': { name: 'ATR倍率', unit: 'mult' },
  'entry.high20d_valid': { name: '直近10日高値', unit: 'price' },
  'entry.breakout_high_valid': { name: '直近20日高値', unit: 'price' },
  'entry.breakout': { name: '株価', unit: 'price', thr: 'ブレイク水準' },
  'entry.pullback_not_too_shallow': { name: '押し目率', unit: 'pct' },
  'entry.pullback_not_too_deep': { name: '押し目率', unit: 'pct' },
  'exit.take_profit': { name: '損益率', unit: 'pct' },
  'exit.stop_loss': { name: '損益率', unit: 'pct' },
  'exit.time_stop': { name: '保有日数', unit: 'days' },
}

/**
 * 判定トレース (`DecisionTraceStep[]` JSON) を「入力→ロジック層→出力」のラダーに
 * 描画する (#decision-trace)。各 gate を順に ✅/❌ + 比較式 (左辺名 値 op 閾値) で
 * 並べ、最後のステップ(=分岐を確定させた層)に ◀ を付けて下の出力ボックスへ矢印で繋ぐ。
 * `currency` は価格系の値に $/¥ を付けるために使う (null なら記号なし)。
 * trace 未保存 (migration 前 / 一部経路) は空文字 (既存表示のまま)。
 */
export function renderDecisionLadder(
  traceJson: string | null,
  decision: string,
  outputReason: string,
  currency: string | null = null,
): string {
  if (!traceJson) return ''
  let steps: Array<{
    label?: string
    label_ja?: string
    passed?: boolean
    actual?: unknown
    operator?: string
    threshold?: unknown
    message?: string
  }>
  try {
    const parsed = JSON.parse(traceJson)
    if (!Array.isArray(parsed) || parsed.length === 0) return ''
    steps = parsed
  } catch {
    return ''
  }
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) return `[${v.map((x) => fmt(x)).join(', ')}]`
    if (typeof v === 'number') return String(Math.round(v * 10000) / 10000)
    return String(v)
  }
  const opSymbol: Record<string, string> = {
    '>': '>', '>=': '≥', '<': '<', '<=': '≤', '==': '=', '!=': '≠',
    between: '∈', exists: '', not_exists: '',
  }
  // 単位ごとに値を整形。price は通貨記号 ($/¥) 付き。
  const fmtVal = (v: number, unit: 'price' | 'pct' | 'mult' | 'days'): string => {
    switch (unit) {
      case 'price':
        return fmtPriceCcy(v, currency)
      case 'pct':
        return fmtPctSigned(v)
      case 'mult':
        return `${v.toFixed(2)}×`
      case 'days':
        return `${Math.round(v)}日`
    }
  }
  const lastIdx = steps.length - 1
  const rows = steps
    .map((s, i) => {
      const ok = s.passed === true
      const mark = ok ? '✅' : '❌'
      const label = esc(s.label_ja || s.label || '?')
      // 「<左辺名> <値>(太字) <記号> [<閾値名>] <閾値>」で、左が何の数字かを明示
      // する (#trace-readability)。識別子に表示名が無い step は素の比較式。
      const opSym = s.operator ? (opSymbol[s.operator] ?? s.operator) : ''
      const meta = s.label ? TRACE_OPERAND[s.label] : undefined
      let cmp = ''
      if (s.actual !== undefined || s.threshold !== undefined) {
        if (meta && typeof s.actual === 'number') {
          const aStr = fmtVal(s.actual, meta.unit)
          const tStr = typeof s.threshold === 'number' ? fmtVal(s.threshold, meta.unit) : fmt(s.threshold)
          const thrName = meta.thr ? `${meta.thr} ` : ''
          cmp = `<span class="tl-cmp">${esc(meta.name)} <b>${esc(aStr)}</b>${opSym ? ` ${esc(opSym)}` : ''}${tStr !== '' ? ` ${esc(thrName)}${esc(tStr)}` : ''}</span>`
        } else {
          const aStr = fmt(s.actual)
          const tStr = fmt(s.threshold)
          cmp = `<span class="tl-cmp">${aStr !== '' ? `<b>${esc(aStr)}</b>` : ''}${opSym ? ` ${esc(opSym)} ` : ' '}${esc(tStr)}</span>`
        }
      }
      const msg = s.message ? `<span class="tl-msg">${esc(s.message)}</span>` : ''
      const decisive = i === lastIdx ? ' tl-decisive' : ''
      const arrow = i === lastIdx ? '<span class="tl-pick">◀ 採用</span>' : ''
      return `<div class="tl-step ${ok ? 'tl-ok' : 'tl-fail'}${decisive}"><span class="tl-mark">${mark}</span><span class="tl-label">${label}</span>${cmp}${msg}${arrow}</div>`
    })
    .join('')
  const decUpper = (decision || '').toUpperCase()
  return `<div><strong>判定トレース</strong>
    <div class="trace-ladder">
      ${rows}
      <div class="tl-arrow">▼</div>
      <div class="tl-output tl-out-${esc(decUpper.toLowerCase())}">出力: <strong>${esc(decUpper)}</strong> — ${esc(outputReason)}</div>
    </div>
  </div>`
}

/**
 * チャート判定点クリック時に脇パネルへ挿す HTML を作る (#decision-trace の
 * グラフ同期)。trace があれば `renderDecisionLadder` をそのまま使い、無ければ
 * (migration 前 / 一部経路) 出力ボックスだけの最小フォールバックを返す。
 * チャート側 JS は単に innerHTML へ挿すだけにして、ラダー描画ロジックの
 * 二重化 (JS 側複製) を避け、ラダー表現の真実源を server に一本化する。
 */
export function renderChartDecisionTrace(
  traceJson: string | null,
  decision: string,
  reason: string | null,
  currency: string | null = null,
): string {
  const outputReason = localizeReason(reason) || (reason ?? '-')
  const ladder = renderDecisionLadder(traceJson, decision, outputReason, currency)
  if (ladder) return ladder
  const decUpper = (decision || '').toUpperCase()
  return `<div><strong>判定トレース</strong>
    <div class="trace-ladder">
      <p class="muted" style="margin:4px 0;font-size:12px">この判定にはトレースが保存されていません (旧ログ)。</p>
      <div class="tl-output tl-out-${esc(decUpper.toLowerCase())}">出力: <strong>${esc(decUpper)}</strong> — ${esc(outputReason)}</div>
    </div>
  </div>`
}

export function cronDecisionJson(row: {
  id: number
  timestamp: string
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    symbol: row.symbol,
    decision: row.decision,
    reason: row.reason,
    localizedReason: localizeReason(row.reason),
    price: row.price,
    indicators: parseJsonObject(row.indicatorsJson),
    clientOrderId: row.clientOrderId,
    broker: {
      status: row.brokerStatus,
      filledPrice: row.filledPrice,
      filledQty: row.filledQty,
      realizedPnl: row.realizedPnl,
    },
  }
}

export function describeCronReason(reason: string | null | undefined): string {
  if (!reason) return '<p class="muted">詳細理由なし</p>'

  const lotSizeRound = reason.match(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
  )
  if (lotSizeRound) {
    const [, rawQty, lot, stop, entry] = lotSizeRound
    return `<ul>
      <li>計算上は ${esc(rawQty)} 株まで建てられるが、必要な売買単位 ${esc(lot)} 株に届かないため発注しません。</li>
      <li>評価時の株価は ${esc(entry)}、損切り幅は ${esc(stop)} / 株です。</li>
      <li>このままだと単元未満なので、リスク予算・銘柄上限・売買単位のいずれかが変わらない限り発注されません。</li>
    </ul>`
  }

  return `<p>${esc(localizeReason(reason))}</p>`
}

/**
 * realized_pnl ($ / ¥ raw 値) を符号付き小数 2 桁で。loss は赤、profit は緑。
 */
export function formatRealizedPnl(value: number): string {
  const sign = value > 0 ? '+' : ''
  const cls = value > 0 ? 'ok' : value < 0 ? 'err' : 'muted'
  return `<span class="${cls}">${sign}${value.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
}
