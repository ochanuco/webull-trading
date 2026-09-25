import type { BarClient, IntradayBar } from '../../infrastructure/quotes/BarClient'
import { logPostSubmit, logPreSubmit } from '../../infrastructure/logger/tradeJournal'
import { classifyBrokerErrorCause } from '../../infrastructure/notification/brokerErrorSurge'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { BrokerRequestError, isSellQtyExceedError, isTickerDenyError } from '../../shared/errors'
import type { DecisionTraceStep, Signal } from '../domain/Signal'
import type { StrategyDecision } from '../domain/StrategyDecision'
import { inferTradingMarket, isWithinUsCloseWindow, type TradingMarket } from '../domain/tradingCalendar'
import { NO_TRADE_COST, netRealizedPnl, type TradeCostConfig } from '../domain/tradingCost'
import type { AtrBaselineMode } from './indicators'
import type { Execution } from '../execution/Execution'
import type { PositionStore } from '../state/PositionStore'
import type { SymbolState } from '../state/types'
import { freshDecisionQuote } from '../quotes/decisionQuote'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from './indicators'
import { computePullbackSizing } from './pullbackSizing'
import type { BuyingPowerLedger } from './buyingPower'
import type { ExposureLedger } from './exposureLedger'

/** Minutes before US close where a held intraday-only position force-closes. 15 guarantees at least one 5-min cron tick lands inside the window. */
const INTRADAY_CLOSE_WINDOW_MIN = 15
// Wider than INTRADAY_CLOSE_WINDOW_MIN: a BUY let through right up to the
// close-window edge would either round-trip immediately or carry overnight.
const INTRADAY_NO_ENTRY_WINDOW_MIN = 30
// A 60m bar's timestamp is its open time, so a fresh bar can already be
// ~60min old; 2h adds provider-delay margin without rejecting normal bars.
const DEFAULT_INTRADAY_BAR_MAX_AGE_MS = 2 * 60 * 60 * 1000
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import { BreakoutMomentumStrategy } from './strategies/BreakoutMomentumStrategy'
import {
  PullbackUptrendStrategy,
  TEST_DEFAULT_RULE,
  type SymbolRule,
} from './strategies/PullbackUptrendStrategy'
import { evaluateEarningsGate } from '../risk/earningsGate'
import {
  DEFAULT_MACRO_GATE_CONFIG,
  evaluateMacroEventGate,
  type MacroEventGateConfig,
} from '../risk/macroEventGate'
import type { VixRegimeFilterDecision } from '../risk/vixRegimeFilter'
import type { NewsShockGateDecision } from '../risk/newsShockGate'
import type { ExtendedHoursGateDecision } from '../risk/extendedHoursGate'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'
import type { MacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import { evaluatePerSymbolRisk } from '../risk/perSymbolRiskGate'
import { deriveEntryStatusFromIndicators, type EntryStatus } from './entryStatus'
import {
  evaluatePairRegime,
  type PairRegimeDecision,
  type PairRegimeEntry,
  type PairRegimeThresholds,
} from './pairRegime'
import type { EntrySnapshot } from './conditionalAllocation'

const DEFAULT_BAR_LOOKBACK = 60
const DEFAULT_PENDING_LOCK_TTL_MS = 60_000
/** Daily-bar lookback for the pair-regime proxy symbol, independent of `DEFAULT_BAR_LOOKBACK`. */
const PAIR_REGIME_PROXY_BAR_LOOKBACK = 80

export interface PullbackSchedulerOptions {
  symbols: string[]
  /** Account equity for risk-% sizing. Unspecified fails closed as `capital-unset`; unused for budget-alloc symbols. */
  equity?: number
  barClient: BarClient
  positionStore: PositionStore
  execution: Execution
  strategy?: PullbackUptrendStrategy
  /** Fallback rule when neither `strategy` nor `rulesMap` has an entry for the symbol. */
  defaultRule?: SymbolRule
  rulesMap?: Record<string, SymbolRule>
  /** Symbols with role==='momentum', routed to `momentumStrategy` instead of `strategy`; Risk→Execution afterward is unchanged. */
  momentumSymbols?: Set<string>
  /** Strategy for `momentumSymbols`. Unspecified falls back to the pullback strategy for them too. */
  momentumStrategy?: BreakoutMomentumStrategy
  symbolCapMap?: Record<string, number>
  /** `global_config.max_order_notional_usd/jpy`, combined with `symbolCapMap` by min. Unset = unlimited. */
  maxOrderNotional?: number
  barLookback?: number
  riskPerTradePct?: number
  pendingLockTtlMs?: number
  /** @deprecated Test-only backward-compat uniform lot; production uses `symbolLotSizeMap`. */
  lotSize?: number
  /** symbol → lot_size (>=1), takes priority over `lotSize`. Passing this switches to lot-required mode: a BUY for a symbol missing from the map fails closed instead of defaulting to lot=1. */
  symbolLotSizeMap?: Record<string, number>
  /** symbol → budget_alloc_pct (0<pct<=1). Present symbols switch to fixed-% sizing against the JPY account pool; unspecified stays risk-%. */
  symbolBudgetAllocPctMap?: Record<string, number>
  /** Sizing basis for budget-alloc symbols: `global_config.total_capital_jpy`. */
  budgetBasisJpy?: number
  /** JPY value of 1 unit of this run's symbol currency (JPY run=1, USD run=USD/JPY rate). Pass undefined on FX fetch failure to fail-close budget symbols. */
  fxJpyPerSymbolCcy?: number
  /** Shared buying-power ledger, reserved (JPY-converted) just before a BUY submit to pre-empt a Webull 417. Shared across USD/JPY runs. Unspecified disables the gate. */
  buyingPower?: BuyingPowerLedger
  /** Same design as `buyingPower`, gating `global_config.max_portfolio_exposure_pct`. */
  exposureCap?: ExposureLedger
  /** Symbols force-SELLed in full if held inside the US pre-close window (avoids a leveraged ETF's open-gap stop-out). Unspecified/absent symbols keep swing holds. */
  intradayOnlySymbols?: Set<string>
  /** Per-symbol decision sink, called once per HOLD/BUY/SELL/SKIP/REJECT/ERROR. A throw here does not stop the scheduler. */
  onDecision?: (record: {
    symbol: string
    decision: StrategyDecision
    reason?: string
    price?: number
    indicatorsJson?: string
    /** Set only for a submitted BUY/SELL; the join key the dashboard uses against trade_journal. */
    clientOrderId?: string
    trace?: DecisionTraceStep[]
  }) => Promise<void> | void
  /** Correlation id for this cron run, included in structured logs. */
  requestId?: string
  /** Fire-and-forget notification sink for BUY/SELL and cron errors; the scheduler only `.catch()`s it, never awaits or retries. */
  notifier?: Notifier
  /** Per-symbol risk gate config. Applied only when every dependency is supplied; otherwise skipped (preserves the no-option caller behavior). */
  perSymbolRisk?: PerSymbolRiskScheduleConfig
  /** Resolver for the SELL_QTY_EXCEED (417) fallback. A throw or `null` re-throws the original error (fail-closed); unset skips the fallback. */
  sellFallback?: SellFallbackConfig
  /** Earnings calendar gate: freezes BUY within ±N business days. Unset (`repo` missing) skips it. */
  earningsGate?: EarningsScheduleConfig
  /** Freezes all-symbol BUY around FOMC/CPI/NFP etc. Evaluated after `earningsGate`, so an earnings reject wins when both would fire. */
  macroEventGate?: MacroEventScheduleConfig
  /** VIX regime decision from the caller's `evaluateVixRegime` call. sizeScale 0 blocks all BUY, <1 scales qty down, 1 is a no-op. Unset skips it; SELL is never gated. */
  vixDecision?: VixRegimeFilterDecision
  /** News shock gate. 'enforce' scales qty into the same multiplier chain as VIX; 'observe' only records the would-be reason in trace. Unset skips it; SELL is never gated. */
  newsShockGate?: {
    mode: 'observe' | 'enforce'
    decision: NewsShockGateDecision
  }
  /** Extended-hours (pre-market) gate, per symbol. 'enforce' blocks BUY (`block_entry`) or scales qty (`reduce_entry`, chained after VIX/news shock); 'observe' only records trace. A symbol missing from the Map is a no-op; SELL is never gated. */
  extendedHoursGate?: {
    mode: 'observe' | 'enforce'
    decisions: Map<string, ExtendedHoursGateDecision>
  }
  /** symbol → reason for a role with entry disabled; SKIPs BUY only (exit stays open). Unset skips it. */
  entrySuppressedSymbols?: Record<string, string>
  /** Trade cost estimate for netting the TRADE notification's realized PnL; unset = 0 (gross). Kept in sync with `reconcileFills`. */
  tradeCost?: TradeCostConfig
  /** Baseline ATR construction. Unset defaults to 'percentile' (best in backtests). */
  atrBaselineMode?: AtrBaselineMode
  /** Pair-regime layer. 'observe' only records zone/score in trace; 'enforce' SKIPs a BUY on the disallowed side and SELLs (regime_flip) on a flip against the held side. Unset keeps prior behavior. */
  pairRegime?: {
    mode: 'observe' | 'enforce'
    thresholds: PairRegimeThresholds
    pairs: PairRegimeEntry[]
  }
  /** Symbols eligible for HALF (0.5x) entry promotion. Symbols outside the set keep the binary (no-HALF) behavior. */
  halfEntrySymbols?: Set<string>
  /** symbol → fixed BUY quantity for conditional-allocation cash rebalancing; bypasses strategy sizing but still passes every downstream gate (lot, per-symbol risk, buying-power, pending lock, DRY_RUN). Unset keeps prior behavior. */
  cashRebalanceQuantityMap?: Record<string, number>
  /** symbol → partial SELL quantity (clamped to position qty) for cash rebalancing, applied only when the strategy itself has no SELL signal — flagged as partial even when the clamp reaches the full position. Unset keeps prior behavior. */
  cashRebalanceSellQuantityMap?: Record<string, number>
  /** Called once per symbol when a BUY submit hits Webull's permanent per-ticker deny. Never called for SELL — denying an exit would orphan the position. A failure inside the hook is the hook's own responsibility. */
  onTickerDeny?: (symbol: string) => Promise<void>
  /** Fail-closed gate blocking new BUY when a broker stub fill (sanity-check rejection) was observed for the symbol within `withinMs`. Unset skips it; SELL is unaffected. */
  sanityFailedCooldown?: SanityFailedCooldownConfig
  /** Max staleness (ms) for the intraday 60m bar BUY-freshness gate; evaluated only when `barClient.getIntradayBars` exists. Default `DEFAULT_INTRADAY_BAR_MAX_AGE_MS`. SELL is unaffected. */
  intradayBarMaxAgeMs?: number
  now?: () => Date
}

interface SanityFailedCooldownConfig {
  /** Predicate for a recent sanity_failed row for `symbol` within `withinMs`. A throw is treated as cooldown-active (fail-closed). */
  check: (symbol: string) => Promise<boolean>
  /** Window shown in the reject reason string; the actual cutoff lives in `check`'s own implementation. */
  withinMs: number
}

/**
 * Resolver for the SELL_QTY_EXCEED fallback. `null` means not held / not
 * findable, and a throw is treated the same — the fallback never converts
 * the original SELL_QTY_EXCEED error into a different one.
 */
interface SellFallbackConfig {
  getAvailableQty: (symbol: string) => Promise<number | null>
}

interface EarningsScheduleConfig {
  repo: EarningsCalendarRepo
  /** ±N business days. Default 1. */
  freezeBusinessDays?: number
}

interface MacroEventScheduleConfig {
  repo: MacroEventCalendarRepo
  /** Partial; missing fields fall back to `DEFAULT_MACRO_GATE_CONFIG`. */
  config?: Partial<MacroEventGateConfig>
}

interface PerSymbolRiskScheduleConfig {
  /** BUY symbol → inverse symbol (uppercase keys). */
  inversePairs: Record<string, string>
  spreadLimits: { US: number; JP: number }
  staleQuoteMs: number
  gapRejectPct: number
}

export interface PullbackRunSummary {
  evaluated: number
  buys: number
  sells: number
  holds: number
  rejected: Array<{ symbol: string; reason: string }>
  errors: Array<{ symbol: string; message: string }>
  /** Mirrors strategy_decision_log; lets one run be analyzed without reassembling scattered log lines. */
  decisions: PullbackDecisionTrace[]
  /** Per-symbol snapshot for conditional allocation, present only for symbols that reached a decision (missing on insufficient bars / ERROR). Consumed by runStrategyCron's allocation calc. */
  entrySnapshots: Record<string, EntrySnapshot>
  /** Set only when the `vixDecision` option was passed. */
  vix?: VixRegimeFilterDecision
  /** Set only when the `newsShockGate` option was passed. */
  newsShock?: NewsShockGateDecision
}

export interface PullbackDecisionTrace {
  symbol: string
  decision: StrategyDecision
  reason?: string
  price?: number
  indicatorsJson?: string
  trace?: DecisionTraceStep[]
  clientOrderId?: string | null
  order?: {
    side: 'BUY' | 'SELL'
    quantity: number
    notional: number
  }
}

/**
 * Drives PullbackUptrendStrategy across the ALLOWED_SYMBOLS universe on a
 * daily cadence: pulls daily bars, computes indicators, reads DO state,
 * resolves quantity via `computePullbackSizing`, then submits through the
 * provided {@link Execution}. The scheduler itself is transport-agnostic —
 * {@link src/index.ts} wires it to a Workers cron trigger.
 */
export async function runPullbackScheduler(
  options: PullbackSchedulerOptions,
): Promise<PullbackRunSummary> {
  const now = options.now ?? (() => new Date())
  const lookback = options.barLookback ?? DEFAULT_BAR_LOOKBACK
  // Decided once for the whole run, not per symbol; a client without getIntradayBars gets no gate.
  const intradayAttempted = typeof options.barClient.getIntradayBars === 'function'
  const intradayBarMaxAgeMs = options.intradayBarMaxAgeMs ?? DEFAULT_INTRADAY_BAR_MAX_AGE_MS
  const strategy =
    options.strategy ??
    new PullbackUptrendStrategy(options.defaultRule ?? TEST_DEFAULT_RULE, options.rulesMap ?? {})
  const pendingLockTtlMs = options.pendingLockTtlMs ?? DEFAULT_PENDING_LOCK_TTL_MS
  if (typeof pendingLockTtlMs !== 'number' || !Number.isFinite(pendingLockTtlMs) || pendingLockTtlMs <= 0) {
    throw new Error(`pendingLockTtlMs must be a finite positive number, got: ${pendingLockTtlMs}`)
  }

  const summary: PullbackRunSummary = {
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
    entrySnapshots: {},
    ...(options.vixDecision !== undefined ? { vix: options.vixDecision } : {}),
    ...(options.newsShockGate !== undefined ? { newsShock: options.newsShockGate.decision } : {}),
  }

  // Fire-and-forget: double-catches so a notifier failure can never fail the cron run.
  const emitNotify = (event: Parameters<NonNullable<typeof options.notifier>['notify']>[0]): void => {
    if (!options.notifier) return
    try {
      const p = options.notifier.notify(event)
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        ;(p as Promise<unknown>).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'notifier_emit_failed',
              requestId: options.requestId ?? null,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        })
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'notifier_emit_failed',
          requestId: options.requestId ?? null,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  // A throw from `onDecision` never stops the scheduler (logging failure isolation).
  const emitDecision = async (
    record: Parameters<NonNullable<typeof options.onDecision>>[0] & {
      order?: PullbackDecisionTrace['order']
    },
  ): Promise<void> => {
    summary.decisions.push({
      symbol: record.symbol,
      decision: record.decision,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.price !== undefined ? { price: record.price } : {}),
      ...(record.indicatorsJson !== undefined ? { indicatorsJson: record.indicatorsJson } : {}),
      ...(record.trace !== undefined ? { trace: record.trace } : {}),
      ...(record.clientOrderId !== undefined ? { clientOrderId: record.clientOrderId } : {}),
      ...(record.order !== undefined ? { order: record.order } : {}),
    })
    if (!options.onDecision) return
    try {
      const { order: _order, ...dbRecord } = record
      await options.onDecision(dbRecord)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'on_decision_sink_failed',
          requestId: options.requestId ?? null,
          symbol: record.symbol,
          decision: record.decision,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  const regimeBySymbol: RegimeBySymbol = options.pairRegime
    ? await evaluatePairRegimesForRun(
        options.pairRegime,
        options.symbols,
        options.barClient,
        now(),
        options.requestId,
      )
    : new Map()

  // A state-read failure fails safe to flat (0) rather than compounding the outage with a new branch.
  const heldQtyOrZero = async (symbol: string): Promise<number> => {
    try {
      const state = await options.positionStore.getState(symbol)
      return state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
        ? state.position.qty
        : 0
    } catch {
      return 0
    }
  }

  for (const symbol of options.symbols) {
    summary.evaluated += 1
    const upper = symbol.toUpperCase()
    let bars: DailyBar[]
    let intradayPrice: number | null = null
    let lastIntradayBar: IntradayBar | null = null
    try {
      // Intraday failure falls back to null (daily close); a daily fetch
      // failure after its one retry stays a throw — it would otherwise
      // silently skip a held position's exit evaluation.
      const intradayP = options.barClient.getIntradayBars
        ? options.barClient.getIntradayBars(symbol, '60m').catch(() => [])
        : Promise.resolve([])
      const dailyBars = await fetchDailyBarsWithRetry(options.barClient, symbol, lookback)
      const intradayBars = await intradayP
      bars = dailyBars
      // The chart UI reads the same intraday endpoint, so the BUY pin lines up with the candle.
      const lastIntraday = intradayBars[intradayBars.length - 1]
      lastIntradayBar = lastIntraday ?? null
      intradayPrice = lastIntraday ? lastIntraday.close : null
    } catch (error) {
      // Holding: surface an explicit "exit unavailable" reason/cause — never
      // silently degrade a SELL. Flat: plain ERROR, as before.
      const bareMessage = messageOf(error)
      const decisionReason = `bar fetch: ${bareMessage}`
      const heldQty = await heldQtyOrZero(upper)
      if (heldQty > 0) {
        const message = `exit evaluation unavailable while holding ${heldQty}: ${decisionReason}`
        summary.errors.push({ symbol: upper, message })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: message })
        emitNotify({ type: 'ERROR', symbol: upper, message, cause: 'exit_unavailable_while_holding' })
      } else {
        summary.errors.push({ symbol: upper, message: bareMessage })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: decisionReason })
        emitNotify({ type: 'ERROR', symbol: upper, message: bareMessage, cause: 'bar fetch' })
      }
      continue
    }

    const state = await options.positionStore.getState(upper)
    const decisionQuote = freshDecisionQuote(upper, state.lastQuote, now())
    const indicators = computePullbackIndicators(bars, decisionQuote?.price ?? intradayPrice, {
      baselineMode: options.atrBaselineMode ?? 'percentile',
    })
    if (!indicators) {
      const baseReason = 'insufficient bars for indicators'
      const heldQty = await heldQtyOrZero(upper)
      if (heldQty > 0) {
        const message = `exit evaluation unavailable while holding ${heldQty}: ${baseReason}`
        summary.errors.push({ symbol: upper, message })
        await emitDecision({ symbol: upper, decision: 'ERROR', reason: message })
        emitNotify({ type: 'ERROR', symbol: upper, message, cause: 'exit_unavailable_while_holding' })
      } else {
        summary.rejected.push({ symbol: upper, reason: baseReason })
        await emitDecision({ symbol: upper, decision: 'SKIP', reason: baseReason })
      }
      continue
    }

    const market = inferTradingMarket(upper)
    const holdBusinessDays =
      state.position !== null
        ? computeHoldBusinessDays(state.position.openedAt, now(), market)
        : 0

    // Not used in this run's own decision; consumed by runStrategyCron's post-run target/active-weight calc.
    summary.entrySnapshots[upper] = {
      status: deriveEntryStatusFromIndicators(indicators, strategy.resolveRule(upper)).status,
      price: indicators.price,
      heldQty:
        state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
          ? state.position.qty
          : 0,
    }

    const useMomentum = !!(options.momentumStrategy && options.momentumSymbols?.has(upper))
    const decider = useMomentum ? options.momentumStrategy! : strategy
    // No lastExecutedPrice fallback by design: overridePosition can null
    // position without a SELL, so "flat ⇒ last fill was SELL" doesn't hold;
    // lastExitPrice is the dedicated field set only on a SELL close.
    const reentryLastExitPrice = state.position === null ? state.lastExitPrice : null
    const reentryBusinessDaysSinceExit =
      state.position === null && state.lastExitAt
        ? computeHoldBusinessDays(state.lastExitAt, now(), market)
        : null
    let signal = decider.decide({
      symbol: upper,
      indicators,
      position: state.position,
      pendingOrder: state.pendingOrder,
      cooldownUntil: state.cooldownUntil,
      holdBusinessDays,
      lastExitPrice: reentryLastExitPrice,
      businessDaysSinceExit: reentryBusinessDaysSinceExit,
      now: now(),
    })

    // Anchors every decision's trace (including SKIP/HOLD/ERROR) to the price source/time actually used, for stale-price investigations.
    const priceAsOfSource = decisionQuote !== null ? decisionQuote.source
      : lastIntradayBar !== null ? 'intraday_60m' : 'daily_close'
    const priceAsOfValue =
      decisionQuote?.asOf ?? (lastIntradayBar !== null ? lastIntradayBar.timestamp : (bars[bars.length - 1]?.date ?? 'unknown'))
    signal = {
      ...signal,
      trace: [
        traceStep(
          'data.price_as_of',
          true,
          undefined,
          undefined,
          undefined,
          `${priceAsOfSource}:${priceAsOfValue}`,
        ),
        ...(signal.trace ?? []),
      ],
    }

    // BUY only (fail-closed scoped to entry). Date.parse's NaN must be
    // checked explicitly — an unchecked NaN comparison is always false and
    // silently disables the freshness gate.
    let priceFreshnessFailure: string | null = null
    if (intradayAttempted && decisionQuote === null) {
      if (lastIntradayBar === null) {
        priceFreshnessFailure =
          'stale price: intraday bar unavailable, daily close fallback not accepted for BUY'
      } else {
        const asOfMs = Date.parse(lastIntradayBar.timestamp)
        const ageMs = now().getTime() - asOfMs
        if (!Number.isFinite(asOfMs) || ageMs < 0 || ageMs > intradayBarMaxAgeMs) {
          priceFreshnessFailure = `stale price: intraday_60m as of ${lastIntradayBar.timestamp} exceeds ${intradayBarMaxAgeMs}ms`
        }
      }
    }

    const cashRebalanceQty = options.cashRebalanceQuantityMap?.[upper]
    signal = applyCashRebalanceBuyOverride(
      signal,
      cashRebalanceQty,
      state,
      strategy,
      upper,
      reentryBusinessDaysSinceExit,
      now().getTime(),
    )

    const cashRebalanceSellQty = options.cashRebalanceSellQuantityMap?.[upper]
    let cashRebalancePartialSell: boolean
    ;({ signal, cashRebalancePartialSell } = applyCashRebalanceSellOverride(signal, cashRebalanceSellQty, state))

    ;({ signal, cashRebalancePartialSell } = applyIntradayForceCloseOverride(
      signal,
      cashRebalancePartialSell,
      options.intradayOnlySymbols?.has(upper) ?? false,
      market,
      state,
      now(),
    ))

    const regime = regimeBySymbol.get(upper)
    if (options.pairRegime) {
      ;({ signal, cashRebalancePartialSell } = applyPairRegimeOverride(
        signal,
        cashRebalancePartialSell,
        regime,
        options.pairRegime,
        state,
      ))
    }

    const { signal: afterHalfEntry, positionMultiplier } = applyHalfEntryPromotion(
      signal,
      options.halfEntrySymbols?.has(upper) ?? false,
      state,
      now().getTime(),
    )
    signal = afterHalfEntry

    // Must run after applyHalfEntryPromotion: that can promote a HOLD to BUY, and a veto run first would see only the HOLD.
    signal = applyIntradayNoEntryVeto(signal, options.intradayOnlySymbols?.has(upper) ?? false, market, now())

    if (signal.action === 'HOLD') {
      summary.holds += 1
      await emitDecision({
        symbol: upper,
        decision: 'HOLD',
        reason: signal.reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: signal.trace,
      })
      continue
    }

    // enforce only; SELL/exit is never gated here.
    if (options.pairRegime?.mode === 'enforce' && signal.action === 'BUY') {
      const regimeGate = regimeBySymbol.get(upper)
      if (regimeGate) {
        const d = regimeGate.decision
        const allowed =
          (regimeGate.side === 'bull' && d.zone === 'bull') ||
          (regimeGate.side === 'bear' && d.zone === 'bear')
        if (!allowed) {
          const reason = `pair_regime: zone=${d.zone} blocks ${regimeGate.side} entry (${d.reason})`
          summary.rejected.push({ symbol: upper, reason })
          await emitDecision({
            symbol: upper,
            decision: 'SKIP',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.pair_regime', false, d.score, undefined, undefined, reason),
            ),
          })
          continue
        }
      }
    }

    // Never gates SELL — a since-relabeled symbol's exit (stop / time-stop / TP) must still run.
    if (signal.action === 'BUY' && options.entrySuppressedSymbols?.[upper] !== undefined) {
      const reason = options.entrySuppressedSymbols[upper]
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: appendTrace(
          signal.trace,
          traceStep('risk.role_entry_suppressed', false, undefined, undefined, undefined, reason),
        ),
      })
      continue
    }

    // Evaluated after cash rebalance / HALF promotion: both are independent
    // "should this be a BUY" decisions, but every eventual BUY must still clear this gate.
    if (signal.action === 'BUY' && priceFreshnessFailure !== null) {
      const reason = priceFreshnessFailure
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: appendTrace(
          signal.trace,
          traceStep('risk.price_freshness', false, undefined, undefined, undefined, reason),
        ),
      })
      continue
    }

    // A throw from `check` fails closed (treated as cooldown-active) rather than letting a DB-read failure wave a BUY through.
    if (signal.action === 'BUY' && options.sanityFailedCooldown) {
      let cooledDown = false
      try {
        cooledDown = await options.sanityFailedCooldown.check(upper)
      } catch (err) {
        cooledDown = true
        console.warn(
          JSON.stringify({
            event: 'sanity_failed_cooldown_check_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      if (cooledDown) {
        const minutes = Math.round(options.sanityFailedCooldown.withinMs / 60_000)
        const reason = `risk: sanity_failed cooldown active (recent broker stub fill within ${minutes}min)`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.sanity_failed_cooldown', false, undefined, undefined, undefined, reason),
          ),
        })
        continue
      }
    }

    let intent: OrderIntent
    if (signal.action === 'BUY') {
      const rule = strategy.resolveRule(upper)
      const resolvedLotSize =
        options.symbolLotSizeMap?.[upper] ??
        options.lotSize ??
        (options.symbolLotSizeMap === undefined ? 1 : undefined)
      if (
        resolvedLotSize === undefined ||
        !Number.isFinite(resolvedLotSize) ||
        !Number.isInteger(resolvedLotSize) ||
        resolvedLotSize < 1
      ) {
        const reason = `sizing rejected: missing-lot-size (symbol ${upper} has no lot_size configured, entry ${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('sizing.lot_size_configured', false, undefined, undefined, undefined, 'missing-lot-size'),
          ),
        })
        continue
      }
      // `computePullbackSizing` only accepts one cap per symbol, so combine symbolCapMap and maxOrderNotional here first.
      const perSymbolCap = options.symbolCapMap?.[upper]
      const globalOrderCap = options.maxOrderNotional
      const effectiveSymbolCap =
        perSymbolCap !== undefined && globalOrderCap !== undefined
          ? Math.min(perSymbolCap, globalOrderCap)
          : (perSymbolCap ?? globalOrderCap)
      // Cash rebalance quantity comes pre-computed from runStrategyCron's
      // allocation diff, so it skips pullback sizing — but the cap is
      // re-applied here too, since it can change after the plan was computed
      // and this keeps "cron BUY notional never exceeds cap" invariant true.
      const sizing =
        cashRebalanceQty !== undefined
          ? (() => {
              const lotQty = Math.floor(cashRebalanceQty / resolvedLotSize) * resolvedLotSize
              const lotNotional = lotQty * indicators.price
              if (effectiveSymbolCap !== undefined && lotNotional > effectiveSymbolCap) {
                const cappedQty =
                  Math.floor(effectiveSymbolCap / indicators.price / resolvedLotSize) * resolvedLotSize
                return {
                  quantity: cappedQty,
                  notional: cappedQty * indicators.price,
                  capped: true,
                  capReason: 'symbol-cap' as const,
                }
              }
              return { quantity: lotQty, notional: lotNotional, capped: false }
            })()
          : computePullbackSizing({
              equity: options.equity,
              entryPrice: indicators.price,
              stopPct: rule.stopPct,
              atr20: indicators.atr20,
              baselineAtr20: indicators.baselineAtr20,
              symbolCap: effectiveSymbolCap,
              riskPerTradePct: options.riskPerTradePct,
              lotSize: resolvedLotSize,
              kAtr: rule.kAtr,
              takeProfitPct: rule.takeProfitPct,
              maxStopToTpRatio: rule.maxStopToTpRatio,
              budgetAllocPct: options.symbolBudgetAllocPctMap?.[upper],
              budgetBasisJpy: options.budgetBasisJpy,
              fxJpyPerSymbolCcy: options.fxJpyPerSymbolCcy,
            })
      if (sizing.quantity <= 0) {
        const reason = buildSizingRejectReason(sizing, {
          lotSize: resolvedLotSize,
          entryPrice: indicators.price,
        })
        summary.holds += 1
        await emitDecision({
          symbol: upper,
          decision: 'HOLD',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('sizing.quantity_positive', false, sizing.quantity, '>', 0, sizing.capReason)),
        })
        continue
      }
      // Applied right after sizing, before VIX scale; a concurrent VIX warning multiplies on top (the more conservative side wins).
      let scaledQuantity = sizing.quantity
      if (positionMultiplier < 1) {
        scaledQuantity = applySizeScale(sizing.quantity, resolvedLotSize, positionMultiplier)
        if (scaledQuantity <= 0) {
          const reason = `sizing rejected: half-entry qty rounded to 0 (raw ${sizing.quantity} × ${positionMultiplier}, lot=${resolvedLotSize})`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('sizing.half_entry_quantity_positive', false, scaledQuantity, '>', 0, reason),
            ),
          })
          continue
        }
      }
      if (options.vixDecision) {
        if (options.vixDecision.sizeScale === 0) {
          const reason = `risk: ${options.vixDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.vix_regime', false, options.vixDecision.vix ?? null, '<=', null, options.vixDecision.reason),
            ),
          })
          continue
        }
        if (options.vixDecision.sizeScale < 1) {
          // Scales the post-half-entry qty (0.5x and VIX scale multiply together).
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, options.vixDecision.sizeScale)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${options.vixDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.vix_regime',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${options.vixDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      // Chains onto VIX (scales the post-VIX qty further); unreachable once VIX has already rounded qty to 0.
      if (options.newsShockGate) {
        const newsDecision = options.newsShockGate.decision
        const isObserve = options.newsShockGate.mode === 'observe'
        if (isObserve) {
          const wouldReduce = newsDecision.sizeScale < 1
          const observeNote = wouldReduce
            ? ` [observe: enforce なら size x${newsDecision.sizeScale}]`
            : ''
          signal = {
            ...signal,
            trace: appendTrace(
              signal.trace,
              traceStep(
                'risk.news_shock',
                !wouldReduce,
                newsDecision.ratio ?? null,
                undefined,
                undefined,
                `${newsDecision.reason}${observeNote}`,
              ),
            ),
          }
        } else if (newsDecision.sizeScale === 0) {
          const reason = `risk: ${newsDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.news_shock', false, newsDecision.ratio ?? null, '<=', null, newsDecision.reason),
            ),
          })
          continue
        } else if (newsDecision.sizeScale < 1) {
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, newsDecision.sizeScale)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${newsDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.news_shock',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${newsDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      // Last link in the VIX/news-shock multiplier chain, per symbol; a
      // symbol missing from the Map is a no-op. Unlike news shock, this
      // traces in both observe and enforce — a decision present in the Map
      // already means a warning signal fired, so visibility stays consistent either way.
      const extendedHoursGateOpt = options.extendedHoursGate
      const extendedHoursDecision = extendedHoursGateOpt?.decisions.get(upper)
      if (extendedHoursGateOpt && extendedHoursDecision) {
        const isObserve = extendedHoursGateOpt.mode === 'observe'
        const observeNote = isObserve
          ? ` [observe: enforce なら ${extendedHoursDecision.action === 'block_entry' ? 'BUY 停止' : `size x${extendedHoursDecision.multiplier}`}]`
          : ''
        signal = {
          ...signal,
          trace: appendTrace(
            signal.trace,
            traceStep(
              'risk.extended_hours',
              false,
              extendedHoursDecision.multiplier,
              undefined,
              undefined,
              `${extendedHoursDecision.reason}${observeNote}`,
            ),
          ),
        }
        if (!isObserve && extendedHoursDecision.action === 'block_entry') {
          const reason = `risk: ${extendedHoursDecision.reason}`
          summary.holds += 1
          await emitDecision({
            symbol: upper,
            decision: 'HOLD',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: signal.trace,
          })
          continue
        }
        if (!isObserve && extendedHoursDecision.action === 'reduce_entry') {
          scaledQuantity = applySizeScale(scaledQuantity, resolvedLotSize, extendedHoursDecision.multiplier)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${extendedHoursDecision.reason} (qty rounded to 0, lot=${resolvedLotSize})`
            summary.holds += 1
            await emitDecision({
              symbol: upper,
              decision: 'HOLD',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.extended_hours',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${extendedHoursDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = scaledQuantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${scaledQuantity}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      intent = buildIntent(upper, 'BUY', scaledQuantity, indicators.price)
    } else {
      if (state.position === null) {
        const reason = 'SELL without position'
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.sell_position_exists', false, false, 'exists', true)),
        })
        continue
      }
      if (!Number.isFinite(state.position.qty) || state.position.qty <= 0) {
        const reason = `invalid position qty: ${state.position.qty}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.position_qty_valid', false, state.position.qty, '>', 0)),
        })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = state.position.qty * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${state.position.qty}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      // Defensive re-check: signal.quantity should already be clamped, but a
      // broken value here SKIPs rather than falling back to a full close —
      // never submit an unintended quantity.
      if (cashRebalancePartialSell) {
        if (
          !Number.isInteger(signal.quantity) ||
          signal.quantity <= 0 ||
          signal.quantity > state.position.qty
        ) {
          const reason = `invalid cash rebalance sell qty: ${signal.quantity} (position ${state.position.qty})`
          summary.rejected.push({ symbol: upper, reason })
          await emitDecision({
            symbol: upper,
            decision: 'SKIP',
            reason,
            price: indicators.price,
            trace: appendTrace(
              signal.trace,
              traceStep('scheduler.sell_qty_valid', false, signal.quantity, '<=', state.position.qty),
            ),
          })
          continue
        }
      }
      intent = buildIntent(
        upper,
        'SELL',
        cashRebalancePartialSell ? signal.quantity : state.position.qty,
        indicators.price,
      )
    }

    // BUY only — never blocks an exit.
    if (options.earningsGate && intent.side === 'BUY') {
      const evalDate = now().toISOString().slice(0, 10)
      const earningsDecision = await evaluateEarningsGate(
        { symbol: upper, evalDate, side: 'BUY' },
        options.earningsGate.repo,
        { freezeBusinessDays: options.earningsGate.freezeBusinessDays ?? 1 },
      )
      if (!earningsDecision.approved) {
        const reason = `risk: ${earningsDecision.reason ?? 'earnings_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.earnings_calendar', false, undefined, undefined, undefined, earningsDecision.reason),
          ),
        })
        continue
      }
    }

    // Evaluated after earningsGate, so an earnings reject wins when both would fire.
    if (options.macroEventGate && intent.side === 'BUY') {
      const evalTimestamp = now().toISOString()
      const macroDecision = await evaluateMacroEventGate(
        { evalTimestamp, side: 'BUY' },
        options.macroEventGate.repo,
        { ...DEFAULT_MACRO_GATE_CONFIG, ...(options.macroEventGate.config ?? {}) },
      )
      if (!macroDecision.approved) {
        const reason = `risk: ${macroDecision.reason ?? 'macro_event_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.macro_event', false, undefined, undefined, undefined, macroDecision.reason),
          ),
        })
        continue
      }
    }

    // Pre-fetched only for BUY: evaluatePerSymbolRisk is a sync pure function and needs the inverse pair's SymbolState in hand.
    if (options.perSymbolRisk) {
      let inverseState: SymbolState | null = null
      const inverseSymbol =
        intent.side === 'BUY' ? options.perSymbolRisk.inversePairs[upper] : undefined
      if (inverseSymbol) {
        try {
          inverseState = await options.positionStore.getState(inverseSymbol)
        } catch {
          // Fails open on fetch failure: blocking the BUY here could
          // cascade-reject the whole universe; defer to the other gates instead.
          inverseState = null
        }
      }
      const riskDecision = evaluatePerSymbolRisk(
        {
          symbol: upper,
          side: intent.side,
          intentPrice: intent.price,
          intentNotional: intent.notional,
          state,
          inverseState,
          now: now(),
        },
        {
          inversePairs: options.perSymbolRisk.inversePairs,
          spreadLimits: options.perSymbolRisk.spreadLimits,
          staleQuoteMs: options.perSymbolRisk.staleQuoteMs,
          gapRejectPct: options.perSymbolRisk.gapRejectPct,
          // Cash rebalance / intraday close override `signal` after decide(),
          // so a BUY can reach here without having gone through Strategy's
          // own cooldown check. SELL is never gated (an exit must not be blocked by cooldown).
          evaluateCooldown: intent.side === 'BUY',
        },
      )
      if (!riskDecision.approved) {
        const reason = `risk: ${riskDecision.reasons.join(', ')}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('risk.per_symbol_gate', false, undefined, undefined, undefined, riskDecision.reasons.join(', '))),
        })
        continue
      }
    }

    // The ledger is decremented only after a successful submit, below; the loop is sequential so this check→commit stays consistent.
    if (intent.side === 'BUY' && options.buyingPower) {
      const ledger = options.buyingPower
      const notionalJpy = intent.notional * (options.fxJpyPerSymbolCcy ?? 1)
      const insufficient = ledger.status !== 'ok' || notionalJpy > ledger.remainingJpy
      if (insufficient) {
        const reason =
          ledger.status !== 'ok'
            ? `risk: buying-power unavailable (${ledger.reason ?? 'fetch failed'})`
            : `risk: insufficient buying power (notionalJpy ${Math.round(notionalJpy)} > remaining ${Math.round(ledger.remainingJpy)})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.buying_power_pool', false, Math.round(notionalJpy), '<=', Math.round(ledger.remainingJpy), reason),
          ),
        })
        continue
      }
    }

    // Same shape as the buying-power pool gate above (JPY-convert, then check against the shared ledger's remaining room).
    if (intent.side === 'BUY' && options.exposureCap) {
      const ledger = options.exposureCap
      const notionalJpy = intent.notional * (options.fxJpyPerSymbolCcy ?? 1)
      const exceeds = ledger.status !== 'ok' || notionalJpy > ledger.remainingJpy
      if (exceeds) {
        const reason =
          ledger.status !== 'ok'
            ? `risk: portfolio exposure cap unavailable (${ledger.reason ?? 'unknown'})`
            : `risk: portfolio exposure cap (notionalJpy ${Math.round(notionalJpy)} > remaining ${Math.round(ledger.remainingJpy)} of ceiling ${Math.round(ledger.ceilingJpy)})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'SKIP',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.portfolio_exposure_cap', false, Math.round(notionalJpy), '<=', Math.round(ledger.remainingJpy), reason),
          ),
        })
        continue
      }
    }

    const expiresAtMs = now().getTime() + pendingLockTtlMs
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      const reason = `invalid expiresAt computed from pendingLockTtlMs: ${pendingLockTtlMs}`
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_expiry_valid', false, expiresAtMs, '>', now().getTime())),
      })
      continue
    }
    const lockResult = await options.positionStore.lockPendingOrder(upper, {
      clientOrderId: intent.clientOrderId,
      side: intent.side,
      submittedAt: now().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
    if (!lockResult.ok) {
      const reason = 'pending order already in flight'
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'SKIP',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_acquired', false, false, '==', true)),
      })
      continue
    }

    // Without this, cron orders bypass trade_journal entirely and are
    // invisible to reconcileFills. Logging is isolated in its own try/catch —
    // if the D1 write throws, execution + pending-lock release must still
    // proceed, otherwise the lock leaks and the symbol gets stuck.
    try {
      logPreSubmit({ clientOrderId: intent.clientOrderId, intent })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_pre_submit_failed',
          symbol: upper,
          clientOrderId: intent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    let result: ExecutionResult | undefined
    let executedIntent: OrderIntent = intent
    let fallbackApplied = false
    const startedAt = Date.now()
    try {
      result = await options.execution.execute(intent)
    } catch (error) {
      // Excludes a cash-rebalance partial SELL: the success-path reset to
      // qty=0 below assumes the intended SELL was a full close, and applying
      // it to a deliberately partial SELL would erase a position that's
      // still genuinely held. A partial SELL that hits SELL_QTY_EXCEED falls
      // through to the normal ERROR/REJECT path instead (fail-closed, no position change).
      const fallbackResult =
        intent.side === 'SELL' &&
        !cashRebalancePartialSell &&
        options.sellFallback &&
        isSellQtyExceedError(error)
          ? await tryFallbackSell({
              originalIntent: intent,
              error,
              upper,
              symbol,
              execution: options.execution,
              positionStore: options.positionStore,
              sellFallback: options.sellFallback,
              requestId: options.requestId,
            })
          : null
      if (fallbackResult) {
        result = fallbackResult.result
        executedIntent = fallbackResult.intent
        fallbackApplied = true
      } else {
        await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
        summary.errors.push({
          symbol: upper,
          message: messageOf(error),
        })
        // A broker 4xx (except 429) is a definitive reject → REJECT. 429 is
        // a transient failure retry can resolve; everything else (5xx,
        // network, unknown cause) stays ERROR.
        const brokerStatus = error instanceof BrokerRequestError ? error.brokerStatus : undefined
        const isBrokerReject =
          brokerStatus !== undefined && brokerStatus >= 400 && brokerStatus < 500 && brokerStatus !== 429
        await emitDecision({
          symbol: upper,
          decision: isBrokerReject ? 'REJECT' : 'ERROR',
          // The order details go after the message, not before — localizeReason
          // prefix-matches `^broker submit error: ` and a leading insert would break it.
          reason: `broker submit error: ${messageOf(error)} [${describeOrderAmount(intent, options.fxJpyPerSymbolCcy)}]`,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('broker.submit', false, messageOf(error), '==', 'submitted')),
        })
        emitNotify({
          type: 'ERROR',
          symbol: upper,
          message: messageOf(error),
          // The surge detector buckets by cause into 4xx/429/5xx/other.
          cause: classifyBrokerErrorCause(error) ?? 'broker submit',
        })
        // Only BUY stops on a permanent per-ticker deny (fail-closed, retry
        // won't help); SELL is excluded to avoid orphaning a held position.
        if (intent.side === 'BUY' && options.onTickerDeny && isTickerDenyError(error)) {
          await options.onTickerDeny(upper)
        }
        try {
          logPostSubmit({
            clientOrderId: intent.clientOrderId,
            symbol: upper,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        } catch (logError) {
          console.error(
            JSON.stringify({
              event: 'cron_log_post_submit_failed',
              symbol: upper,
              clientOrderId: intent.clientOrderId,
              message: logError instanceof Error ? logError.message : String(logError),
            }),
          )
        }
        continue
      }
    }

    try {
      logPostSubmit({
        clientOrderId: executedIntent.clientOrderId,
        symbol: upper,
        result,
        latencyMs: Date.now() - startedAt,
      })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_post_submit_failed',
          symbol: upper,
          clientOrderId: executedIntent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    // DO state lies above broker truth (the reason we hit the fallback).
    // Force-reset position=null instead of `recordFill`, which would leave
    // a non-zero remainder from executed qty < DO qty.
    if (fallbackApplied) {
      try {
        await options.positionStore.overridePosition(upper, {
          qty: 0,
          avgPrice: 0,
          openedAt: null,
          reason: `sell_qty_fallback: closed at broker available qty (originalIntentQty=${intent.quantity}, executedQty=${executedIntent.quantity})`,
          requestId: options.requestId ?? null,
        })
      } catch (resetError) {
        console.error(
          JSON.stringify({
            event: 'sell_qty_fallback_reset_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: resetError instanceof Error ? resetError.message : String(resetError),
          }),
        )
      }
    }

    // Increment counters only after successful execution.
    if (executedIntent.side === 'BUY') {
      summary.buys += 1
      // Decrements the shared ledger for the executed BUY so the next symbol's pool check sees it.
      options.buyingPower?.tryReserve(intent.notional * (options.fxJpyPerSymbolCcy ?? 1))
      options.exposureCap?.tryReserve(intent.notional * (options.fxJpyPerSymbolCcy ?? 1))
    } else {
      summary.sells += 1
    }
    await emitDecision({
      symbol: upper,
      decision: executedIntent.side,
      reason: fallbackApplied
        ? `sell_qty_fallback: ${signal.reason} (originalQty=${intent.quantity}, executedQty=${executedIntent.quantity})`
        : signal.reason,
      price: executedIntent.price,
      indicatorsJson: JSON.stringify(indicators),
      clientOrderId: executedIntent.clientOrderId,
      trace: appendTrace(
        signal.trace,
        traceStep('broker.submit', true, result.mode, '==', 'submitted'),
        ...(fallbackApplied
          ? [
              traceStep(
                'broker.sell_qty_fallback',
                true,
                executedIntent.quantity,
                '==',
                intent.quantity,
                'broker available qty で再 submit',
              ),
            ]
          : []),
      ),
      order: {
        side: executedIntent.side,
        quantity: executedIntent.quantity,
        notional: executedIntent.notional,
      },
    })

    // A SELL with no avgPrice should already be rejected above; this guard is defensive.
    // Nets the same way as `reconcileFills` — mixing gross and net would make the two unreconcilable.
    const realizedPnl =
      executedIntent.side === 'SELL' && state.position && Number.isFinite(state.position.avgPrice)
        ? netRealizedPnl({
            avgPrice: state.position.avgPrice,
            exitPrice: executedIntent.price,
            quantity: executedIntent.quantity,
            config: options.tradeCost ?? NO_TRADE_COST,
          }).net
        : undefined
    emitNotify({
      type: 'TRADE',
      side: executedIntent.side,
      symbol: upper,
      qty: executedIntent.quantity,
      price: executedIntent.price,
      ...(realizedPnl !== undefined ? { realizedPnl } : {}),
      mode: result.mode,
    })

    if (result.mode === 'DRY_RUN') {
      // No broker event will clear the lock; release it eagerly.
      await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
    }
  }

  return summary
}

/**
 * SELL_QTY_EXCEED fallback inner. Returns the successful execution result
 * + the (possibly resized) intent that was actually submitted. Returns
 * `null` when the fallback can't or shouldn't run — the caller treats
 * `null` as "go re-throw the original error path".
 *
 * Conservative invariants:
 *   - `available <= 0` → null (nothing to sell, original 417 stands)
 *   - `available >= intent.quantity` → null (broker truth >= our intent;
 *     the 417 was unexpected and we shouldn't paper over it)
 *   - retry submit throws → null (don't substitute a different error)
 *   - resolver throws / returns NaN → null
 *
 * The successful path emits one structured `sell_qty_fallback_submitted`
 * audit log so the run is reconstructable from log tail. clientOrderId is
 * regenerated for the retry so it doesn't collide with the original
 * (rejected) submission's idempotency key.
 */
async function tryFallbackSell(args: {
  originalIntent: OrderIntent
  error: unknown
  upper: string
  symbol: string
  execution: Execution
  positionStore: PositionStore
  sellFallback: SellFallbackConfig
  requestId?: string
}): Promise<{ result: ExecutionResult; intent: OrderIntent } | null> {
  let available: number | null
  try {
    available = await args.sellFallback.getAvailableQty(args.upper)
  } catch (resolverErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_resolver_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        message: resolverErr instanceof Error ? resolverErr.message : String(resolverErr),
      }),
    )
    return null
  }
  if (available === null || !Number.isFinite(available) || available <= 0) {
    return null
  }
  if (available >= args.originalIntent.quantity) {
    // Broker-reported qty already covers the original SELL, so the 417 must
    // be something else (transient/race/bug) — don't fabricate a reduced SELL.
    return null
  }
  const fallbackIntent: OrderIntent = {
    ...args.originalIntent,
    quantity: available,
    notional: available * args.originalIntent.price,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
  try {
    const result = await args.execution.execute(fallbackIntent)
    console.log(
      JSON.stringify({
        event: 'sell_qty_fallback_submitted',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        originalQty: args.originalIntent.quantity,
        fallbackQty: fallbackIntent.quantity,
        price: fallbackIntent.price,
      }),
    )
    return { result, intent: fallbackIntent }
  } catch (retryErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_retry_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        message: retryErr instanceof Error ? retryErr.message : String(retryErr),
      }),
    )
    return null
  }
}

function buildIntent(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): OrderIntent {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`buildIntent: invalid qty=${qty} for ${symbol}`)
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`buildIntent: invalid price=${price} for ${symbol}`)
  }
  const notional = qty * price
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error(`buildIntent: invalid notional=${notional} for ${symbol} (qty=${qty}, price=${price})`)
  }
  return {
    symbol,
    side,
    quantity: qty,
    price,
    notional,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RegimeBySymbol = Map<string, { decision: PairRegimeDecision; side: 'bull' | 'bear' }>

/**
 * Evaluates each configured pair once per run and fans the decision out to
 * both legs. A fetch/eval failure is isolated to that one pair as
 * zone='unknown' (fail-closed under enforce) instead of aborting the run.
 */
async function evaluatePairRegimesForRun(
  pairRegimeOption: NonNullable<PullbackSchedulerOptions['pairRegime']>,
  symbols: string[],
  barClient: BarClient,
  now: Date,
  requestId: string | undefined,
): Promise<RegimeBySymbol> {
  const regimeBySymbol: RegimeBySymbol = new Map()
  const runSymbols = new Set(symbols.map((s) => s.toUpperCase()))
  const relevant = pairRegimeOption.pairs.filter(
    (p) => runSymbols.has(p.bullSymbol) || runSymbols.has(p.bearSymbol),
  )
  // Evaluated in parallel; applied to the map in array order afterward so a
  // duplicate symbol's winner doesn't depend on async completion order.
  const evaluated = await Promise.all(
    relevant.map(async (pair) => {
      let decision: PairRegimeDecision
      if (pair.invalidConfig !== null) {
        decision = {
          zone: 'unknown',
          score: null,
          proxySymbol: pair.proxySymbol,
          asOfDate: null,
          reason: `misconfig: ${pair.invalidConfig}`,
        }
      } else {
        try {
          const proxyBars = await barClient.getDailyBars(pair.proxySymbol, PAIR_REGIME_PROXY_BAR_LOOKBACK)
          decision = evaluatePairRegime(proxyBars, {
            proxySymbol: pair.proxySymbol,
            thresholds: pairRegimeOption.thresholds,
            now,
          })
        } catch (err) {
          decision = {
            zone: 'unknown',
            score: null,
            proxySymbol: pair.proxySymbol,
            asOfDate: null,
            reason: `proxy bars fetch failed: ${messageOf(err)}`,
          }
        }
      }
      return { pair, decision }
    }),
  )
  for (const { pair, decision } of evaluated) {
    // A symbol appearing in more than one pair config can't be resolved deterministically — fail closed to unknown.
    const duplicate = [pair.bullSymbol, pair.bearSymbol].find((sym) => regimeBySymbol.has(sym))
    if (duplicate !== undefined) {
      const dup: PairRegimeDecision = {
        zone: 'unknown',
        score: null,
        proxySymbol: pair.proxySymbol,
        asOfDate: null,
        reason: `duplicate pair config for ${duplicate} (fail-closed)`,
      }
      regimeBySymbol.set(pair.bullSymbol, { decision: dup, side: 'bull' })
      regimeBySymbol.set(pair.bearSymbol, { decision: dup, side: 'bear' })
      const prev = regimeBySymbol.get(duplicate)!
      regimeBySymbol.set(duplicate, { decision: dup, side: prev.side })
    } else {
      regimeBySymbol.set(pair.bullSymbol, { decision, side: 'bull' })
      regimeBySymbol.set(pair.bearSymbol, { decision, side: 'bear' })
    }
    console.warn(
      JSON.stringify({
        event: 'pair_regime_evaluated',
        requestId: requestId ?? null,
        mode: pairRegimeOption.mode,
        pair: `${pair.bullSymbol}/${pair.bearSymbol}`,
        proxySymbol: decision.proxySymbol,
        zone: regimeBySymbol.get(pair.bullSymbol)!.decision.zone,
        score: decision.score,
        asOfDate: decision.asOfDate,
        reason: regimeBySymbol.get(pair.bullSymbol)!.decision.reason,
      }),
    )
  }
  return regimeBySymbol
}

/** One retry for a transient upstream blip; without it, a held symbol's exit evaluation would be skipped entirely. Throws the second error if both attempts fail. */
async function fetchDailyBarsWithRetry(
  barClient: BarClient,
  symbol: string,
  lookback: number,
): Promise<DailyBar[]> {
  try {
    return await barClient.getDailyBars(symbol, lookback)
  } catch {
    return await barClient.getDailyBars(symbol, lookback)
  }
}

/** Human-readable order amount: USD symbols show $ and ¥, JPY symbols (fx=1) show ¥ only, unknown fx shows no currency symbol. */
function describeOrderAmount(intent: OrderIntent, fxJpyPerSymbolCcy: number | undefined): string {
  const { quantity: qty, price: px, notional } = intent
  const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`
  if (fxJpyPerSymbolCcy !== undefined && Number.isFinite(fxJpyPerSymbolCcy) && fxJpyPerSymbolCcy > 0) {
    if (fxJpyPerSymbolCcy === 1) {
      return `発注内容: ${qty}口 @ ${yen(px)} = ${yen(notional)}`
    }
    return `発注内容: ${qty}口 @ $${px} = $${notional.toFixed(2)} ≈ ${yen(notional * fxJpyPerSymbolCcy)} (USD/JPY ${fxJpyPerSymbolCcy})`
  }
  return `発注内容: ${qty}口 @ ${px} = ${notional} (通貨不明)`
}

/** Shared by the VIX / news-shock / half-entry gates: scales `qty` and floors to a lot; the caller rejects a result of 0. */
function applySizeScale(qty: number, lot: number, scale: number): number {
  const raw = qty * scale
  return lot > 1 ? Math.floor(raw / lot) * lot : Math.floor(raw)
}

/**
 * Cash-rebalance BUY override: replaces the signal with a fixed-quantity
 * BUY toward active weight, unless a strategy exit / cooldown / re-entry
 * guard already applies. Those aren't bypassed — skipping them would let
 * cash rebalance whipsaw-buy back the same tick a time-stop SELLs.
 */
function applyCashRebalanceBuyOverride(
  signal: Signal,
  cashRebalanceQty: number | undefined,
  state: SymbolState,
  strategy: PullbackUptrendStrategy,
  upper: string,
  reentryBusinessDaysSinceExit: number | null,
  nowMs: number,
): Signal {
  if (cashRebalanceQty === undefined || state.pendingOrder !== null) return signal
  if (!Number.isInteger(cashRebalanceQty) || cashRebalanceQty <= 0) return signal

  const cooldownUntilMs = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : NaN
  const cooldownActive = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs
  const guardDays = strategy.resolveRule(upper).reentryGuardBusinessDays
  const reentryGuardActive =
    state.position === null &&
    state.lastExitAt !== null &&
    Number.isFinite(guardDays) &&
    guardDays > 0 &&
    reentryBusinessDaysSinceExit !== null &&
    reentryBusinessDaysSinceExit < guardDays

  let skipWhy: string | null = null
  if (signal.action === 'SELL') {
    skipWhy = 'strategy exit takes precedence'
  } else if (cooldownActive) {
    skipWhy = `cooldown active until ${state.cooldownUntil}`
  } else if (reentryGuardActive) {
    skipWhy = `re-entry guard window (${reentryBusinessDaysSinceExit}bd < ${guardDays}bd since exit)`
  }

  if (skipWhy !== null) {
    return {
      ...signal,
      reason: `${signal.reason}; cash rebalance skipped: ${skipWhy}`,
      trace: appendTrace(signal.trace, traceStep('entry.cash_rebalance', false, cashRebalanceQty, '>', 0, skipWhy)),
    }
  }
  return {
    ...signal,
    action: 'BUY',
    quantity: cashRebalanceQty,
    reason: `cash allocation rebalance: buy ${cashRebalanceQty} toward active weight (#452)`,
    trace: appendTrace(
      signal.trace,
      traceStep('entry.cash_rebalance', true, cashRebalanceQty, '>', 0, 'conditional allocation cash rebalance (#452)'),
    ),
  }
}

/**
 * Cash-rebalance partial-SELL override. Never overrides a strategy exit
 * already in `signal` — a full close there takes precedence.
 */
function applyCashRebalanceSellOverride(
  signal: Signal,
  cashRebalanceSellQty: number | undefined,
  state: SymbolState,
): { signal: Signal; cashRebalancePartialSell: boolean } {
  if (
    cashRebalanceSellQty === undefined ||
    state.pendingOrder !== null ||
    !Number.isInteger(cashRebalanceSellQty) ||
    cashRebalanceSellQty <= 0
  ) {
    return { signal, cashRebalancePartialSell: false }
  }
  if (signal.action === 'SELL') {
    return {
      signal: {
        ...signal,
        trace: appendTrace(
          signal.trace,
          traceStep('exit.cash_rebalance', false, cashRebalanceSellQty, '>', 0, 'strategy exit takes precedence'),
        ),
      },
      cashRebalancePartialSell: false,
    }
  }
  if (state.position === null || state.position.qty <= 0) {
    return {
      signal: {
        ...signal,
        trace: appendTrace(
          signal.trace,
          traceStep('exit.cash_rebalance', false, cashRebalanceSellQty, '>', 0, 'no position'),
        ),
      },
      cashRebalancePartialSell: false,
    }
  }
  const qty = Math.min(cashRebalanceSellQty, state.position.qty)
  return {
    signal: {
      ...signal,
      action: 'SELL',
      quantity: qty,
      reason: `cash allocation rebalance: sell ${qty} toward active weight (#452)`,
      trace: appendTrace(
        signal.trace,
        traceStep('exit.cash_rebalance', true, qty, '>', 0, 'conditional allocation cash rebalance sell (#452)'),
      ),
    },
    cashRebalancePartialSell: true,
  }
}

/** Forces a full SELL for a held intraday-only US symbol inside the pre-close window (leveraged-ETF open-gap stop-out avoidance). */
function applyIntradayForceCloseOverride(
  signal: Signal,
  cashRebalancePartialSell: boolean,
  isIntradayOnly: boolean,
  market: TradingMarket,
  state: SymbolState,
  nowDate: Date,
): { signal: Signal; cashRebalancePartialSell: boolean } {
  const shouldForceClose =
    isIntradayOnly &&
    market === 'US' &&
    state.position !== null &&
    Number.isFinite(state.position.qty) &&
    state.position.qty > 0 &&
    isWithinUsCloseWindow(nowDate, INTRADAY_CLOSE_WINDOW_MIN)
  if (!shouldForceClose) return { signal, cashRebalancePartialSell }
  return {
    signal: {
      ...signal,
      action: 'SELL',
      reason: 'intraday-only: force-close before US market close',
      trace: appendTrace(
        signal.trace,
        traceStep('exit.intraday_close', true, undefined, undefined, undefined, 'force-close before US close'),
      ),
    },
    // Always a full close, even if cash rebalance had already queued a partial SELL.
    cashRebalancePartialSell: false,
  }
}

/**
 * Traces the pair-regime zone/score on every evaluation (including HOLD,
 * for observe-mode audit) and, in enforce mode, force-SELLs a position held
 * against a zone flip. A flip always means a full close, so it also clears
 * `cashRebalancePartialSell` even if a partial SELL was already queued.
 */
function applyPairRegimeOverride(
  signal: Signal,
  cashRebalancePartialSell: boolean,
  regime: { decision: PairRegimeDecision; side: 'bull' | 'bear' } | undefined,
  pairRegimeOption: NonNullable<PullbackSchedulerOptions['pairRegime']>,
  state: SymbolState,
): { signal: Signal; cashRebalancePartialSell: boolean } {
  if (!regime) return { signal, cashRebalancePartialSell }
  const d = regime.decision
  const allowed = (regime.side === 'bull' && d.zone === 'bull') || (regime.side === 'bear' && d.zone === 'bear')
  const held = state.position !== null && Number.isFinite(state.position.qty) && state.position.qty > 0
  const observeNote =
    pairRegimeOption.mode === 'observe' && !allowed && signal.action === 'BUY' ? ' [observe: enforce なら SKIP]' : ''
  const neutralHoldNote =
    held && d.zone === 'neutral' ? ' [hold_existing_position: neutral_does_not_force_exit]' : ''
  let nextSignal: Signal = {
    ...signal,
    trace: appendTrace(
      signal.trace,
      traceStep(
        'regime.zone',
        allowed,
        d.score,
        undefined,
        undefined,
        `${d.reason} side=${regime.side} mode=${pairRegimeOption.mode}${observeNote}${neutralHoldNote}`,
      ),
    ),
  }
  const flipped = (regime.side === 'bull' && d.zone === 'bear') || (regime.side === 'bear' && d.zone === 'bull')
  let nextCashRebalancePartialSell = cashRebalancePartialSell
  // neutral never forces an exit — a normal pullback inside hysteresis shouldn't drop the position.
  if (pairRegimeOption.mode === 'enforce' && held && flipped) {
    nextCashRebalancePartialSell = false
    if (nextSignal.action === 'SELL') {
      nextSignal = {
        ...nextSignal,
        trace: appendTrace(
          nextSignal.trace,
          traceStep(
            'exit.regime_flip_secondary',
            true,
            undefined,
            undefined,
            undefined,
            `secondaryExitReasons: regime_flip (${d.reason})`,
          ),
        ),
      }
    } else {
      nextSignal = {
        ...nextSignal,
        action: 'SELL',
        reason: `pair regime flip: zone=${d.zone} against held ${regime.side} side (${d.reason})`,
        trace: appendTrace(
          nextSignal.trace,
          traceStep('exit.regime_flip', true, d.score, undefined, undefined, d.reason),
        ),
      }
    }
  }
  return { signal: nextSignal, cashRebalancePartialSell: nextCashRebalancePartialSell }
}

/**
 * HALF (0.5x) entry promotion. Trusts the strategy's own `holdCause` /
 * `entryStatus` rather than re-deriving entry status from indicators —
 * recomputing would also promote a re-entry-guard HOLD, which isn't part of
 * the gate set HALF is meant to loosen. The position/pendingOrder/cooldown
 * checks are a belt-and-suspenders re-check of what holdCause==='entry_gate'
 * already guarantees, against a future strategy implementation bug.
 */
function applyHalfEntryPromotion(
  signal: Signal,
  isHalfEntryEligible: boolean,
  state: SymbolState,
  nowMs: number,
): { signal: Signal; positionMultiplier: number } {
  const entryStatus = signal.entryStatus
  const eligible =
    signal.action === 'HOLD' &&
    signal.holdCause === 'entry_gate' &&
    isHalfEntryEligible &&
    entryStatus?.status === 'HALF' &&
    entryStatus.halfGate !== null &&
    state.position === null &&
    state.pendingOrder === null &&
    !(state.cooldownUntil && new Date(state.cooldownUntil).getTime() > nowMs)
  if (!eligible || !entryStatus) return { signal, positionMultiplier: 1 }
  const gate = entryStatus.halfGate!
  return {
    positionMultiplier: entryStatus.positionMultiplier,
    signal: {
      ...signal,
      action: 'BUY',
      reason: `half entry (0.5x): ${gate.key} ${gate.actual.toFixed(4)} near threshold ${gate.threshold} (within tolerance band)`,
      trace: appendTrace(
        signal.trace,
        traceStep(
          'entry.half_status',
          true,
          gate.actual,
          // DecisionTraceStep's operator union only has '<=' / '>='.
          gate.operator === '>=' ? '>=' : '<=',
          gate.threshold,
          'HALF: single degree-gate miss within tolerance → 0.5x sizing (#452)',
        ),
      ),
    },
  }
}

/**
 * Vetoes a new BUY within `INTRADAY_NO_ENTRY_WINDOW_MIN` of US close for an
 * intraday-only symbol. Must run after HALF promotion, not before — HALF
 * can promote a HOLD to BUY, and vetoing first would leave that
 * promotion unblocked.
 */
function applyIntradayNoEntryVeto(
  signal: Signal,
  isIntradayOnly: boolean,
  market: TradingMarket,
  nowDate: Date,
): Signal {
  const shouldVeto =
    isIntradayOnly && market === 'US' && signal.action === 'BUY' && isWithinUsCloseWindow(nowDate, INTRADAY_NO_ENTRY_WINDOW_MIN)
  if (!shouldVeto) return signal
  return {
    ...signal,
    action: 'HOLD',
    holdCause: 'guard',
    reason: 'intraday-only: no new entry within 30min of US close',
    trace: appendTrace(
      signal.trace,
      traceStep(
        'entry.intraday_no_entry',
        false,
        undefined,
        undefined,
        undefined,
        'intraday-only: no new entry within 30min of US close',
      ),
    ),
  }
}

function appendTrace(
  trace: DecisionTraceStep[] | undefined,
  ...steps: DecisionTraceStep[]
): DecisionTraceStep[] {
  return [...(trace ?? []), ...steps]
}

function traceStep(
  label: string,
  passed: boolean,
  actual?: DecisionTraceStep['actual'],
  operator?: DecisionTraceStep['operator'],
  threshold?: DecisionTraceStep['threshold'],
  message?: string,
): DecisionTraceStep {
  return {
    label,
    label_ja: labelJa(label),
    passed,
    ...(actual !== undefined ? { actual } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(message !== undefined ? { message } : {}),
  }
}

function labelJa(label: string): string {
  return TRACE_LABEL_JA[label] ?? label
}

const TRACE_LABEL_JA: Record<string, string> = {
  'sizing.quantity_positive': '買付余力が1株/1単元以上ある',
  'sizing.lot_size_configured': '売買単位 (lot_size) が設定済み',
  'exit.intraday_close': 'intraday-only 引け前強制クローズ',
  'scheduler.price_valid': '株価が有効',
  'scheduler.notional_valid': '発注金額が有効',
  'scheduler.sell_position_exists': '売却対象の保有がある',
  'scheduler.position_qty_valid': '保有数量が有効',
  'scheduler.pending_lock_expiry_valid': '注文ロック期限が有効',
  'scheduler.pending_lock_acquired': '注文ロックを取得できた',
  'risk.earnings_calendar': '決算日カレンダーゲート',
  'risk.macro_event': 'マクロイベントゲート',
  'risk.per_symbol_gate': '銘柄別リスクゲート',
  'risk.vix_regime': 'VIX レジーム判定',
  'risk.news_shock': 'ニュース過熱ゲート',
  'risk.extended_hours': '時間外 (プレマーケット) 警戒ゲート',
  'risk.role_entry_suppressed': 'ロール entry 抑止 (#452)',
  'entry.half_status': '段階判定 HALF (0.5x、#452)',
  'entry.cash_rebalance': '条件連動配分 cash rebalance (#452)',
  'exit.cash_rebalance': '条件連動配分 cash rebalance SELL (#452 follow-up)',
  'scheduler.sell_qty_valid': 'SELL 数量が保有数量以下の正整数',
  'regime.zone': 'ペアレジーム判定 (#472)',
  'risk.pair_regime': 'ペアレジーム gate (#472)',
  'exit.regime_flip': 'レジーム反転 exit (#472)',
  'exit.regime_flip_secondary': 'レジーム反転 (副次理由、#472)',
  'sizing.half_entry_quantity_positive': 'HALF 数量が1株/1単元以上ある',
  'risk.buying_power_pool': '口座買付余力プール (発注前)',
  'risk.portfolio_exposure_cap': 'ポートフォリオ全体エクスポージャー上限',
  'risk.sanity_failed_cooldown': 'sanity_failed cooldown (broker stub 疑い)',
  'broker.submit': '証券会社への発注送信',
  'broker.sell_qty_fallback': 'SELL 数量超過時の broker available qty 再 submit',
  'entry.intraday_no_entry': 'intraday-only 引け前30分の新規entry禁止',
  'data.price_as_of': '判断価格の出所・時刻',
  'risk.price_freshness': '価格鮮度ゲート (BUY のみ)',
}

/** Embeds diagnostic values per failure route — a bare `capReason` like `lot-size-round` alone doesn't show raw qty/stop/budget. `localizeReason` regex-matches this for the Japanese UI text. */
function buildSizingRejectReason(
  sizing: import('./pullbackSizing').PullbackSizingResult,
  ctx: { lotSize: number; entryPrice: number },
): string {
  const cr = sizing.capReason
  if (cr === 'lot-size-round') {
    const raw = sizing.rawQuantity ?? 0
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: lot-size-round (raw qty ${raw} < lot ${ctx.lotSize}, stop ${stop.toFixed(2)}, entry ${ctx.entryPrice})`
  }
  if (cr === 'insufficient-risk-budget') {
    const budget = sizing.riskBudget ?? 0
    return `sizing rejected: insufficient-risk-budget (budget ${budget.toFixed(2)})`
  }
  if (cr === 'invalid-stop') {
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: invalid-stop (stopDistance ${stop})`
  }
  if (cr === 'capital-unset') {
    return 'sizing rejected: capital-unset (set total_capital_usd / total_capital_jpy for risk-% sizing)'
  }
  return `sizing rejected: ${cr ?? 'zero qty'}`
}
