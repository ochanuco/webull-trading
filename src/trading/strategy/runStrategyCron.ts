import type { Env } from '../../config/env'
import { selectBarClient, type BarClient } from '../../infrastructure/quotes/BarClient'
import { loadUsdJpyRate } from '../../infrastructure/quotes/fxRate'
import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'
import {
  buyingPowerJpyFromBalance,
  createBuyingPowerLedger,
  createUnavailableBuyingPowerLedger,
  type BuyingPowerLedger,
} from './buyingPower'
import {
  createExposureLedger,
  createUnavailableExposureLedger,
  type ExposureLedger,
} from './exposureLedger'
import type { PositionStore } from '../state/PositionStore'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import { notifyBrokerErrorSurgeIfChanged } from '../../infrastructure/notification/brokerErrorSurge'
import {
  detectAndNotifyConfigStateChanges,
  type WatchedConfig,
} from '../../infrastructure/notification/configStateChange'
import { createNotifier } from '../../infrastructure/notification/createNotifier'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { resolveAccessToken } from '../../infrastructure/webull/resolveAccessToken'
import { createWebullReadClient } from '../../infrastructure/webull/WebullReadClient'
import { createWebullTradeClient } from '../../infrastructure/webull/WebullTradeClient'
import { MockExecution } from '../execution/MockExecution'
import { WebullExecution } from '../execution/WebullExecution'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'
import { computeDrawdownRiskScale } from '../risk/drawdownRiskScale'
import {
  logStrategyDecision,
  strategyDecisionDbOrUndefined,
} from '../../infrastructure/logger/strategyDecisionLog'
import { hasRecentSanityFailure } from '../../infrastructure/db/tradeJournalRepo'
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
} from '../../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
} from '../../infrastructure/calendar/macroEventCalendarRepo'
import {
  evaluateVixRegime,
  type VixRegimeFilterDecision,
} from '../risk/vixRegimeFilter'
import { detectAndNotifyVixRegimeChange } from '../../infrastructure/notification/vixRegimeChange'
import { detectAndNotifyRegimeChange } from '../../infrastructure/notification/regimeChange'
import type { NewsShockGateDecision } from '../risk/newsShockGate'
import {
  buildNewsShockRegimeHeadline,
  isNewsShockGateReady,
  isNewsShockRegime,
  loadNewsShockDecision,
  NEWS_SHOCK_REGIME_RANK,
} from '../risk/newsShockDecision'
import { isExtendedHoursGateReady, loadExtendedHoursGateDecisions } from '../risk/extendedHoursGate'
import { loadHeadlineEvalSnapshot, type HeadlineEvalSnapshot } from '../news/headlineEvalSnapshot'
import { resolveTradingEnabled } from '../runtime/killSwitch'
import {
  evaluateStrategyWindow,
  isWithinRegularSession,
  type StrategyWindowVerdict,
} from '../domain/tradingCalendar'
import { runPullbackScheduler, type PullbackDecisionTrace, type PullbackRunSummary } from './pullbackScheduler'
import { BreakoutMomentumStrategy, TEST_DEFAULT_MOMENTUM_RULE } from './strategies/BreakoutMomentumStrategy'
import {
  buildEntrySuppressedSymbols,
  buildHalfEntrySymbols,
  buildMomentumRules,
  buildMomentumSymbols,
  buildSymbolRules,
} from './symbolRuleResolution'
import { createTickerDenyGuard } from '../risk/tickerDenyGuard'
import { createDb as createSymbolConfigDb } from '../../infrastructure/db/tradeJournalRepo'
import {
  buildCashFallbackSellPlan,
  buildCashRebalancePlan,
  computeConditionalAllocation,
  type AllocationView,
  type CashRebalanceOrder,
  type CashRebalanceSkip,
  type EntrySnapshot,
} from './conditionalAllocation'

// Lot size is per-symbol (symbol_config.lot_size); a missing entry fails
// closed in the scheduler rather than falling back to a blanket default.

// Blocks new BUYs on a symbol for this long after a broker stub fill
// (sanity_failed) is observed — long enough to stop a repeat-BUY chain
// within one cooldown cycle instead of only the next tick.
const SANITY_FAILED_COOLDOWN_MS = 30 * 60 * 1000

// How many minutes before market open strategy evaluation resumes when
// `sessionWindowGateEnabled` is true. Window = [open - this, close].
const PRE_OPEN_WINDOW_MIN = 30

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  /**
   * Operator/AI analysis packet. Safe for logs: no broker secrets or raw
   * Webull payloads, only config/risk context and per-symbol decisions.
   */
  analysis: StrategyCronAnalysis
  /**
   * Reason the whole run was skipped before evaluation. `portfolio_halted` /
   * `drawdown_kill` are never set here (they now only set `entryHaltReason`,
   * below) but stay in the union for existing log/dashboard readers.
   */
  skipReason?:
    | 'trading_disabled'
    | 'no_tradable_symbols'
    | 'outside_session_window'
    | 'market_holiday'
    | 'no_bridge_state'
    | 'portfolio_halted'
    | 'drawdown_kill'
  /** Risk halt reason for entry-only suppression; mutually exclusive with `skipReason` — exits still run when this is set. */
  entryHaltReason?: string
}

interface StrategyCronAnalysis {
  schema: 'strategy_cron_analysis.v1'
  generatedAt: string
  requestId?: string
  config: {
    dryRun: boolean
    tradingEnabled: boolean
    pullbackRule: {
      stopPct: number
      takeProfitPct: number
      timeStopDays: number
      pullbackMax: number
      pullbackMin: number
      minReturn50d: number
      requireAboveSma50: boolean
      kAtr: number
      maxSma50DeviationPct: number
      maxAtrRatio: number
      maxStopToTpRatio: number
    }
    risk: {
      basePerTradePct: number
      scaledPerTradePct?: number
      ddHalfThreshold: number
      ddHaltThreshold: number
      drawdownKillThreshold: number
    }
  }
  universe: {
    symbols: string[]
    byCurrency: Record<SymbolCurrency, string[]>
    symbolMaxNotional: Record<string, number>
  }
  /** Inactive symbols (`symbol_config.active = 0`) with qty>0 still held; kept out of `universe.symbols` and evaluated for exit only. */
  exitOnlySymbols: string[]
  portfolio?: {
    dailyStartEquity: number
    dailyRealizedPnl: number
    tradingDisabledUntil: string | null
    lastRolledAt: string | null
    updatedAt: string
  }
  drawdownScale?: {
    step: 'normal' | 'half' | 'halt'
    scale: number
    drawdown: number
  }
  /** Set when a risk halt is suppressing new entries only; exits still evaluate normally. Unset means normal operation. */
  entryHalt?: { reason: string }
  /** VIX regime decision derived from the latest `^VIX` close; computed once per tick and shared by both currency runs. */
  vix?: VixRegimeFilterDecision
  /** News shock gate decision; undefined when `news_shock_mode='off'` or the table isn't migrated. Computed once per tick and shared by both currency runs. */
  newsShock?: NewsShockGateDecision
  /** Latest `news_headline_eval` row visible at decision time; observe-only, never gates sizing. Computed once per tick and shared by both currency runs. */
  headlineEval?: HeadlineEvalSnapshot
  runs: Array<{
    currency: SymbolCurrency
    /** null when `total_capital_usd/jpy` is unset — risk-% sizing fails closed on capital-unset. */
    equity: number | null
    symbols: string[]
  }>
  decisions: PullbackDecisionTrace[]
  /**
   * Conditional allocation view. Target/active weight is always computed
   * regardless of `cash_fallback_orders_enabled` / `cash_fallback_sell_mode`
   * (display-only when both are off); the order plan below is gated on them.
   */
  allocation?: {
    view: AllocationView
    ordersEnabled: boolean
    sellMode: 'off' | 'observe' | 'enforce'
    rebalanceSkipped?: CashRebalanceSkip[]
  }
  /** Portfolio exposure ceiling snapshot for this tick; `unavailable` (with `reason`) means cron BUYs failed closed this tick. */
  exposure?: {
    status: 'ok' | 'unavailable'
    ceilingJpy: number
    currentJpy: number
    remainingJpy: number
    reason?: string
  }
}

/**
 * Applies portfolio-wide pre-flight risk (tradingDisabledUntil,
 * drawdown_kill) directly; per-symbol gates (spread / halt / gap / JP band /
 * inverse_pair / settled_cash) are injected into `runPullbackScheduler` via
 * `evaluatePerSymbolRisk` so cron and `TradingService` agree.
 */
export interface RunStrategyCronOptions {
  /** Correlation id for structured logs (from scheduled() handler). */
  requestId?: string
}

export async function runStrategyCron(
  env: Env,
  options: RunStrategyCronOptions = {},
): Promise<StrategyCronResult> {
  const emptySummary = (): PullbackRunSummary => ({
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
    entrySnapshots: {},
  })

  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env, options.requestId),
    loadSymbolUniverse(env),
  ])

  const effectiveTradingEnabled = resolveTradingEnabled(global.tradingEnabled, env.TRADING_ENABLED)

  // Built once here so every skipReason notify / state-change detect call
  // below shares one instance, and requestId threads through to
  // `notification_emit_log.request_id`.
  const notifier = createNotifier(env, { requestId: options.requestId })

  // Awaited so the snapshot is written before any other STATE_CHANGE path
  // this tick can fire — otherwise concurrent watchers could double-emit.
  const watchedNow: WatchedConfig = {
    dryRun: global.dryRun,
    // Effective value (post env-override) so an env.TRADING_ENABLED flip
    // itself is observed as a state change, not just the DB flag.
    tradingEnabled: effectiveTradingEnabled,
    marketHoursCheck: global.marketHoursCheck,
    sessionWindowGateEnabled: global.sessionWindowGateEnabled,
    drawdownKillThreshold: global.drawdownKillThreshold,
  }
  await detectAndNotifyConfigStateChanges({
    db: env.DB,
    notifier,
    current: watchedNow,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'config_state_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  if (env.DB) {
    await notifyBrokerErrorSurgeIfChanged({
      db: env.DB,
      notifier,
      requestId: options.requestId,
    }).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'broker_error_surge_detect_failed',
          requestId: options.requestId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  }

  const defaultRule = {
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
    maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
    // Re-entry price guard, not yet a global_config column — hard-coded
    // until tuning demand justifies a config/override path.
    reentryMinAtrBelowLastExit: 1.0,
    reentryGuardBusinessDays: 3,
  }
  // Layers global default -> role preset -> per-symbol override; see
  // symbolRuleResolution.ts for the merge order and its regression tests.
  const rulesMap = buildSymbolRules(defaultRule, universe)
  const entrySuppressedSymbols = buildEntrySuppressedSymbols(universe.symbolRole)
  const halfEntrySymbols = buildHalfEntrySymbols(universe.symbolRole)
  const momentumSymbols = buildMomentumSymbols(universe.symbolRole)
  const momentumStrategy =
    momentumSymbols.size > 0
      ? new BreakoutMomentumStrategy(TEST_DEFAULT_MOMENTUM_RULE, buildMomentumRules(universe))
      : undefined
  const pairRegimeOption =
    global.pairRegimeMode !== 'off' && universe.pairRegimes.length > 0
      ? {
          mode: global.pairRegimeMode,
          thresholds: {
            bullEnter: global.pairRegimeThetaBullEnter,
            bullExit: global.pairRegimeThetaBullExit,
            bearEnter: global.pairRegimeThetaBearEnter,
            bearExit: global.pairRegimeThetaBearExit,
          },
          pairs: universe.pairRegimes,
        }
      : undefined
  // Reporting-only split of `allowedSymbols`; run construction and the
  // window gate use `runCurrency` below, which adds exit-only symbols.
  const byCurrency: Record<SymbolCurrency, string[]> = { USD: [], JPY: [] }
  for (const sym of universe.allowedSymbols) {
    const cur = universe.symbolCurrency[sym] ?? 'USD'
    byCurrency[cur].push(sym)
  }
  // Populated below, once positionStore is available.
  const exitOnlySymbols: string[] = []
  const analysisBase = (): StrategyCronAnalysis => ({
    schema: 'strategy_cron_analysis.v1',
    generatedAt: new Date().toISOString(),
    requestId: options.requestId,
    config: {
      dryRun: global.dryRun,
      tradingEnabled: effectiveTradingEnabled,
      pullbackRule: defaultRule,
      risk: {
        basePerTradePct: global.riskBasePerTradePct,
        ddHalfThreshold: global.riskDdHalfThreshold,
        ddHaltThreshold: global.riskDdHaltThreshold,
        drawdownKillThreshold: global.drawdownKillThreshold,
      },
    },
    universe: {
      symbols: universe.allowedSymbols,
      byCurrency,
      symbolMaxNotional: universe.symbolMaxNotional,
    },
    exitOnlySymbols: [...exitOnlySymbols],
    runs: [],
    decisions: [],
  })

  // Not notified: an operator-configured off state (trading_disabled /
  // no_tradable_symbols) isn't an incident, unlike the critical skips below.
  if (!effectiveTradingEnabled) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'trading_disabled' }
  }

  // Ordered before no_tradable_symbols/window gate: exit-only symbol
  // detection below needs positionStore.
  if (!env.SYMBOL_STATE) {
    emitSkipReasonNotify(notifier, 'no_bridge_state', options.requestId, 'critical')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: 'no_bridge_state',
    }
  }
  const positionStore = new SymbolStateClient(env.SYMBOL_STATE)

  const runCurrency: Record<SymbolCurrency, string[]> = {
    USD: [...byCurrency.USD],
    JPY: [...byCurrency.JPY],
  }
  for (const sym of universe.inactiveSymbols) {
    let state: Awaited<ReturnType<typeof positionStore.getState>>
    try {
      state = await positionStore.getState(sym)
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'exit_only_state_read_failed',
          requestId: options.requestId,
          symbol: sym,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      continue
    }
    if (state.position === null || state.position.qty <= 0) continue
    exitOnlySymbols.push(sym)
    const cur = universe.symbolCurrency[sym] ?? 'USD'
    runCurrency[cur].push(sym)
    // Overrides any role-derived suppression reason: inactive is the
    // stronger, confirmed fact, role is incidental.
    entrySuppressedSymbols[sym] = 'symbol inactive: exit-only'
  }

  if (universe.allowedSymbols.length === 0 && exitOnlySymbols.length === 0) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'no_tradable_symbols' }
  }

  // `market_holiday` is kept distinct from `outside_session_window` so the
  // skip reason itself tells an operator which case they're looking at,
  // instead of a generic "outside window" that could mean either.
  const sessionNow = new Date()
  const windowVerdicts: StrategyWindowVerdict[] = []
  const activeCurrencies = new Set<SymbolCurrency>(
    (['USD', 'JPY'] as const).filter((cur) => {
      if (runCurrency[cur].length === 0) return false
      if (!global.sessionWindowGateEnabled) return true
      const verdict = evaluateStrategyWindow(
        sessionNow,
        cur === 'JPY' ? 'JP' : 'US',
        PRE_OPEN_WINDOW_MIN,
      )
      windowVerdicts.push(verdict)
      return verdict === 'in_window'
    }),
  )
  if (global.sessionWindowGateEnabled && activeCurrencies.size === 0) {
    // `market_holiday` only when every evaluated market is on holiday; a
    // holiday/window-outage mix falls back to the generic label since
    // "holiday" alone wouldn't explain the mixed case.
    const allHoliday =
      windowVerdicts.length > 0 && windowVerdicts.every((v) => v === 'market_holiday')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: allHoliday ? 'market_holiday' : 'outside_session_window',
    }
  }

  // Portfolio-level pre-flight failures below suppress entry only, not the
  // whole run: stop/TP/time-stop is a soft stop cron re-evaluates every
  // tick, not a broker-side resting order, so a full halt here would strip
  // held positions of their only protection during the most volatile
  // moments — exactly when drawdown_kill (realized-PnL based) tends to fire,
  // right after a stop already triggered.
  let entryHaltReason: string | null = null
  const portfolioStore = env.PORTFOLIO_STATE ? new PortfolioStateClient(env.PORTFOLIO_STATE) : null
  let portfolioSnapshot: Awaited<ReturnType<PortfolioStateClient['getPortfolio']>> | null = null
  let analysis = analysisBase()
  if (!portfolioStore) {
    entryHaltReason = 'portfolio_halted: PORTFOLIO_STATE binding missing'
    emitSkipReasonNotify(notifier, 'portfolio_halted', options.requestId, 'critical', 'PORTFOLIO_STATE binding missing')
  }
  if (portfolioStore) {
  try {
    portfolioSnapshot = await portfolioStore.getPortfolio()
    // Normalizes a missing field (older DO row/fixture) to null, which
    // `emitStaleRollWarningIfNeeded` treats as "never rolled" rather than stale.
    const lastRolledAt = portfolioSnapshot.lastRolledAt ?? null
    analysis = {
      ...analysis,
      portfolio: {
        dailyStartEquity: portfolioSnapshot.dailyStartEquity,
        dailyRealizedPnl: portfolioSnapshot.dailyRealizedPnl,
        tradingDisabledUntil: portfolioSnapshot.tradingDisabledUntil,
        lastRolledAt,
        updatedAt: portfolioSnapshot.updatedAt,
      },
    }
    emitStaleRollWarningIfNeeded({ lastRolledAt, requestId: options.requestId })
    const now = Date.now()
    if (portfolioSnapshot.tradingDisabledUntil) {
      const disabledUntilMs = new Date(portfolioSnapshot.tradingDisabledUntil).getTime()
      if (!Number.isFinite(disabledUntilMs) || disabledUntilMs > now) {
        emitSkipReasonNotify(
          notifier,
          'portfolio_halted',
          options.requestId,
          'critical',
          `tradingDisabledUntil=${portfolioSnapshot.tradingDisabledUntil}`,
        )
        entryHaltReason = `portfolio_halted: tradingDisabledUntil=${portfolioSnapshot.tradingDisabledUntil}`
      }
    }
    if (entryHaltReason === null && portfolioSnapshot.dailyStartEquity > 0) {
      const ratio = portfolioSnapshot.dailyRealizedPnl / portfolioSnapshot.dailyStartEquity
      if (ratio <= global.drawdownKillThreshold) {
        emitSkipReasonNotify(
          notifier,
          'drawdown_kill',
          options.requestId,
          'critical',
          `ratio=${ratio.toFixed(4)} <= threshold=${global.drawdownKillThreshold}`,
        )
        entryHaltReason = `drawdown_kill: ratio=${ratio.toFixed(4)} <= threshold=${global.drawdownKillThreshold}`
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitSkipReasonNotify(
      notifier,
      'portfolio_halted',
      options.requestId,
      'critical',
      `getPortfolio threw: ${message}`,
    )
    entryHaltReason = `portfolio_halted: getPortfolio threw: ${message}`
  }
  }

  // Drawdown-scaled risk: derate sizing for the rest of the trading day
  // when realized PnL is underwater but not yet at drawdown_kill threshold.
  // Emits a journal-visible log so the operator can tell a quiet day from
  // a halved one.
  // A 0/0 portfolio (exit-only halt, snapshot unread) is a neutral
  // placeholder here — entry is suppressed for every symbol on that path
  // regardless of the scale result, so only the downstream type/log shape
  // needs to stay populated.
  const { portfolio: portfolioForScale, usedFallback } = resolvePortfolioForRiskScale(
    portfolioSnapshot ?? { dailyStartEquity: 0, dailyRealizedPnl: 0 },
    global.totalCapitalUsd,
  )
  if (usedFallback) {
    console.log(
      JSON.stringify({
        event: 'portfolio_unseeded_fallback',
        requestId: options.requestId,
        fallbackEquity: portfolioForScale.dailyStartEquity,
      }),
    )
  }
  const ddScale = computeDrawdownRiskScale(portfolioForScale, {
    baseRiskPct: global.riskBasePerTradePct,
    halfThreshold: global.riskDdHalfThreshold,
    haltThreshold: global.riskDdHaltThreshold,
  })
  analysis = {
    ...analysis,
    config: {
      ...analysis.config,
      risk: {
        ...analysis.config.risk,
        scaledPerTradePct: global.riskBasePerTradePct * ddScale.scale,
      },
    },
    drawdownScale: {
      step: ddScale.step,
      scale: ddScale.scale,
      drawdown: ddScale.drawdown,
    },
  }
  if (ddScale.step !== 'normal') {
    console.log(
      JSON.stringify({
        event: 'drawdown_risk_scale',
        requestId: options.requestId,
        step: ddScale.step,
        scale: ddScale.scale,
        drawdown: ddScale.drawdown,
      }),
    )
  }
  const scaledRiskPerTradePct = global.riskBasePerTradePct * ddScale.scale

  // WebullTradeClient carries its own staging gate (ENVIRONMENT) so a live
  // order can't structurally originate from staging. DRY_RUN skips token
  // resolution entirely — no broker call means no reason to hit the DO.
  const accessToken = global.dryRun ? undefined : await resolveAccessToken(env)
  const liveTradeClient = global.dryRun ? null : createWebullTradeClient(env, { accessToken })
  const liveReadClient = global.dryRun ? null : createWebullReadClient(env, { accessToken })
  const execution = liveTradeClient ? new WebullExecution(liveTradeClient) : new MockExecution()
  const barClient = await selectBarClient(env)

  // A missing table (unmigrated preview/new env) means gate evaluation
  // itself would throw and fail-closed every BUY; skip injecting the gate
  // instead so those environments keep prior (gate-off) behavior.
  const earningsGateReady = env.DB ? await isEarningsCalendarReady(env.DB) : false
  if (env.DB && !earningsGateReady) {
    console.warn(
      JSON.stringify({
        event: 'earnings_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // Same readiness pattern as earnings gate above.
  const macroEventGateReady = env.DB ? await isMacroEventCalendarReady(env.DB) : false
  if (env.DB && !macroEventGateReady) {
    console.warn(
      JSON.stringify({
        event: 'macro_event_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }

  const vixDecision = await loadVixDecision(barClient, global, options.requestId)
  analysis = { ...analysis, vix: vixDecision }
  await detectAndNotifyVixRegimeChange({
    db: env.DB,
    notifier,
    current: vixDecision,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  // Same readiness pattern as earnings/macro gates above.
  const newsShockGateReady = env.DB ? await isNewsShockGateReady(env.DB) : false
  if (env.DB && !newsShockGateReady && global.newsShockMode !== 'off') {
    console.warn(
      JSON.stringify({
        event: 'news_shock_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // Third layer of defense on top of input sanitizing inside
  // `loadNewsShockDecision`/`evaluateNewsShockGate`: an unexpected throw
  // here still must not take down the whole tick, so it fails open (no
  // gate injected) rather than fail-closed on BUY sizing.
  const newsShockLoadResult =
    env.DB && newsShockGateReady && global.newsShockMode !== 'off'
      ? await loadNewsShockDecision(env.DB, global, options.requestId, new Date()).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'news_shock_decision_load_failed',
              requestId: options.requestId,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
          return undefined
        })
      : undefined
  // Only the multi-probe composite feeds BUY sizing; per-probe decisions
  // (`probes`) are for the daily summary notification only.
  const newsShockDecision = newsShockLoadResult?.combined
  if (newsShockDecision) {
    analysis = { ...analysis, newsShock: newsShockDecision }
  }
  if (newsShockDecision && newsShockDecision.regime !== 'unknown') {
    // 'unknown' means missing data (GDELT lag/producer outage), not a
    // market state, so the unknown->normal recovery transition alone is
    // suppressed — recovering from a data gap isn't itself actionable news.
    const mode = global.newsShockMode === 'enforce' ? 'enforce' : 'observe'
    await detectAndNotifyRegimeChange({
      db: env.DB,
      notifier,
      key: 'news_shock_regime',
      current: { regime: newsShockDecision.regime, reason: newsShockDecision.reason },
      rank: NEWS_SHOCK_REGIME_RANK,
      criticalRegime: 'critical',
      isValidRegime: isNewsShockRegime,
      requestId: options.requestId,
      shouldNotify: (from, to) => !(from === 'unknown' && to === 'normal'),
      headline: (from, to) => buildNewsShockRegimeHeadline(from, to, newsShockDecision, mode),
    }).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'news_shock_regime_change_detect_failed',
          requestId: options.requestId,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
  }
  const newsShockGateOption =
    newsShockDecision && global.newsShockMode !== 'off'
      ? { mode: global.newsShockMode, decision: newsShockDecision }
      : undefined

  // Recorded per decision rather than joined by timestamp later: the collector fires on the same
  // quarter-hours, so a later join could pick a row that did not exist yet when this decision ran.
  const headlineEvalSnapshot = env.DB
    ? await loadHeadlineEvalSnapshot(env.DB, new Date(), options.requestId)
    : undefined
  analysis = { ...analysis, headlineEval: headlineEvalSnapshot }

  // Same readiness pattern as the gates above; mode is checked first so an
  // idle ('off') gate skips the readiness query itself, not just the load.
  const extendedHoursGateReady =
    env.DB && global.extendedHoursGateMode !== 'off' ? await isExtendedHoursGateReady(env.DB) : false
  if (env.DB && !extendedHoursGateReady && global.extendedHoursGateMode !== 'off') {
    console.warn(
      JSON.stringify({
        event: 'extended_hours_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // Same fail-open backstop as the news shock gate above.
  const extendedHoursDecisions =
    env.DB && extendedHoursGateReady && global.extendedHoursGateMode !== 'off'
      ? await loadExtendedHoursGateDecisions(env.DB, new Date()).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'extended_hours_gate_load_failed',
              requestId: options.requestId,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
          return undefined
        })
      : undefined
  const extendedHoursGateOption =
    extendedHoursDecisions && extendedHoursDecisions.size > 0 && global.extendedHoursGateMode !== 'off'
      ? { mode: global.extendedHoursGateMode, decisions: extendedHoursDecisions }
      : undefined

  // A pre-open BUY decides at a MARKET order and can fill far from the
  // decision price at the actual open; extendedHoursGate only evaluates
  // from 09:30 ET so it doesn't catch this case. Applied regardless of
  // `sessionWindowGateEnabled` — with the window gate off cron would
  // otherwise keep queuing pre-open BUYs all day. SELL/HOLD are exempt so
  // exits are never suppressed.
  const sessionSuppressedSymbols: Record<string, string> = {}
  for (const symbol of universe.allowedSymbols) {
    const market = universe.symbolCurrency[symbol] === 'JPY' ? 'JP' : 'US'
    if (!isWithinRegularSession(sessionNow, market)) {
      sessionSuppressedSymbols[symbol.toUpperCase()] =
        'outside regular session: BUY deferred (exits still evaluated)'
    }
  }
  // Suppression reason precedence (highest first): role-derived
  // (`entrySuppressedSymbols`, includes exit-only) > entryHaltReason >
  // outside-session — the most specific reason wins in the decision log.
  const effectiveEntrySuppressed: Record<string, string> = {
    ...sessionSuppressedSymbols,
    ...(entryHaltReason === null
      ? {}
      : Object.fromEntries(
          universe.allowedSymbols.map((symbol) => [symbol.toUpperCase(), entryHaltReason]),
        )),
    ...entrySuppressedSymbols,
  }
  if (entryHaltReason !== null) {
    console.log(
      JSON.stringify({
        event: 'entry_halt_exit_only',
        requestId: options.requestId,
        reason: entryHaltReason,
        symbols: universe.allowedSymbols.length,
      }),
    )
    analysis = { ...analysis, entryHalt: { reason: entryHaltReason } }
  }
  const summary: PullbackRunSummary = {
    ...emptySummary(),
    vix: vixDecision,
    ...(newsShockDecision !== undefined ? { newsShock: newsShockDecision } : {}),
  }
  const runs: Array<{ currency: SymbolCurrency; equity: number | null; symbols: string[] }> = []
  if (activeCurrencies.has('USD')) {
    runs.push({
      currency: 'USD',
      equity: sanitizeEquity(global.totalCapitalUsd),
      symbols: runCurrency.USD,
    })
  }
  if (activeCurrencies.has('JPY')) {
    runs.push({
      currency: 'JPY',
      equity: sanitizeEquity(global.totalCapitalJpy),
      symbols: runCurrency.JPY,
    })
  }

  // Left `undefined` (never a default baseline) when unset/non-finite/non-positive:
  // budget% sizing against a phantom capital figure over-orders a small
  // account into a buying-power rejection. Budget symbols fail closed in
  // sizing until total_capital_jpy is actually set.
  const budgetBasisJpy =
    global.totalCapitalJpy != null &&
    Number.isFinite(global.totalCapitalJpy) &&
    global.totalCapitalJpy > 0
      ? global.totalCapitalJpy
      : undefined
  const usdHasBudgetSymbol = byCurrency.USD.some(
    (s) => universe.symbolBudgetAllocPct[s.toUpperCase()] !== undefined,
  )
  // Also needed whenever a USD run exists, since the exposure ledger below
  // converts USD positions to JPY regardless of budget usage.
  const needUsdJpy = usdHasBudgetSymbol || liveReadClient !== null || runCurrency.USD.length > 0
  const usdJpyRate = needUsdJpy ? await loadUsdJpyRate({ requestId: options.requestId }) : null

  // A fetch failure/anomaly falls back to the unavailable ledger, which
  // fails every BUY closed this tick rather than sizing against a wrong
  // buying-power figure. Stays undefined in DryRun (no pool gate).
  const buyingPower: BuyingPowerLedger | undefined = liveReadClient
    ? await resolveBuyingPowerLedger(liveReadClient, usdJpyRate, options.requestId)
    : undefined

  // Sums current exposure from the symbol state cron itself reads, not
  // `PortfolioState.openExposureUsd/Jpy` (which manual `/trade/execute`
  // uses) — that counter drifts under sync-holdings/operator overrides and
  // would size against a stale ceiling. Uses the full `runCurrency` (all
  // currencies, including exit-only symbols) rather than the window-gated
  // `runs`, so a held position in a currently-closed market still counts
  // against the ceiling.
  const exposureCap = await buildExposureLedger({
    runs: [
      { currency: 'USD', symbols: runCurrency.USD },
      { currency: 'JPY', symbols: runCurrency.JPY },
    ],
    positionStore,
    usdJpyRate,
    budgetBasisJpy,
    maxPortfolioExposurePct: global.maxPortfolioExposurePct,
    requestId: options.requestId,
  })
  console.log(
    JSON.stringify({
      event: 'portfolio_exposure_ledger',
      requestId: options.requestId,
      status: exposureCap.status,
      ceilingJpy: exposureCap.ceilingJpy,
      currentJpy: exposureCap.currentJpy,
      remainingJpy: exposureCap.remainingJpy,
      ...(exposureCap.reason !== undefined ? { reason: exposureCap.reason } : {}),
    }),
  )
  analysis = {
    ...analysis,
    exposure: {
      status: exposureCap.status,
      ceilingJpy: exposureCap.ceilingJpy,
      currentJpy: exposureCap.currentJpy,
      remainingJpy: exposureCap.remainingJpy,
      ...(exposureCap.reason !== undefined ? { reason: exposureCap.reason } : {}),
    },
  }

  // Needs D1 to deactivate symbol_config on a TICKER_IS_DENY response.
  const onTickerDeny = env.DB
    ? createTickerDenyGuard({
        db: createSymbolConfigDb(env.DB),
        rawDb: env.DB,
        notifier,
        requestId: options.requestId,
      })
    : undefined

  // Built once and shared by pass 1 and cash rebalance pass 2 so a
  // rebalance BUY can't dodge a restriction a normal BUY would hit.
  const intradayOnlySymbols = new Set(Object.keys(universe.symbolIntradayOnly))
  const earningsGateOption =
    env.DB && earningsGateReady
      ? {
          earningsGate: {
            repo: createEarningsCalendarRepo(createEarningsCalendarDb(env.DB)),
            freezeBusinessDays: 1,
          },
        }
      : {}
  const macroEventGateOption =
    env.DB && macroEventGateReady
      ? {
          macroEventGate: {
            repo: createMacroEventCalendarRepo(createMacroEventCalendarDb(env.DB)),
          },
        }
      : {}
  const sanityFailedCooldownOption = env.DB
    ? {
        sanityFailedCooldown: {
          check: (symbol: string) => hasRecentSanityFailure(env.DB!, symbol, SANITY_FAILED_COOLDOWN_MS),
          withinMs: SANITY_FAILED_COOLDOWN_MS,
        },
      }
    : {}

  // Resolves the global per-order cap used by `DefaultRiskPolicy` /
  // `buildCashRebalancePlan` so cron's normal BUY sizing applies it too,
  // not just the per-symbol cap.
  const maxOrderNotionalFor = (currency: SymbolCurrency): number | undefined => {
    const value = currency === 'JPY' ? global.maxOrderNotionalJpy : global.maxOrderNotionalUsd
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  for (const run of runs) {
    analysis.runs.push({
      currency: run.currency,
      equity: run.equity,
      symbols: run.symbols,
    })
    const fxJpyPerSymbolCcy = run.currency === 'JPY' ? 1 : (usdJpyRate ?? undefined)
    const decisionDb = strategyDecisionDbOrUndefined(env)
    const sub = await runPullbackScheduler({
      symbols: run.symbols,
      ...(run.equity !== null ? { equity: run.equity } : {}),
      symbolLotSizeMap: universe.symbolLotSize,
      barClient,
      positionStore,
      execution,
      symbolCapMap: universe.symbolMaxNotional,
      ...(maxOrderNotionalFor(run.currency) !== undefined
        ? { maxOrderNotional: maxOrderNotionalFor(run.currency) }
        : {}),
      symbolBudgetAllocPctMap: universe.symbolBudgetAllocPct,
      budgetBasisJpy,
      fxJpyPerSymbolCcy,
      buyingPower,
      exposureCap,
      intradayOnlySymbols,
      defaultRule,
      rulesMap,
      entrySuppressedSymbols: effectiveEntrySuppressed,
      atrBaselineMode: global.atrBaselineMode,
      // Keeps the realized PnL in notify()/log output net, matching reconcileFills.
      tradeCost: {
        feePctOfNotional: global.feePctOfNotional,
        feeFixedPerOrder: global.feeFixedPerOrder,
      },
      halfEntrySymbols,
      momentumSymbols,
      ...(momentumStrategy ? { momentumStrategy } : {}),
      ...(onTickerDeny ? { onTickerDeny } : {}),
      ...(pairRegimeOption ? { pairRegime: pairRegimeOption } : {}),
      riskPerTradePct: scaledRiskPerTradePct,
      requestId: options.requestId,
      notifier,
      // Same shape/source as the manual `/trade/execute` route so the two
      // agree on per-symbol risk.
      perSymbolRisk: {
        inversePairs: universe.inversePairs,
        spreadLimits: {
          US: global.spreadLimitPctUs,
          JP: global.spreadLimitPctJp,
        },
        staleQuoteMs: global.staleQuoteMs,
        gapRejectPct: global.gapRejectPct,
      },
      // Only wired up on the live Webull path — MockExecution never 417s,
      // so this would be dead code under DRY_RUN. The resolver itself must
      // not swallow the exception: `tryFallbackSell` in the scheduler is
      // what falls back to null and re-throws the original error.
      ...(liveReadClient
        ? {
            sellFallback: {
              getAvailableQty: (symbol: string) =>
                liveReadClient.getAvailableQtyForSymbol(symbol),
            },
          }
        : {}),
      ...earningsGateOption,
      ...macroEventGateOption,
      vixDecision,
      ...(newsShockGateOption ? { newsShockGate: newsShockGateOption } : {}),
      ...(extendedHoursGateOption ? { extendedHoursGate: extendedHoursGateOption } : {}),
      ...sanityFailedCooldownOption,
      onDecision: ({ trace, ...record }) =>
        logStrategyDecision(decisionDb, {
          timestamp: new Date().toISOString(),
          requestId: options.requestId,
          ...record,
          traceJson: trace && trace.length > 0 ? JSON.stringify(trace) : null,
          headlineEvalJson: headlineEvalSnapshot ? JSON.stringify(headlineEvalSnapshot) : null,
        }),
    })
    summary.evaluated += sub.evaluated
    summary.buys += sub.buys
    summary.sells += sub.sells
    summary.holds += sub.holds
    summary.rejected.push(...sub.rejected)
    summary.errors.push(...sub.errors)
    summary.decisions.push(...sub.decisions)
    Object.assign(summary.entrySnapshots, sub.entrySnapshots)
    analysis.decisions.push(...sub.decisions)
  }

  // Snapshotted right after pass 1, before pass 2 (cash rebalance BUY) runs
  // — including pass 2's own BUY attempts here would create a same-tick
  // feedback loop. Held positions don't count as demand: the cash for them
  // is already spent, so counting a hold would sell the fallback parking
  // symbol only to buy it back again once the position exits.
  const demandSources = new Set<string>()
  for (const record of summary.decisions) {
    if (record.decision === 'BUY' || record.order?.side === 'BUY') {
      demandSources.add(record.symbol)
    }
  }

  // Target/active weight is always computed for `analysis`, independent of
  // the flags below — `cashFallbackOrdersEnabled` (BUY) and
  // `cashFallbackSellMode` (SELL) gate order placement independently, so
  // SELL can be enforced ahead of turning BUY on.
  const allocationView = computeConditionalAllocation({
    targetWeights: universe.symbolBudgetAllocPct,
    policy: {
      entryRequired: new Set(Object.keys(universe.symbolEntryRequired)),
      alwaysActive: new Set(Object.keys(universe.symbolAlwaysActive)),
      cashFallback: universe.symbolCashFallback,
    },
    entryStatuses: Object.fromEntries(
      Object.entries(summary.entrySnapshots).map(([sym, snap]) => [sym, snap.status]),
    ),
    heldSymbols: new Set(
      Object.entries(summary.entrySnapshots)
        .filter(([, snap]) => snap.heldQty > 0)
        .map(([sym]) => sym),
    ),
    symbolCurrency: universe.symbolCurrency,
    inversePairs: universe.inversePairs,
  })
  analysis.allocation = {
    view: allocationView,
    ordersEnabled: global.cashFallbackOrdersEnabled,
    sellMode: global.cashFallbackSellMode,
  }

  // Pass 2 is the one BUY path that doesn't receive entrySuppressedSymbols,
  // so an entry halt is enforced here instead — and SELL shares the same
  // guard, since halt should stop allocation rebalancing generally, not
  // just new entries.
  if (
    budgetBasisJpy !== undefined &&
    entryHaltReason === null &&
    (global.cashFallbackOrdersEnabled || global.cashFallbackSellMode !== 'off')
  ) {
    const rebalanceSkipped: CashRebalanceSkip[] = []
    const buyOrdersByCcy: Record<SymbolCurrency, CashRebalanceOrder[]> = { USD: [], JPY: [] }
    const sellOrdersByCcy: Record<SymbolCurrency, CashRebalanceOrder[]> = { USD: [], JPY: [] }
    const fxJpyPerCcy = (currency: SymbolCurrency) => (currency === 'JPY' ? 1 : (usdJpyRate ?? undefined))
    const maxOrderNotional = { USD: global.maxOrderNotionalUsd, JPY: global.maxOrderNotionalJpy }

    if (global.cashFallbackOrdersEnabled) {
      const plan = buildCashRebalancePlan({
        allocation: allocationView,
        snapshots: summary.entrySnapshots,
        budgetBasisJpy,
        fxJpyPerCcy,
        symbolCurrency: universe.symbolCurrency,
        symbolLotSize: universe.symbolLotSize,
        symbolMaxNotional: universe.symbolMaxNotional,
        maxOrderNotional,
      })
      rebalanceSkipped.push(...plan.skipped)
      for (const order of plan.orders) {
        buyOrdersByCcy[universe.symbolCurrency[order.symbol] ?? 'USD'].push(order)
      }
    }

    if (global.cashFallbackSellMode !== 'off') {
      const sellPlan = buildCashFallbackSellPlan({
        allocation: allocationView,
        snapshots: summary.entrySnapshots,
        budgetBasisJpy,
        fxJpyPerCcy,
        symbolCurrency: universe.symbolCurrency,
        symbolLotSize: universe.symbolLotSize,
        symbolMaxNotional: universe.symbolMaxNotional,
        maxOrderNotional,
        cashFallback: universe.symbolCashFallback,
        demandSources,
      })
      rebalanceSkipped.push(...sellPlan.skipped)
      if (global.cashFallbackSellMode === 'observe') {
        console.log(
          JSON.stringify({
            event: 'cash_rebalance_sell_observed',
            requestId: options.requestId,
            orders: sellPlan.orders,
            skipped: sellPlan.skipped,
          }),
        )
        for (const order of sellPlan.orders) {
          rebalanceSkipped.push({
            symbol: order.symbol,
            reason: `observe: would sell ${order.quantity} toward active weight`,
          })
        }
      } else {
        for (const order of sellPlan.orders) {
          sellOrdersByCcy[universe.symbolCurrency[order.symbol] ?? 'USD'].push(order)
        }
      }
    }

    // BUY and SELL plans should be mutually exclusive per symbol; this is a
    // defensive guard against double-ordering if upstream logic ever puts
    // both on the same symbol.
    for (const currency of ['USD', 'JPY'] as const) {
      const buySymbols = new Set(buyOrdersByCcy[currency].map((o) => o.symbol))
      const conflicting = sellOrdersByCcy[currency].filter((o) => buySymbols.has(o.symbol))
      if (conflicting.length > 0) {
        sellOrdersByCcy[currency] = sellOrdersByCcy[currency].filter((o) => !buySymbols.has(o.symbol))
        for (const order of conflicting) {
          rebalanceSkipped.push({
            symbol: order.symbol,
            reason: 'conflicting buy and sell plan (skipped sell)',
          })
        }
      }
    }

    for (const run of runs) {
      const buyOrders = buyOrdersByCcy[run.currency]
      const sellOrders = sellOrdersByCcy[run.currency]
      if (buyOrders.length === 0 && sellOrders.length === 0) continue
      const symbols = [...new Set([...buyOrders.map((o) => o.symbol), ...sellOrders.map((o) => o.symbol)])]
      // Pass 2 doesn't receive `sessionSuppressedSymbols`, so it's gated
      // per currency here instead — otherwise a pre-open rebalance BUY/SELL
      // would go through unsuppressed.
      if (!isWithinRegularSession(sessionNow, run.currency === 'JPY' ? 'JP' : 'US')) {
        for (const symbol of symbols) {
          rebalanceSkipped.push({
            symbol,
            reason: 'outside regular session: cash rebalance deferred',
          })
        }
        console.log(
          JSON.stringify({
            event: 'cash_rebalance_pass2_skipped_outside_session',
            requestId: options.requestId,
            currency: run.currency,
            symbols,
          }),
        )
        continue
      }
      const decisionDb = strategyDecisionDbOrUndefined(env)
      const sub = await runPullbackScheduler({
        symbols,
        ...(run.equity !== null ? { equity: run.equity } : {}),
        symbolLotSizeMap: universe.symbolLotSize,
        barClient,
        positionStore,
        execution,
        symbolCapMap: universe.symbolMaxNotional,
        ...(maxOrderNotionalFor(run.currency) !== undefined
          ? { maxOrderNotional: maxOrderNotionalFor(run.currency) }
          : {}),
        ...(buyOrders.length > 0
          ? { cashRebalanceQuantityMap: Object.fromEntries(buyOrders.map((o) => [o.symbol, o.quantity])) }
          : {}),
        ...(sellOrders.length > 0
          ? {
              cashRebalanceSellQuantityMap: Object.fromEntries(
                sellOrders.map((o) => [o.symbol, o.quantity]),
              ),
            }
          : {}),
        intradayOnlySymbols,
        ...(onTickerDeny ? { onTickerDeny } : {}),
        fxJpyPerSymbolCcy: run.currency === 'JPY' ? 1 : (usdJpyRate ?? undefined),
        buyingPower,
        exposureCap,
        defaultRule,
        rulesMap,
        momentumSymbols,
        ...(momentumStrategy ? { momentumStrategy } : {}),
        requestId: options.requestId,
        notifier,
        perSymbolRisk: {
          inversePairs: universe.inversePairs,
          spreadLimits: {
            US: global.spreadLimitPctUs,
            JP: global.spreadLimitPctJp,
          },
          staleQuoteMs: global.staleQuoteMs,
          gapRejectPct: global.gapRejectPct,
        },
        vixDecision,
        ...(newsShockGateOption ? { newsShockGate: newsShockGateOption } : {}),
        ...(extendedHoursGateOption ? { extendedHoursGate: extendedHoursGateOption } : {}),
        ...earningsGateOption,
        ...macroEventGateOption,
        ...sanityFailedCooldownOption,
        onDecision: ({ trace, ...record }) =>
          logStrategyDecision(decisionDb, {
            timestamp: new Date().toISOString(),
            requestId: options.requestId,
            ...record,
            traceJson: trace && trace.length > 0 ? JSON.stringify(trace) : null,
            headlineEvalJson: headlineEvalSnapshot ? JSON.stringify(headlineEvalSnapshot) : null,
          }),
      })
      summary.evaluated += sub.evaluated
      summary.buys += sub.buys
      summary.sells += sub.sells
      summary.rejected.push(...sub.rejected)
      summary.errors.push(...sub.errors)
      summary.decisions.push(...sub.decisions)
      analysis.decisions.push(...sub.decisions)
    }

    analysis.allocation.rebalanceSkipped = rebalanceSkipped
  }

  return {
    summary,
    symbols: universe.allowedSymbols,
    analysis,
    ...(entryHaltReason !== null ? { entryHaltReason } : {}),
  }
}

/** Returns null (never a phantom default baseline) when unset/non-finite/non-positive; downstream risk-% sizing fails closed on null equity. */
function sanitizeEquity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

// Called once — the HTTP client already retries transient failures
// internally. Any throw/parse failure/anomaly/missing FX rate returns the
// unavailable ledger rather than a guessed value.
async function resolveBuyingPowerLedger(
  readClient: { getAccountBalance(): Promise<WebullAccountBalanceDto> },
  usdJpyRate: number | null,
  requestId: string | undefined,
): Promise<BuyingPowerLedger> {
  try {
    const balance = await readClient.getAccountBalance()
    const bp = buyingPowerJpyFromBalance(balance, usdJpyRate)
    if (bp === null) {
      console.warn(
        JSON.stringify({
          event: 'buying_power_unavailable',
          reason: 'balance parse failed / anomaly / missing FX',
          requestId,
        }),
      )
      return createUnavailableBuyingPowerLedger('balance parse failed / anomaly / missing FX')
    }
    console.warn(
      JSON.stringify({ event: 'buying_power_fetched', jpy: bp.jpy, byCurrency: bp.byCurrency, requestId }),
    )
    return createBuyingPowerLedger({ availableJpy: bp.jpy, asOf: new Date().toISOString() })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(JSON.stringify({ event: 'buying_power_unavailable', reason, requestId }))
    return createUnavailableBuyingPowerLedger(reason)
  }
}

// Sums held position notional (JPY-converted) across all given symbols into
// `currentJpy`. Fails closed to the unavailable ledger on any of: unset
// budget basis, invalid exposure pct, a state read throwing, or a USD
// position with no usable FX rate to convert it.
async function buildExposureLedger(params: {
  runs: Array<{ currency: SymbolCurrency; symbols: string[] }>
  positionStore: PositionStore
  usdJpyRate: number | null
  budgetBasisJpy: number | undefined
  maxPortfolioExposurePct: number
  requestId: string | undefined
}): Promise<ExposureLedger> {
  const { runs, positionStore, usdJpyRate, budgetBasisJpy, maxPortfolioExposurePct } = params
  if (budgetBasisJpy === undefined) {
    return createUnavailableExposureLedger('total_capital_jpy unset')
  }
  if (!Number.isFinite(maxPortfolioExposurePct) || maxPortfolioExposurePct <= 0) {
    return createUnavailableExposureLedger('max_portfolio_exposure_pct invalid')
  }
  let currentJpy = 0
  for (const run of runs) {
    const fx = run.currency === 'JPY' ? 1 : usdJpyRate
    for (const sym of run.symbols) {
      let state: Awaited<ReturnType<typeof positionStore.getState>>
      try {
        state = await positionStore.getState(sym)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return createUnavailableExposureLedger(`state read failed for ${sym}: ${message}`)
      }
      const position = state.position
      if (position === null || !Number.isFinite(position.qty) || position.qty <= 0) continue
      if (fx === null) {
        return createUnavailableExposureLedger('usd/jpy rate unavailable')
      }
      const notionalJpy = position.qty * position.avgPrice * fx
      // Not silently skipped: an unaccounted position would under-count
      // currentJpy and pass status: 'ok' with a too-loose remainingJpy.
      if (!Number.isFinite(position.avgPrice) || position.avgPrice <= 0 || !Number.isFinite(notionalJpy) || notionalJpy <= 0) {
        return createUnavailableExposureLedger(`invalid position valuation for ${sym}`)
      }
      currentJpy += notionalJpy
    }
  }
  return createExposureLedger({ ceilingJpy: budgetBasisJpy * maxPortfolioExposurePct, currentJpy })
}

/**
 * Distinguishes an unseeded portfolio (falls back to `totalCapitalUsd` as
 * the daily baseline) from a broken one (never falls back, so
 * `drawdownRiskScale` fails closed to halt instead).
 */
export function resolvePortfolioForRiskScale<
  P extends { dailyStartEquity: number; dailyRealizedPnl: number },
>(
  portfolio: P,
  totalCapitalUsd: number | null | undefined,
): { portfolio: P; usedFallback: boolean } {
  if (portfolio.dailyStartEquity > 0) return { portfolio, usedFallback: false }
  if (!Number.isFinite(portfolio.dailyStartEquity)) return { portfolio, usedFallback: false }
  // Left alone rather than defaulted to 0: overwriting a broken PnL value
  // would let it slip past the fail-closed halt below.
  if (!Number.isFinite(portfolio.dailyRealizedPnl)) return { portfolio, usedFallback: false }
  if (
    totalCapitalUsd === null ||
    totalCapitalUsd === undefined ||
    !Number.isFinite(totalCapitalUsd) ||
    totalCapitalUsd <= 0
  ) {
    return { portfolio, usedFallback: false }
  }
  return {
    portfolio: {
      ...portfolio,
      dailyStartEquity: totalCapitalUsd,
      dailyRealizedPnl: 0,
    },
    usedFallback: true,
  }
}

// 24h catches the first miss of the 22:00 UTC daily roll cron at the
// smallest granularity that survives normal same-day jitter.
const STALE_ROLL_WARNING_HOURS = 24

/** `lastRolledAt === null` (never rolled — greenfield env, or before the first EOD cron success) is not treated as stale, to avoid warning every tick. */
export function emitStaleRollWarningIfNeeded(args: {
  lastRolledAt: string | null
  requestId?: string
  now?: () => number
}): void {
  if (args.lastRolledAt === null) return
  const lastMs = new Date(args.lastRolledAt).getTime()
  if (!Number.isFinite(lastMs)) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        reason: 'unparseable_lastRolledAt',
      }),
    )
    return
  }
  const nowMs = (args.now ?? Date.now)()
  const elapsedHours = (nowMs - lastMs) / 3_600_000
  if (elapsedHours >= STALE_ROLL_WARNING_HOURS) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        staleHours: Number(elapsedHours.toFixed(2)),
        thresholdHours: STALE_ROLL_WARNING_HOURS,
      }),
    )
  }
}

// A query throw (DB connection failure/corruption, not just a missing
// table) is also treated as not-ready, rather than letting the gate itself
// fail-closed every BUY over a D1 problem it can't evaluate anyway.
async function isEarningsCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='earnings_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

// Fetches the latest `^VIX` close for `evaluateVixRegime`. Fails open (null
// -> normal/1.0x) on fetch or parse failure rather than blocking all BUYs
// over a VIX outage — VIX isn't essential enough to the system for that.
async function loadVixDecision(
  barClient: BarClient,
  global: { vixWarningThreshold: number; vixCriticalThreshold: number; vixWarningSizeScale: number },
  requestId: string | undefined,
): Promise<VixRegimeFilterDecision> {
  let vix: number | null = null
  try {
    const bars = await barClient.getDailyBars('^VIX', 1)
    const last = bars[bars.length - 1]
    if (last && Number.isFinite(last.close) && last.close > 0) {
      vix = last.close
    } else {
      console.warn(
        JSON.stringify({
          event: 'vix_fetch_no_bars',
          requestId,
          barsLength: bars.length,
        }),
      )
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'vix_fetch_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return evaluateVixRegime(vix, {
    warningThreshold: global.vixWarningThreshold,
    criticalThreshold: global.vixCriticalThreshold,
    warningSizeScale: global.vixWarningSizeScale,
  })
}

// Same readiness pattern as isEarningsCalendarReady above.
async function isMacroEventCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='macro_event_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

// Fire-and-forget: a notify failure is caught and logged below rather than
// propagated, so it can never fail the cron tick it's reporting on.
function emitSkipReasonNotify(
  notifier: Notifier,
  reason: 'portfolio_halted' | 'drawdown_kill' | 'no_bridge_state',
  requestId: string | undefined,
  severity: 'critical' | 'warning' = 'critical',
  detail?: string,
): void {
  const note = requestId ? ` requestId=${requestId}` : ''
  const message = detail ? `cron skipped: ${reason} — ${detail}${note}` : `cron skipped: ${reason}${note}`
  notifier
    .notify({
      type: 'ERROR',
      message,
      cause: reason,
      severity,
    })
    .catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'cron_skip_notify_failed',
          requestId,
          reason,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
}
