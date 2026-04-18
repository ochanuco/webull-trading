import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'
import type { Execution } from '../execution/Execution'
import type { RiskPolicy } from '../risk/RiskPolicy'
import { isWithinJpPriceBand } from '../risk/jpPriceBand'
import { computeSpreadPct } from '../risk/spreadGuard'
import type { PortfolioStore } from '../state/PortfolioStore'
import type { PositionStore } from '../state/PositionStore'
import type { QuoteSnapshot, SymbolState } from '../state/types'
import type { Strategy, StrategyInput } from '../strategy/Strategy'
import { inferWebullMarket } from '../../infrastructure/webull/mapper'
import {
  logPostSubmit,
  logPreSubmit,
  logTradeDecision,
  logTradeIntent,
} from '../../infrastructure/logger/tradeJournal'

export interface TradingConfig {
  dryRun: boolean
  tradingEnabled: boolean
  allowedSymbols: string[]
  maxOrderNotional: number
  symbolMaxNotional: Record<string, number>
  marketHoursCheck: boolean
  now?: () => Date
}

export interface TradingDecision {
  signal: Signal
  orderIntent?: OrderIntent
  riskDecision: RiskDecision
}

export interface TradingExecution extends TradingDecision {
  executionResult?: ExecutionResult
}

export interface TradeCallContext {
  requestId?: string
}

export interface TradingServiceOptions {
  positionStore?: PositionStore
  /**
   * Portfolio-level state (daily equity / realized PnL / kill switch). Separate
   * from {@link PositionStore} because drawdown is account-wide, not per-symbol.
   */
  portfolioStore?: PortfolioStore
  /**
   * Drawdown threshold as a fraction of `dailyStartEquity`. When
   * `dailyRealizedPnl / dailyStartEquity <= threshold`, the kill switch arms
   * and rejects every submit until EOD. Default -0.02 (i.e. -2%).
   */
  drawdownKillThreshold?: number
  /** How long a pending-order lock stays live before a new submit can replace it. */
  pendingLockTtlMs?: number
  /**
   * Bidirectional map of structurally anti-correlated symbols. If SYMBOL_STATE
   * shows an open position for the inverse, BUY is rejected (P&L decay trap).
   */
  inversePairs?: Record<string, string>
  /**
   * Per-market spread limits (fraction of mid price). A submit is rejected if
   * `(ask - bid) / mid` exceeds the market's limit. Defaults to US 0.25% and
   * JP 0.60% — US liquid-name depth is tighter than JP individual names.
   */
  spreadLimits?: { US: number; JP: number }
  /**
   * Quote 鮮度の上限 (ms)。`state.lastQuote.fetchedAt` からの経過時間が
   * この値を超えていれば halt 相当として reject する (POC freshness fallback)。
   */
  staleQuoteMs?: number
  /**
   * 寄り付きギャップ re-eval の閾値 (ratio, e.g. 0.03 = 3%)。open position の
   * avgPrice と lastQuote.price の gap が |pct| を超えれば reject。
   */
  gapRejectPct?: number
  now?: () => Date
}

const DEFAULT_PENDING_LOCK_TTL_MS = 60_000
const DEFAULT_SPREAD_LIMITS = { US: 0.0025, JP: 0.006 } as const
const DEFAULT_STALE_QUOTE_MS = 15 * 60 * 1_000
const DEFAULT_GAP_REJECT_PCT = 0.03
const DEFAULT_DRAWDOWN_KILL_THRESHOLD = -0.02

export class TradingService {
  private readonly positionStore?: PositionStore
  private readonly portfolioStore?: PortfolioStore
  private readonly drawdownKillThreshold: number
  private readonly pendingLockTtlMs: number
  private readonly inversePairs: Record<string, string>
  private readonly spreadLimits: { US: number; JP: number }
  private readonly staleQuoteMs: number
  private readonly gapRejectPct: number
  private readonly now: () => Date

  constructor(
    private readonly strategy: Strategy,
    private readonly riskPolicy: RiskPolicy,
    private readonly execution: Execution,
    options: TradingServiceOptions = {},
  ) {
    this.positionStore = options.positionStore
    this.portfolioStore = options.portfolioStore
    this.drawdownKillThreshold =
      options.drawdownKillThreshold !== undefined &&
      Number.isFinite(options.drawdownKillThreshold) &&
      options.drawdownKillThreshold < 0
        ? options.drawdownKillThreshold
        : DEFAULT_DRAWDOWN_KILL_THRESHOLD
    this.pendingLockTtlMs =
      options.pendingLockTtlMs !== undefined &&
      Number.isFinite(options.pendingLockTtlMs) &&
      options.pendingLockTtlMs > 0
        ? options.pendingLockTtlMs
        : DEFAULT_PENDING_LOCK_TTL_MS
    this.inversePairs = options.inversePairs ?? {}
    this.spreadLimits = {
      US:
        options.spreadLimits?.US !== undefined &&
        Number.isFinite(options.spreadLimits.US) &&
        options.spreadLimits.US >= 0
          ? options.spreadLimits.US
          : DEFAULT_SPREAD_LIMITS.US,
      JP:
        options.spreadLimits?.JP !== undefined &&
        Number.isFinite(options.spreadLimits.JP) &&
        options.spreadLimits.JP >= 0
          ? options.spreadLimits.JP
          : DEFAULT_SPREAD_LIMITS.JP,
    }
    this.staleQuoteMs =
      options.staleQuoteMs !== undefined &&
      Number.isFinite(options.staleQuoteMs) &&
      options.staleQuoteMs > 0
        ? options.staleQuoteMs
        : DEFAULT_STALE_QUOTE_MS
    this.gapRejectPct =
      options.gapRejectPct !== undefined &&
      Number.isFinite(options.gapRejectPct) &&
      options.gapRejectPct > 0
        ? options.gapRejectPct
        : DEFAULT_GAP_REJECT_PCT
    this.now = options.now ?? (() => new Date())
  }

  decide(input: StrategyInput, config: TradingConfig, ctx?: TradeCallContext): TradingDecision {
    const signal = this.strategy.decide(input)
    const orderIntent = this.createOrderIntent(signal)
    const riskDecision = this.riskPolicy.evaluate({
      signal,
      orderIntent,
      tradingEnabled: config.tradingEnabled,
      allowedSymbols: config.allowedSymbols,
      maxOrderNotional: config.maxOrderNotional,
      symbolMaxNotional: config.symbolMaxNotional,
      marketHoursCheck: config.marketHoursCheck,
      now: config.now,
    })

    const resolvedIntent =
      riskDecision.normalizedIntent !== undefined ? riskDecision.normalizedIntent : orderIntent

    logTradeDecision({
      requestId: ctx?.requestId,
      symbol: input.symbol,
      strategyName: this.strategy.name,
      signal,
      riskDecision,
    })

    return {
      signal,
      orderIntent: resolvedIntent,
      riskDecision,
    }
  }

  async executeTrade(
    input: StrategyInput,
    config: TradingConfig,
    ctx?: TradeCallContext,
  ): Promise<TradingExecution> {
    const decision = this.decide(input, config, ctx)

    if (!decision.riskDecision.allowed || !decision.orderIntent) {
      return decision
    }

    const stateGate = await this.applyStateGate(decision, decision.orderIntent.symbol)
    if (!stateGate.allowed) {
      return { ...decision, riskDecision: stateGate.riskDecision }
    }

    const intent = decision.orderIntent
    logTradeIntent({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })
    logPreSubmit({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })

    const startedAt = Date.now()
    let executionResult: ExecutionResult | undefined
    let error: Error | undefined
    try {
      executionResult = await this.execution.execute(intent)
      if (executionResult.mode === 'DRY_RUN' && this.positionStore) {
        await this.positionStore.clearPendingOrder(intent.symbol)
      }
      return { ...decision, executionResult }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
      if (this.positionStore) {
        await this.positionStore.clearPendingOrder(intent.symbol).catch(() => undefined)
      }
      throw err
    } finally {
      logPostSubmit({
        requestId: ctx?.requestId,
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        result: executionResult,
        latencyMs: Date.now() - startedAt,
        error,
      })
    }
  }

  private async applyStateGate(
    decision: TradingDecision,
    symbol: string,
  ): Promise<{ allowed: true } | { allowed: false; riskDecision: RiskDecision }> {
    if (!this.positionStore || !decision.orderIntent) {
      return { allowed: true }
    }

    const now = this.now()
    const state = await this.positionStore.getState(symbol)

    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now.getTime()) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, `cooldown active until ${state.cooldownUntil}`),
      }
    }

    // Portfolio-level drawdown kill switch. Fires before pending-lock acquisition
    // so the lock is never taken when trading is disabled. Unseeded equity
    // (0) is treated as fail-open so existing flows keep working.
    if (this.portfolioStore) {
      const portfolio = await this.portfolioStore.getPortfolio()
      if (
        portfolio.tradingDisabledUntil &&
        new Date(portfolio.tradingDisabledUntil).getTime() > now.getTime()
      ) {
        return {
          allowed: false,
          riskDecision: appendReason(
            decision.riskDecision,
            `trading disabled until ${portfolio.tradingDisabledUntil}`,
          ),
        }
      }
      if (portfolio.dailyStartEquity > 0) {
        const ratio = portfolio.dailyRealizedPnl / portfolio.dailyStartEquity
        if (ratio <= this.drawdownKillThreshold) {
          const eodIso = endOfUtcDay(now).toISOString()
          await this.portfolioStore.setTradingDisabledUntil(eodIso).catch(() => undefined)
          return {
            allowed: false,
            riskDecision: appendReason(
              decision.riskDecision,
              `daily drawdown kill: realized ${portfolio.dailyRealizedPnl} / start ${portfolio.dailyStartEquity} (ratio ${ratio.toFixed(4)}) <= threshold ${this.drawdownKillThreshold}; disabled until ${eodIso}`,
            ),
          }
        }
      }
    }

    if (
      decision.orderIntent.side === 'BUY' &&
      state.settledCash > 0 &&
      decision.orderIntent.notional > state.settledCash
    ) {
      return {
        allowed: false,
        riskDecision: appendReason(
          decision.riskDecision,
          `insufficient settled cash: notional ${decision.orderIntent.notional} exceeds settledCash ${state.settledCash}`,
        ),
      }
    }

    if (decision.orderIntent.side === 'BUY') {
      const inverse = this.inversePairs[symbol.toUpperCase()]
      if (inverse) {
        const inverseState = await this.positionStore.getState(inverse)
        if (inverseState.position !== null && inverseState.position.qty > 0) {
          return {
            allowed: false,
            riskDecision: appendReason(
              decision.riskDecision,
              `inverse-pair exposure: ${inverse} position (qty ${inverseState.position.qty}) blocks BUY ${symbol}`,
            ),
          }
        }
      }
    }

    // Halt detection (#38-C, freshness fallback): broker-side halt flag が UAT
    // で確認できていないので quote freshness で代替。lastQuote が null のケース
    // (quote feed まだ未シード) は POC 後方互換のためスキップ。先に halt を見る
    // のは、stale な quote では下流の spread/gap/band が成立しないため。
    // 注: `isQuoteStale` は future-quote ガードで diffMs<=0 も stale 扱いするが、
    //   halt gate では「取得時刻と now がほぼ同時」(diffMs=0) を fresh として扱う。
    if (state.lastQuote) {
      const ageMs = now.getTime() - new Date(state.lastQuote.fetchedAt).getTime()
      if (!Number.isFinite(ageMs) || ageMs > this.staleQuoteMs) {
        return {
          allowed: false,
          riskDecision: appendReason(
            decision.riskDecision,
            `halt or stale quote: lastQuote ${state.lastQuote.fetchedAt} exceeds staleQuoteMs ${this.staleQuoteMs}`,
          ),
        }
      }
    }

    // Spread guard (#38-D): wide spread at submit turns into slippage on market
    // orders and stale fills on marketable limits. Fail-closed when bid/ask are
    // missing once a quote has been seeded.
    const spreadGate = this.evaluateSpreadGate(symbol, state.lastQuote)
    if (spreadGate !== null) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, spreadGate),
      }
    }

    // Gap re-eval (#38-C, simplified POC): avgPrice と現在 quote の gap が
    // |gapRejectPct| を超えていれば 1 tick HOLD。open position が無いとき
    // は比較対象が無いので gap check 自体をスキップする。
    const gapReject = evaluateGap(state, this.gapRejectPct)
    if (gapReject) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, gapReject),
      }
    }

    // JP 値幅制限 (#38-C): 東証銘柄の指値が approximation band 外なら reject。
    if (
      inferWebullMarket(symbol) === 'JP' &&
      state.lastQuote &&
      !isWithinJpPriceBand(state.lastQuote.price, decision.orderIntent.price)
    ) {
      return {
        allowed: false,
        riskDecision: appendReason(
          decision.riskDecision,
          `JP price band: order price ${decision.orderIntent.price} outside band for reference ${state.lastQuote.price}`,
        ),
      }
    }

    const lock = {
      clientOrderId: decision.orderIntent.clientOrderId,
      side: decision.orderIntent.side,
      submittedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.pendingLockTtlMs).toISOString(),
    }
    const result = await this.positionStore.lockPendingOrder(symbol, lock)
    if (!result.ok) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, 'pending order already in flight'),
      }
    }

    return { allowed: true }
  }

  /**
   * Returns a rejection reason string when the spread gate blocks submit, or
   * null when the gate passes. Fail-closed: missing bid or ask is a reject
   * once a quote has been seeded.
   */
  private evaluateSpreadGate(
    symbol: string,
    lastQuote: QuoteSnapshot | null,
  ): string | null {
    if (lastQuote === null) return null

    const bid = lastQuote.bid
    const ask = lastQuote.ask
    if (bid === undefined || ask === undefined) {
      return 'spread unknown, bid/ask missing'
    }

    const market = inferWebullMarket(symbol)
    const limit = market === 'JP' ? this.spreadLimits.JP : this.spreadLimits.US
    const spreadPct = computeSpreadPct(bid, ask)
    if (spreadPct === null) {
      return 'spread invalid: crossed book, non-finite, or non-positive bid/ask'
    }
    if (spreadPct > limit) {
      return `spread ${(spreadPct * 100).toFixed(3)}% exceeds ${market} limit ${(limit * 100).toFixed(3)}%`
    }
    return null
  }

  private createOrderIntent(signal: Signal): OrderIntent | undefined {
    if (signal.action === 'HOLD') {
      return undefined
    }

    return {
      symbol: signal.symbol,
      side: signal.action,
      quantity: signal.quantity,
      price: signal.price,
      notional: signal.price * signal.quantity,
      clientOrderId: crypto.randomUUID().replaceAll('-', ''),
    }
  }
}

function evaluateGap(state: SymbolState, thresholdPct: number): string | null {
  const position = state.position
  const quote = state.lastQuote
  if (!position || !quote) return null
  if (!Number.isFinite(position.avgPrice) || position.avgPrice <= 0) return null
  const gap = (quote.price - position.avgPrice) / position.avgPrice
  if (Math.abs(gap) > thresholdPct) {
    return `gap re-eval: |${gap.toFixed(4)}| > ${thresholdPct} (avgPrice ${position.avgPrice} vs quote ${quote.price})`
  }
  return null
}

function endOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23, 59, 59, 999,
  ))
}

function appendReason(decision: RiskDecision, reason: string): RiskDecision {
  return {
    allowed: false,
    reasons: [...decision.reasons, reason],
    normalizedIntent: decision.normalizedIntent,
  }
}
