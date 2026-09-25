import type { Env } from '../../config/env'
import { type SymbolUniverse, loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog } from '../../infrastructure/db/schema'
import { desc, eq } from 'drizzle-orm'
import { SymbolStateClient } from '../../trading/state/SymbolStateClient'
import type { SymbolState } from '../../trading/state/types'
import { JST_FORMATTER, displaySymbol, esc, exportMeta, fmtJst, fmtNumber, formatCooldown, inactiveTooltip, isSymbolInactive, messageOf, renderJsonToolbar } from './shared'

export async function loadLatestStrategyPrices(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, { price: number; asOf: string }>> {
  if (symbols.length === 0) return new Map()
  const drizzle = createDb(db)
  // Per-symbol try/catch: an empty strategy_decision_log or a transient DB error for one
  // symbol falls back to "no Yahoo price" (pickFreshQuote then uses Webull) instead of 500ing.
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

/** Picks whichever of the two quote sources (Webull snapshot, Yahoo bars) has the fresher `asOf`. */
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
  // An invalid ISO string is treated as "older", not skipped: plain `y > w` evaluates false
  // when w is NaN, which would silently pick the invalid webull value over a valid yahoo one.
  const wValid = Number.isFinite(w)
  const yValid = Number.isFinite(y)
  const pickYahoo = yValid && (!wValid || y > w)
  return pickYahoo
    ? { price: yahoo.price, source: 'yahoo-bars', asOf: yahoo.asOf }
    : { price: webull.price, source: webull.source, asOf: webull.asOf }
}

/** Shared loader result for both the SSR page and its JSON export. */
export interface PositionsPageData {
  rows: Array<{ sym: string; state: SymbolState | null; error: string | null }>
  strategyPriceMap: Map<string, { price: number; asOf: string }>
  universe: SymbolUniverse
}

// Single fetch path shared by SSR (/dashboard/positions) and its JSON export, so "what the
// screen shows" and "what the AI reads" can't drift apart.
export async function loadPositionsPageData(env: Env): Promise<PositionsPageData> {
  if (!env.DB || !env.SYMBOL_STATE) {
    throw new Error('DB or SYMBOL_STATE not bound')
  }
  const universe = await loadSymbolUniverse(env)
  const client = new SymbolStateClient(env.SYMBOL_STATE)
  // Includes inactive symbols for operator visibility (inspect state, decide on
  // re-enabling) even though cron/risk gates only ever evaluate allowedSymbols.
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

/** Machine-readable mirror of the SSR positions table's columns. */
interface PositionExportRow {
  symbol: string
  displayName: string | null
  qty: number | null
  avgPrice: number | null
  quote: ResolvedQuote | null
  /** Same formula as the SSR "評価損益" column: (quote.price - avgPrice) / avgPrice. */
  unrealizedPnlPct: number | null
  pendingOrderSide: string | null
  cooldownUntil: string | null
  inactive: boolean
  /** Non-null only when the DO fetch failed; the rest of the row is null in that case. */
  error: string | null
}

// Builds the `dashboard_positions_export.v1` packet purely from PositionsPageData, mirroring
// positionsBody's own field set — SymbolState internals (settledCash, pendingSettlement,
// appliedClientOrderIds) aren't shown on screen either, so they're left out here too.
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
    // Same pickFreshQuote as the SSR page: a diverging "current price" between the screen and
    // this JSON would confuse whoever/whatever reads them side by side.
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
