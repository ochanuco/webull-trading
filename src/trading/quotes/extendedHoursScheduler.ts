/**
 * Pre-market reference producer, run from the quote-reconcile cron. Read
 * only — never writes SymbolStateDO or QuoteSnapshot — so a bad observation
 * can't leak into strategy/execution decisions. Never throws: fetch/DB
 * failures are logged and swallowed per symbol so one bad fetch doesn't
 * fail the whole tick.
 */
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import {
  createExtendedHoursObservationDb,
  createExtendedHoursObservationRepo,
  type ExtendedHoursObservationRecord,
} from '../../infrastructure/db/extendedHoursObservationRepo'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import {
  YahooExtendedHoursClient,
  type PreMarketBar,
  type PreMarketSeries,
} from '../../infrastructure/quotes/YahooExtendedHoursClient'
import { evaluateStrategyWindow, isWithinStrategyWindow } from '../domain/tradingCalendar'
import { buildSymbolRules } from '../strategy/symbolRuleResolution'
import { resolveStopDistance } from '../strategy/stopDistance'
import type { SymbolRule } from '../strategy/strategies/PullbackUptrendStrategy'
import { SymbolStateClient } from '../state/SymbolStateClient'

/** Half-open band [open − 90min, open) — the US premarket window. */
const PREMARKET_LEAD_MINUTES = 90
const GAP_WARNING_PCT = -3
const TO_STOP_WARNING_PCT = 2
const STALE_FRESHNESS_SEC = 20 * 60

type ExtendedHoursStatus = 'NORMAL' | 'WARNING' | 'STOP_AT_OPEN_CANDIDATE' | 'UNKNOWN'

export interface ExtendedHoursObservationSummary {
  ran: boolean
  reason?: string
  symbols: number
  persisted: number
  statuses: Record<string, number>
  errors: number
}

interface RunExtendedHoursObservationOptions {
  env: Env
  requestId?: string
  now?: () => Date
  /** Test seam; defaults to the real `YahooExtendedHoursClient`. */
  client?: YahooExtendedHoursClient
}

export interface AssessPreMarketInput {
  series: PreMarketSeries | null
  now: Date
  /** toStopPct is only computed when qty > 0 and avgPrice > 0. */
  position?: { qty: number; avgPrice: number } | null
  rule?: SymbolRule
  atr20?: number | null
}

export interface AssessPreMarketResult {
  status: ExtendedHoursStatus
  preMarketLast: number | null
  preMarketLow: number | null
  prevClose: number | null
  gapPct: number | null
  direction15mPct: number | null
  toStopPct: number | null
  lastBarAt: string | null
  freshnessSec: number | null
}

/**
 * Pure: derives display metrics and status from a Yahoo series plus
 * optional position/rule/atr20 context.
 */
export function assessPreMarket(input: AssessPreMarketInput): AssessPreMarketResult {
  const { series, now } = input
  if (!series || series.bars.length === 0) {
    return {
      status: 'UNKNOWN',
      preMarketLast: null,
      preMarketLow: null,
      prevClose: series?.prevClose ?? null,
      gapPct: null,
      direction15mPct: null,
      toStopPct: null,
      lastBarAt: null,
      freshnessSec: null,
    }
  }

  const lastBar = series.bars[series.bars.length - 1]!
  const preMarketLast = lastBar.close
  const preMarketLow = Math.min(...series.bars.map((b) => b.low ?? b.close))
  const prevClose = series.prevClose
  const lastBarAt = lastBar.at
  const lastBarMs = new Date(lastBarAt).getTime()
  const freshnessSec = Number.isFinite(lastBarMs) ? Math.round((now.getTime() - lastBarMs) / 1000) : null

  const gapPct =
    prevClose !== null && prevClose > 0 ? ((preMarketLast - prevClose) / prevClose) * 100 : null

  const direction15mPct = computeDirection15m(series.bars, lastBar, lastBarMs)

  const toStopPct = computeToStopPct(preMarketLast, input.position, input.rule, input.atr20)

  let status: ExtendedHoursStatus
  if (freshnessSec === null || freshnessSec > STALE_FRESHNESS_SEC || prevClose === null) {
    status = 'UNKNOWN'
  } else if (toStopPct !== null && toStopPct <= 0) {
    status = 'STOP_AT_OPEN_CANDIDATE'
  } else if ((gapPct !== null && gapPct <= GAP_WARNING_PCT) || (toStopPct !== null && toStopPct <= TO_STOP_WARNING_PCT)) {
    status = 'WARNING'
  } else {
    status = 'NORMAL'
  }

  return { status, preMarketLast, preMarketLow, prevClose, gapPct, direction15mPct, toStopPct, lastBarAt, freshnessSec }
}

/** % change from the oldest bar within the last 15 minutes to the last bar; null if they're the same bar. */
function computeDirection15m(bars: PreMarketBar[], lastBar: PreMarketBar, lastBarMs: number): number | null {
  if (!Number.isFinite(lastBarMs)) return null
  const cutoffMs = lastBarMs - 15 * 60 * 1000
  // Assumes bars are pre-sorted ascending (YahooExtendedHoursClient's contract).
  let baseBar: PreMarketBar | null = null
  for (const bar of bars) {
    const barMs = new Date(bar.at).getTime()
    if (Number.isFinite(barMs) && barMs >= cutoffMs) {
      baseBar = bar
      break
    }
  }
  if (!baseBar || baseBar.at === lastBar.at || !(baseBar.close > 0)) return null
  return ((lastBar.close - baseBar.close) / baseBar.close) * 100
}

/** Position-only: (pre-market pnl%) − effectiveStopPct. Null without a position/rule. */
function computeToStopPct(
  preMarketLast: number,
  position: { qty: number; avgPrice: number } | null | undefined,
  rule: SymbolRule | undefined,
  atr20: number | null | undefined,
): number | null {
  if (!position || !(position.qty > 0) || !(position.avgPrice > 0) || !rule) return null
  const stop = resolveStopDistance({
    price: position.avgPrice,
    stopPct: rule.stopPct,
    takeProfitPct: rule.takeProfitPct,
    atr20: atr20 ?? 0,
    kAtr: rule.kAtr,
    maxStopToTpRatio: rule.maxStopToTpRatio,
  })
  const pnlPct = ((preMarketLast - position.avgPrice) / position.avgPrice) * 100
  return pnlPct - stop.effectiveStopPct * 100
}

/**
 * Latest atr20 per symbol from the decision log's `indicators_json`.
 * Duplicates the same SQL as dashboard/index.ts's `loadLatestAtr20` rather
 * than importing it, to avoid a trading-layer → routes-layer dependency.
 */
async function loadLatestAtr20(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  const rows = await db
    .prepare(
      `SELECT symbol, indicators_json FROM strategy_decision_log
       WHERE id IN (SELECT MAX(id) FROM strategy_decision_log GROUP BY symbol)`,
    )
    .all<{ symbol: string | null; indicators_json: string | null }>()
  for (const r of rows.results ?? []) {
    if (!r.symbol || !r.indicators_json) continue
    try {
      const parsed = JSON.parse(r.indicators_json) as { atr20?: unknown }
      if (typeof parsed.atr20 === 'number' && Number.isFinite(parsed.atr20) && parsed.atr20 > 0) {
        out.set(r.symbol.toUpperCase(), parsed.atr20)
      }
    } catch {
      // Malformed row: skip, this symbol just has no atr20.
    }
  }
  return out
}

/** NY local date (YYYY-MM-DD), same formatToParts technique as `usMarketCalendar.formatNyYmd`. */
const NY_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatNySessionYmd(date: Date): string {
  return NY_YMD_FORMATTER.format(date)
}

/** Unset or anything but `'true'` means disabled (opt-in, fail-closed default). */
function isOptInEnabled(flag: string | undefined): boolean {
  return (flag ?? '').trim().toLowerCase() === 'true'
}

export async function runExtendedHoursObservation(
  options: RunExtendedHoursObservationOptions,
): Promise<ExtendedHoursObservationSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const empty = (reason: string): ExtendedHoursObservationSummary => ({
    ran: false,
    reason,
    symbols: 0,
    persisted: 0,
    statuses: {},
    errors: 0,
  })

  if (!isOptInEnabled(env.EXTENDED_HOURS_OBSERVATION_ENABLED)) {
    return empty('extended_hours_observation_disabled')
  }
  if (!env.DB) {
    return empty('db_unavailable')
  }

  const nowDate = now()
  // Bounds the premarket band externally rather than modifying tradingCalendar.
  const inPremarketWindow =
    evaluateStrategyWindow(nowDate, 'US', PREMARKET_LEAD_MINUTES) === 'in_window' &&
    !isWithinStrategyWindow(nowDate, 'US', 0)
  if (!inPremarketWindow) {
    return empty('outside_premarket_window')
  }

  try {
    const universe = await loadSymbolUniverse(env)
    const symbols = universe.allowedSymbols.filter(
      (sym) => !sym.startsWith('^') && universe.symbolMarket[sym] === 'US',
    )
    if (symbols.length === 0) {
      return empty('no_us_symbols')
    }

    const global = await loadGlobalConfigFrom(env, options.requestId)
    const defaultRule: SymbolRule = {
      stopPct: global.pullbackDefaultStopPct,
      takeProfitPct: global.pullbackDefaultTakeProfitPct,
      timeStopDays: global.pullbackDefaultTimeStopDays,
      pullbackMax: global.pullbackDefaultPullbackMax,
      pullbackMin: global.pullbackDefaultPullbackMin,
      minReturn50d: global.pullbackDefaultMinReturn50d,
      requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
      kAtr: global.pullbackDefaultKAtr,
      maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
      maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
      reentryMinAtrBelowLastExit: 1.0,
      reentryGuardBusinessDays: 3,
      maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
    }
    const rules = buildSymbolRules(defaultRule, universe)

    const client = options.client ?? new YahooExtendedHoursClient()
    const symbolClient = env.SYMBOL_STATE ? new SymbolStateClient(env.SYMBOL_STATE) : null
    const atr20Map = await loadLatestAtr20(env.DB, symbols)
    const sessionYmd = formatNySessionYmd(nowDate)
    const capturedAt = nowDate.toISOString()

    const statuses: Record<string, number> = {}
    let errors = 0

    const records: ExtendedHoursObservationRecord[] = await Promise.all(
      symbols.map(async (symbol) => {
        let series: PreMarketSeries | null = null
        try {
          series = await client.getPreMarketSeries(symbol)
        } catch (error) {
          errors += 1
          console.warn(
            JSON.stringify({
              event: 'extended_hours_observation_symbol_error',
              requestId: options.requestId,
              symbol,
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        }
        const position = symbolClient
          ? await symbolClient
              .getState(symbol)
              .then((state) => state.position)
              .catch(() => null)
          : null
        const assessment = assessPreMarket({
          series,
          now: nowDate,
          position,
          rule: rules[symbol.toUpperCase()] ?? defaultRule,
          atr20: atr20Map.get(symbol.toUpperCase()) ?? null,
        })
        statuses[assessment.status] = (statuses[assessment.status] ?? 0) + 1
        return {
          symbol: symbol.toUpperCase(),
          capturedAt,
          sessionYmd,
          status: assessment.status,
          preMarketLast: assessment.preMarketLast,
          preMarketLow: assessment.preMarketLow,
          prevClose: assessment.prevClose,
          gapPct: assessment.gapPct,
          direction15mPct: assessment.direction15mPct,
          toStopPct: assessment.toStopPct,
          lastBarAt: assessment.lastBarAt,
          freshnessSec: assessment.freshnessSec,
          requestId: options.requestId ?? null,
        }
      }),
    )

    const repo = createExtendedHoursObservationRepo(createExtendedHoursObservationDb(env.DB))
    const { inserted } = await repo.insertMany(records)

    return {
      ran: true,
      symbols: symbols.length,
      persisted: inserted,
      statuses,
      errors,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'extended_hours_observation_error',
        requestId: options.requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return empty('error')
  }
}
