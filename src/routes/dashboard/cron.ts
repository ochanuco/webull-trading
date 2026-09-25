import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog, tradeJournal } from '../../infrastructure/db/schema'
import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm'
import { LOG_COPY_ALL_BTN, clampLimit, currencyOfSymbol, displaySymbol, esc, fmtJst, fmtNumber, fmtPct, fmtPctSigned, fmtPriceCcy, inactiveTooltip, isSymbolInactive, logCopyRowBtn, parseJsonObject, renderLogCopyScript, renderPaginationNav, safeJsonScript } from './shared'
// charts/shared imports `type { DecisionRow }` back from this file, but
// type-only, so this import doesn't create a runtime circular dependency.
import { ECHARTS_CDN } from './charts/shared'
// A skipped (closed-market) tick never writes a strategy_decision_log row,
// so the matrix distinguishes "closed" from "no decision" by calendar here
// at render time rather than at write time.
import { inferTradingMarket, isWithinStrategyWindow } from '../../trading/domain/tradingCalendar'

// Translates strategy/sizing's canonical English reason strings for display
// only — the DB and journal keep the English form untouched.
export function localizeReason(en: string | null | undefined): string {
  if (!en) return '-'
  let s = en

  // === 発注中 / 取引停止 (entry 前ガード) ===
  s = s.replace(/^pending order in flight$/, '発注中: 直前注文の約定待ち')
  s = s.replace(
    /^cooldown active until (.+)$/,
    (_m, ts) => `様子見: 取引停止中 (${fmtJst(ts)} まで)`,
  )
  s = s.replace(/^pending order already in flight$/, '発注中: 同銘柄の注文処理中')

  // === 保有中の exit 判定 ===
  s = s.replace(
    /^take-profit hit: pnl (\S+) >= (\S+)$/,
    (_m, p, t) => `利食い: 利確目標到達 (含み損益 ${fmtPct(p)} ≥ 目標 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^stop-loss hit: pnl (\S+) <= (\S+)(?:\s+\(.*\))?$/,
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
  s = s.replace(
    /^(?:20d|50d) return (\S+) <= (\S+) trend threshold$/,
    (_m, r, t) =>
      `様子見: 上昇トレンド未成立 (騰落率 ${fmtPct(r)} ≤ 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^price (\S+) <= sma50 (\S+)$/,
    '様子見: 50日移動平均線割れ (株価 $1 ≤ 移動平均 $2)',
  )
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
  s = s.replace(
    /^sma50 deviation (\S+) > (\S+) \(overextended\)$/,
    (_m, d, t) => `様子見: 過熱 (移動平均からの上方乖離 ${fmtPct(d)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^atr ratio (\S+) > (\S+) \(volatility elevated\)$/,
    (_m, r, t) => `様子見: ボラ過熱 (ATR比 ${r}倍 > 条件 ${t}倍)`,
  )

  // === BUY signal (押し目買い成立) ===
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
  s = s.replace(
    /^sizing rejected: capital-unset \(set total_capital_usd \/ total_capital_jpy for risk-% sizing\)$/,
    '発注見送り: 総資産未設定 (risk-% sizing には total_capital_usd / total_capital_jpy の設定が必要)',
  )

  // === Portfolio 全体エクスポージャー上限 ===
  s = s.replace(
    /^risk: portfolio exposure cap unavailable \((.+)\)$/,
    (_m, reason) => `発注スキップ: 建玉上限データ取得不可 (${reason})`,
  )
  s = s.replace(
    /^risk: portfolio exposure cap \(notionalJpy (\S+) > remaining (\S+) of ceiling (\S+)\)$/,
    (_m, notional, remaining, ceiling) =>
      `発注スキップ: 建玉上限超過 (発注金額 ${notional}円 > 残枠 ${remaining}円 / 上限 ${ceiling}円)`,
  )

  // === 価格鮮度ゲート (BUY のみ) ===
  s = s.replace(
    /^stale price: intraday bar unavailable, daily close fallback not accepted for BUY$/,
    '発注スキップ: 価格データ不足 (直近1時間足が取得できず、日足終値での代用は不可)',
  )
  s = s.replace(
    /^stale price: intraday_60m as of (.+) exceeds (\d+)ms$/,
    (_m, ts, maxAgeMs) => `発注スキップ: 価格データが古い (1時間足時点 ${fmtJst(ts)} が許容 ${maxAgeMs}ms を超過)`,
  )

  // === Per-symbol risk gate: spread guard ===
  // Spread reject doubles as a backstop for an unscheduled closure the
  // session gate can't rule-check; the staleness suffix (when present)
  // surfaces that possibility instead of showing a bare percentage.
  s = s.replace(
    /^spread ([\d.]+)% exceeds (US|JP) limit ([\d.]+)%(?: \(quote asOf ([^,]+), ([\d.]+)h stale\))?$/,
    (_m, pct, mkt, lim, asOf, hours) =>
      `発注スキップ: 気配スプレッド過大 (${pct}% > ${mkt} 上限 ${lim}%${
        asOf ? `、板情報は ${fmtJst(asOf)} 時点 / ${hours}時間前 — 休場・閉場中の可能性` : ''
      })`,
  )

  // === News shock gate (risk: news_shock_*) ===
  // Only 2 of these paths reach decision.reason under the default
  // fail_open policy: critical, and warning when lot-rounding zeroes the
  // qty. A warning that merely scales qty down leaves the normal BUY
  // reason in place. unavailable/insufficient_baseline only reject when
  // attention_stale_policy='block_buy'.
  s = s.replace(
    /^risk: news_shock_critical: ([\d.]+)x(?: tone-([\d.]+))?\s*\(block\)$/,
    (_m, ratio, tone) =>
      `発注スキップ: ニュース過熱で緊急停止 (報道量 baseline比 ${ratio}倍${tone ? `、論調悪化 ${tone}` : ''})`,
  )
  s = s.replace(
    /^risk: news_shock_warning: ([\d.]+)x \(size x([\d.]+)\)(?: \(qty rounded to 0, lot=(\d+)\))?$/,
    (_m, ratio, scale, lot) =>
      `発注スキップ: ニュース過熱で発注数量縮小 (報道量 baseline比 ${ratio}倍、数量 x${scale}${lot ? `、売買単位 ${lot} 未満で見送り` : ''})`,
  )
  s = s.replace(
    /^risk: news_shock_unavailable_fallback_normal$/,
    '発注スキップ: ニュース観測データ不足 (block_buy 設定により新規買い停止)',
  )
  s = s.replace(
    /^risk: news_shock_insufficient_baseline: (\d+)\/(\d+)$/,
    (_m, count, min) =>
      `発注スキップ: ニュース baseline サンプル不足 (${count}/${min}件、block_buy 設定により新規買い停止)`,
  )
  s = s.replace(
    /^risk: news_shock_degenerate_baseline: all-zero$/,
    '発注スキップ: ニュース baseline が全点ゼロ (block_buy 設定により新規買い停止)',
  )

  // === Scheduler inline ===
  s = s.replace(/^SELL without position$/, '発注スキップ: 手仕舞い対象の保有なし')
  s = s.replace(/^insufficient bars for indicators$/, 'データ不足: 指標計算に必要な日柄不足')
  s = s.replace(/^invalid price: (\S+)$/, 'データ不足: 株価が無効 ($1)')
  s = s.replace(/^invalid notional:/, 'データ不足: 発注金額が無効:')
  s = s.replace(/^invalid position qty: (\S+)$/, 'データ不足: 保有数量が無効 ($1)')
  s = s.replace(/^invalid expiresAt/, 'データ不足: 注文有効期限が無効')
  s = s.replace(/^bar fetch: /, 'データ不足: 日足取得失敗 — ')
  s = s.replace(/^broker submit error: /, '発注失敗: 証券会社への発注が成立せず — ')
  // Prefix-only, same pattern as bar fetch:/broker submit error: above — the
  // trailing reason is translated by whichever rule matches it next.
  s = s.replace(
    /^exit evaluation unavailable while holding (\S+): /,
    'データ不足: 保有中の手仕舞い判定不能 (保有 $1 株) — ',
  )

  // === Session / lifecycle ガード ===
  s = s.replace(
    /^outside regular session: BUY deferred \(exits still evaluated\)$/,
    '様子見: 通常取引時間外のため新規買い見送り (手仕舞いは継続評価)',
  )
  s = s.replace(
    /^symbol inactive: exit-only$/,
    '様子見: 銘柄無効化済み (保有分の手仕舞いのみ実施)',
  )
  s = s.replace(
    /^intraday-only: no new entry within 30min of US close$/,
    '様子見: 引け30分前のため新規エントリー見送り (オーバーナイト回避)',
  )

  return s
}

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

// Shared by the strategy-decisions page and the chart symbol tab so the
// same decision never renders differently on the two screens.
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
  if (opts.clientOrderId) conditions.push(eq(strategyDecisionLog.clientOrderId, opts.clientOrderId))
  if (opts.before !== undefined) conditions.push(lt(strategyDecisionLog.id, opts.before))
  const q = conditions.length > 0
    ? baseQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : baseQuery
  return q.orderBy(desc(strategyDecisionLog.id)).limit(opts.limit)
}

// Shares CSS with the chart symbol tab's rail; prepends "ALL" ahead of it.
function renderCronSymbolRail(
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

// `?symbol=` carries across the list/matrix toggle so returning to the
// list keeps the filter, even though matrix itself ignores it.
function renderCronViewPills(
  active: 'list' | 'matrix',
  limit: number,
  symbolFilter?: string,
): string {
  const symbolQs = symbolFilter ? `&symbol=${encodeURIComponent(symbolFilter)}` : ''
  const pill = (label: string, href: string, isActive: boolean): string =>
    `<a href="${href}" class="chip${isActive ? ' active' : ''}" style="margin-right:6px">${esc(label)}</a>`
  return `<nav style="margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:2px">${pill('一覧', `/dashboard/cron?limit=${limit}${symbolQs}`, active === 'list')}${pill('マトリクス', `/dashboard/cron?view=matrix${symbolQs}`, active === 'matrix')}</nav>`
}

export function cronBody(
  rows: DecisionRow[],
  limit: number,
  symbolFilter: string | undefined,
  universe?: SymbolUniverse | null,
  before?: number,
  hasMore = false,
  clientOrderIdFilter?: string,
  sessionFilter: 'open' | 'all' = 'open',
  // The last fetched id before the session filter thins `rows` — without it
  // a page that filters down to zero visible rows would have no cursor to
  // advance the pagination link with.
  pageLastId?: number,
): string {
  const copyAllBtn = rows.length > 0 ? LOG_COPY_ALL_BTN : ''
  const sessionQs = sessionFilter === 'all' ? '&session=all' : ''
  const baseHref = clientOrderIdFilter
    ? `/dashboard/cron?clientOrderId=${encodeURIComponent(clientOrderIdFilter)}&limit=${limit}${sessionQs}`
    : symbolFilter
      ? `/dashboard/cron?symbol=${encodeURIComponent(symbolFilter)}&limit=${limit}${sessionQs}`
      : `/dashboard/cron?limit=${limit}${sessionQs}`
  const header = clientOrderIdFilter
    ? `<p class="filter-banner">注文 <code>${esc(clientOrderIdFilter)}</code> の判定のみ表示。<a href="/dashboard/trades?clientOrderId=${encodeURIComponent(clientOrderIdFilter)}">約定を見る</a> / <a href="/dashboard/cron">全件へ戻る</a> ${copyAllBtn}</p>`
    : symbolFilter
      ? `<p class="filter-banner">Showing ${rows.length} decisions for <strong>${esc(displaySymbol(symbolFilter, universe))}</strong>。<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbolFilter)}">チャートで見る</a> / <a href="/dashboard/trades?symbol=${encodeURIComponent(symbolFilter)}">約定を見る</a> / <a href="/dashboard/cron">全銘柄へ戻る</a> / <a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a> ${copyAllBtn}</p>`
      : `<p class="filter-banner">Showing ${rows.length} decisions。<code>?symbol=SOXL</code> で絞り込み可能。<a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a> ${copyAllBtn}</p>`
  const pagination = renderPaginationNav({
    baseHref,
    before,
    lastId: pageLastId ?? (rows.length > 0 ? rows[rows.length - 1]!.id : undefined),
    hasMore,
  })
  const rail = renderCronSymbolRail(universe, symbolFilter, limit)
  const stripSession = baseHref.replace('&session=all', '')
  const sessionPills = `<span class="muted" style="font-size:12px;margin-left:8px">時間帯:</span>
    <a href="${stripSession}" class="chip${sessionFilter === 'open' ? ' active' : ''}">開場中のみ</a>
    <a href="${stripSession}&session=all" class="chip${sessionFilter === 'all' ? ' active' : ''}" title="休場時間帯に書かれた行 (手動 run 等) も表示する">全時間帯</a>`
  const viewPills = renderCronViewPills('list', limit, symbolFilter).replace('</nav>', `${sessionPills}</nav>`)
  const main =
    rows.length === 0
      ? `${viewPills}${header}<p class="muted">${
          sessionFilter === 'open' && pageLastId !== undefined
            ? 'このページの判定はすべて休場時間帯 (手動 run 等) のため非表示です。'
            : '判定ログがまだありません。'
        }</p>${pagination}`
      : `${viewPills}${header}
  ${renderDecisionTable(rows, universe, {
    copyVarName: '__cronCopy',
    showSymbol: true,
    filterLabel: `symbol=${symbolFilter ?? 'all'}${clientOrderIdFilter ? `, clientOrderId=${clientOrderIdFilter}` : ''}, limit=${limit}`,
  })}${pagination}`
  return rail ? `<div class="symbol-layout">${rail}<div class="symbol-main">${main}</div></div>` : main
}

// Shared by the strategy-decisions page and the chart symbol tab.
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
      const realizedCell =
        r.realizedPnl === null || r.realizedPnl === undefined
          ? '-'
          : formatRealizedPnl(r.realizedPnl)
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
    // Trace omitted here: a full ladder per row would bloat a 200-row copy-all.
    rows: rows.map((r) => ({ ...cronDecisionJson(r), requestId: r.requestId })),
    full: rows.map((r) => ({
      ...cronDecisionJson(r),
      requestId: r.requestId,
      trace: parseJsonObject(r.traceJson ?? null),
    })),
  })}
  ${renderLogCopyScript(opts.copyVarName)}`
}

function cronReasonCell(row: {
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

// Keys stay the English decision_log identifiers for compatibility; this
// only supplies the display name/unit for the ladder's comparison line.
const TRACE_OPERAND: Record<string, { name: string; unit: 'price' | 'pct' | 'mult' | 'days'; thr?: string }> = {
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

// `label_ja` is baked into traceJson at decision time, so a wording rename
// doesn't reach old rows. Renamed keys get overridden here at render time;
// unknown keys keep whatever label_ja was persisted.
const TRACE_LABEL_JA_CURRENT: Record<string, string> = {
  'route.position_open': '保有中',
  'scheduler.sell_position_exists': '売却対象の保有がある',
  'scheduler.position_qty_valid': '保有数量が有効',
}

// Empty string (not a placeholder) when no trace was persisted (pre-migration
// rows / some code paths), so callers keep their existing empty-state display.
function renderDecisionLadder(
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
      const label = esc((s.label && TRACE_LABEL_JA_CURRENT[s.label]) || s.label_ja || s.label || '?')
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

// Chart-side JS only sets innerHTML to this — the ladder markup has one
// source of truth (server), not a duplicated JS-side renderer.
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

export interface CronJsonExportResult {
  payload: unknown
  status: 200 | 400 | 404
}

// Shared by `/dashboard/cron/json` and MCP `get_cron_decisions`. Payload
// field set, key order, and error branches must stay byte-identical to the
// route's prior inline implementation (schema `dashboard_cron_export.v1`).
// symbol/limit are an MCP-only filter, applied only when requestId/decisionId
// are both absent.
export async function runCronJsonExport(
  db: ReturnType<typeof createDb>,
  opts: { requestId?: string; decisionId?: string; symbol?: string; limit?: number },
): Promise<CronJsonExportResult> {
  const requestedRequestId = opts.requestId?.trim()
  const requestedDecisionId = opts.decisionId?.trim()
  let decisionId: number | undefined
  if (requestedDecisionId && requestedDecisionId.length > 0) {
    if (!/^[1-9]\d*$/.test(requestedDecisionId)) {
      return { payload: { error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, status: 400 }
    }
    decisionId = Number(requestedDecisionId)
    if (!Number.isSafeInteger(decisionId) || decisionId <= 0) {
      return { payload: { error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, status: 400 }
    }
  }
  let requestId = requestedRequestId && requestedRequestId.length > 0
    ? requestedRequestId
    : undefined
  // MCP 専用の symbol 絞り込み: requestId / decisionId 指定より弱い優先度。
  // 「最新 request の全銘柄」ではなく「この銘柄の直近 N 判定」を返す。
  if (!requestId && decisionId === undefined && opts.symbol && opts.symbol.trim().length > 0) {
    const symbol = opts.symbol.toUpperCase().trim()
    const limit = clampLimit(opts.limit !== undefined ? String(opts.limit) : undefined)
    const rows = await loadDecisionRows(db, { symbol, limit })
    return {
      payload: {
        schema: 'dashboard_cron_export.v1',
        exportedAt: new Date().toISOString(),
        symbol,
        limit,
        rowCount: rows.length,
        decisions: rows.map((r) => ({ ...cronDecisionJson(r), requestId: r.requestId })),
      },
      status: 200,
    }
  }
  if (!requestId && decisionId === undefined) {
    const latest = await db
      .select({ requestId: strategyDecisionLog.requestId })
      .from(strategyDecisionLog)
      .orderBy(desc(strategyDecisionLog.id))
      .limit(50)
    requestId = latest.find((row) => row.requestId !== null)?.requestId ?? undefined
  }
  if (!requestId && decisionId === undefined) {
    return { payload: { error: 'no_cron_logs', message: 'strategy_decision_log has no request_id rows' }, status: 404 }
  }

  const filter = decisionId !== undefined
    ? eq(strategyDecisionLog.id, decisionId)
    : eq(strategyDecisionLog.requestId, requestId as string)
  const rows = await db
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
    .where(filter)
    .orderBy(asc(strategyDecisionLog.id))

  return {
    payload: {
      schema: 'dashboard_cron_export.v1',
      exportedAt: new Date().toISOString(),
      ...(decisionId !== undefined ? { decisionId } : { requestId }),
      rowCount: rows.length,
      decisions: rows.map(cronDecisionJson),
    },
    status: 200,
  }
}

function describeCronReason(reason: string | null | undefined): string {
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

export function formatRealizedPnl(value: number): string {
  const sign = value > 0 ? '+' : ''
  const cls = value > 0 ? 'ok' : value < 0 ? 'err' : 'muted'
  return `<span class="${cls}">${sign}${value.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
}

// Unparseable timestamps count as in-session (fail open) rather than being
// hidden — a filter bug should never silently drop rows from view.
export function isDecisionRowInSession(timestampIso: string, symbol: string): boolean {
  const ts = new Date(timestampIso)
  if (!Number.isFinite(ts.getTime())) return true
  return isWithinStrategyWindow(ts, inferTradingMarket(symbol), 0)
}

const SESSION_FILTER_BATCH_SIZE = 200
// D1 protection: caps the pathological case of a long run of filtered-out
// (out-of-session) rows from scanning the whole table in one call.
const SESSION_FILTER_MAX_BATCHES = 5

// Fetches limit+1 *visible* rows (not limit+1 raw rows) by advancing the
// cursor across batches as needed, so the page's row count and its next
// `before` cursor both track what was actually shown, not the fetch window.
export async function loadDecisionRowsInSession(
  db: ReturnType<typeof createDb>,
  opts: { symbol?: string; clientOrderId?: string; limit: number; before?: number },
): Promise<{ rows: DecisionRow[]; hasMore: boolean; lastScannedId?: number }> {
  const target = opts.limit + 1
  const visible: DecisionRow[] = []
  let before = opts.before
  let lastScannedId: number | undefined
  let truncated = false
  for (let i = 0; i < SESSION_FILTER_MAX_BATCHES; i++) {
    const batch = await loadDecisionRows(db, {
      symbol: opts.symbol,
      clientOrderId: opts.clientOrderId,
      limit: SESSION_FILTER_BATCH_SIZE,
      before,
    })
    for (const r of batch) {
      lastScannedId = r.id
      if (isDecisionRowInSession(r.timestamp, r.symbol)) visible.push(r)
      if (visible.length >= target) break
    }
    if (visible.length >= target) break
    if (batch.length < SESSION_FILTER_BATCH_SIZE) break // reached the end of the table
    const minId = batch[batch.length - 1]!.id
    // Guards a non-advancing cursor (duplicate ids, a test fake db) from looping forever.
    if (before !== undefined && minId >= before) break
    before = minId
    if (i === SESSION_FILTER_MAX_BATCHES - 1) truncated = true
  }
  return {
    rows: visible.slice(0, opts.limit),
    hasMore: visible.length > opts.limit || truncated,
    lastScannedId,
  }
}

function jstYmdOf(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
}


