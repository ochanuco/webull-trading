import type { Env } from '../../config/env'
import { type SymbolUniverse, loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog } from '../../infrastructure/db/schema'
import { desc, eq } from 'drizzle-orm'
import { SymbolStateClient } from '../../trading/state/SymbolStateClient'
import type { SymbolState } from '../../trading/state/types'
import { JST_FORMATTER, displaySymbol, esc, exportMeta, fmtJst, fmtNumber, formatCooldown, inactiveTooltip, isSymbolInactive, messageOf, renderJsonToolbar } from './shared'

/**
 * 各銘柄の「strategy が直近に判定で使った価格」を取得。
 * Yahoo daily bars から計算された `indicators.price` が
 * strategy_decision_log.price に書き出されているので、最新行を引く。
 *
 * Webull bridge が落ちて lastQuote が古い場合、こちらが新しければ
 * dashboard の現在値表示に採用される (pickFreshQuote で比較)。
 *
 * 実装: D1 の `(symbol, id)` 複合 index を活かして symbol 並列で
 * `ORDER BY id DESC LIMIT 1` を打つ。1 銘柄あたり 1 row のみ転送。
 */
export async function loadLatestStrategyPrices(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, { price: number; asOf: string }>> {
  if (symbols.length === 0) return new Map()
  const drizzle = createDb(db)
  // 個別 symbol の失敗で全体を 500 にしないよう per-symbol で catch。
  // strategy_decision_log がまだ空の銘柄や DB 一時的エラーは「Yahoo 価格なし」
  // として扱い、Webull lastQuote にフォールバックさせる。
  const entries = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const row = await drizzle
          .select({
            symbol: strategyDecisionLog.symbol,
            price: strategyDecisionLog.price,
            timestamp: strategyDecisionLog.timestamp,
          })
          .from(strategyDecisionLog)
          .where(eq(strategyDecisionLog.symbol, sym))
          .orderBy(desc(strategyDecisionLog.id))
          .limit(1)
        const r = row[0]
        if (!r || r.price === null || r.price === undefined) return null
        return [r.symbol, { price: r.price, asOf: r.timestamp }] as const
      } catch {
        return null
      }
    }),
  )
  return new Map(entries.filter((e): e is readonly [string, { price: number; asOf: string }] => e !== null))
}

/**
 * 表示用「現在値」の決定。dashboard が見せる現在値の source は
 * 2 系統あり、bridge 障害などで Webull snapshot が古くなる場合がある:
 *
 * - webull-snapshot: SymbolStateDO.lastQuote (Webull bridge の 5 分 cron)
 * - yahoo-bars: strategy_decision_log.price (Yahoo daily bars 経由、15 分 cron)
 *
 * 両方あれば asOf が新しい方を採用。strategy が判定に使う価格と表示が
 * 一致するのが UX 上の正なので、片方だけしか無い場合もそちらを採る。
 */
export interface ResolvedQuote {
  price: number
  source: string
  asOf: string
}

export function pickFreshQuote(
  webull: { price: number; source: string; asOf: string } | null,
  yahoo: { price: number; asOf: string } | null,
): ResolvedQuote | null {
  if (webull === null && yahoo === null) return null
  if (webull === null) return { price: yahoo!.price, source: 'yahoo-bars', asOf: yahoo!.asOf }
  if (yahoo === null) return { price: webull.price, source: webull.source, asOf: webull.asOf }
  const w = new Date(webull.asOf).getTime()
  const y = new Date(yahoo.asOf).getTime()
  // 不正な ISO は "より古い" 扱い: 有効な側があればそちらを採用、両方
  // 不正なら webull にタイブレーク (既存挙動維持)。`y > w` だけだと
  // w=NaN の時に false 評価で不正な webull を選んでしまう回帰がある。
  const wValid = Number.isFinite(w)
  const yValid = Number.isFinite(y)
  const pickYahoo = yValid && (!wValid || y > w)
  return pickYahoo
    ? { price: yahoo.price, source: 'yahoo-bars', asOf: yahoo.asOf }
    : { price: webull.price, source: webull.source, asOf: webull.asOf }
}

/** positions ページの loader 結果 (SSR / JSON export 共用)。 */
export interface PositionsPageData {
  rows: Array<{ sym: string; state: SymbolState | null; error: string | null }>
  strategyPriceMap: Map<string, { price: number; asOf: string }>
  universe: SymbolUniverse
}

/**
 * positions ページの loader (#dashboard-json-api)。SSR (`/dashboard/positions`)
 * と JSON export (`/dashboard/positions/json`) が共用する — 「画面で見る内容 =
 * AI に渡す JSON」を同一の取得結果から作るため、取得ロジックはここ 1 本に寄せる。
 */
export async function loadPositionsPageData(env: Env): Promise<PositionsPageData> {
  if (!env.DB || !env.SYMBOL_STATE) {
    throw new Error('DB or SYMBOL_STATE not bound')
  }
  const universe = await loadSymbolUniverse(env)
  const client = new SymbolStateClient(env.SYMBOL_STATE)
  // inactive 銘柄も表示する (operator visibility) — chart に飛んで状態を確認したり
  // 再有効化判断したりするのに必要。cron / risk gate は引き続き allowedSymbols のみ評価。
  const allDisplaySymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  const [rows, strategyPriceMap] = await Promise.all([
    Promise.all(
      allDisplaySymbols.map(async (sym) => {
        try {
          return { sym, state: await client.getState(sym), error: null as string | null }
        } catch (err) {
          return { sym, state: null as SymbolState | null, error: messageOf(err) }
        }
      }),
    ),
    loadLatestStrategyPrices(env.DB, allDisplaySymbols),
  ])
  return { rows, strategyPriceMap, universe }
}

/** JSON export の 1 銘柄行。SSR テーブルの表示列と同じ情報の機械可読版。 */
interface PositionExportRow {
  symbol: string
  displayName: string | null
  qty: number | null
  avgPrice: number | null
  quote: ResolvedQuote | null
  /** 未実現損益 (%)。SSR の「評価損益」列と同じ式 (現在値 vs 平均取得単価)。 */
  unrealizedPnlPct: number | null
  pendingOrderSide: string | null
  cooldownUntil: string | null
  inactive: boolean
  /** DO 取得失敗時のみ非 null。この行の他 field は null になる。 */
  error: string | null
}

/**
 * positions packet builder (schema: `dashboard_positions_export.v1`)。
 *
 * SSR の positionsBody と同じ loader 結果から pure に組み立てる。SymbolState の
 * 内部管理 field (settledCash / pendingSettlement / appliedClientOrderIds) は
 * 画面にも出していないので packet にも載せない — export は画面同等に絞る。
 */
export function buildPositionsPacket(data: PositionsPageData) {
  const positions: PositionExportRow[] = data.rows.map((r) => {
    const inactive = isSymbolInactive(r.sym, data.universe)
    const displayName = data.universe.symbolName[r.sym.toUpperCase()] ?? null
    if (r.error !== null || r.state === null) {
      return {
        symbol: r.sym,
        displayName,
        qty: null,
        avgPrice: null,
        quote: null,
        unrealizedPnlPct: null,
        pendingOrderSide: null,
        cooldownUntil: null,
        inactive,
        error: r.error ?? '状態取得不可',
      }
    }
    const s = r.state
    const pos = s.position
    // 現在値の解決は SSR と同じ pickFreshQuote (Webull snapshot vs Yahoo bars の
    // 新しい方)。画面と JSON で「現在値」がずれると AI 相談時に混乱するため。
    const webull = s.lastQuote
      ? { price: s.lastQuote.price, source: s.lastQuote.source, asOf: s.lastQuote.asOf ?? s.lastQuote.fetchedAt }
      : null
    const quote = pickFreshQuote(webull, data.strategyPriceMap.get(s.symbol) ?? null)
    const unrealizedPnlPct =
      pos !== null && quote !== null && pos.avgPrice > 0
        ? ((quote.price - pos.avgPrice) / pos.avgPrice) * 100
        : null
    return {
      symbol: s.symbol,
      displayName,
      qty: pos?.qty ?? null,
      avgPrice: pos?.avgPrice ?? null,
      quote,
      unrealizedPnlPct,
      pendingOrderSide: s.pendingOrder?.side ?? null,
      cooldownUntil: s.cooldownUntil,
      inactive,
      error: null,
    }
  })
  return {
    ...exportMeta('dashboard_positions_export.v1'),
    rowCount: positions.length,
    positions,
  }
}

export function formatQuoteAsOf(asOf: string): string {
  const d = new Date(asOf)
  if (!Number.isFinite(d.getTime())) return '?'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')} JST`
}
