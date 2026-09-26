import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'
import type { Execution } from '../execution/Execution'
import type { RiskPolicy } from '../risk/RiskPolicy'
import { evaluatePerSymbolRisk } from '../risk/perSymbolRiskGate'
import type { PortfolioStore } from '../state/PortfolioStore'
import type { PositionStore } from '../state/PositionStore'
import type { Strategy, StrategyInput } from '../strategy/Strategy'
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
  /** Account-wide equity / realized PnL / kill switch — separate from {@link PositionStore}, which is per-symbol. */
  portfolioStore?: PortfolioStore
  /** Fraction of `dailyStartEquity`; the kill switch arms and rejects every submit until EOD once `dailyRealizedPnl / dailyStartEquity` falls to or below this. Default -0.02. */
  drawdownKillThreshold?: number
  /** How long a pending-order lock stays live before a new submit can replace it. */
  pendingLockTtlMs?: number
  /** Bidirectional map of structurally anti-correlated symbols. An open position in the inverse blocks a BUY (P&L decay trap). */
  inversePairs?: Record<string, string>
  /** Per-market spread ceiling as a fraction of mid price; a submit is rejected once `(ask - bid) / mid` exceeds it. Default US 0.25% / JP 0.60%. */
  spreadLimits?: { US: number; JP: number }
  /** Max age (ms) of `state.lastQuote.fetchedAt` before a submit is rejected as if halted. */
  staleQuoteMs?: number
  /** Reject threshold (ratio) for the gap between an open position's avgPrice and `lastQuote.price`. */
  gapRejectPct?: number
  /** Portfolio-wide BUY exposure ceiling as a fraction of per-currency total capital; rejects when `openExposure[currency] + orderNotional` would exceed it. Default 0.6. */
  maxPortfolioExposurePct?: number
  /** Account-wide capital baseline per currency. `null` disables the exposure gate for that currency (fail-open until an operator seeds a value). */
  totalCapitalUsd?: number | null
  totalCapitalJpy?: number | null
  /** Symbol → currency lookup from `symbol_config`, used by the portfolio exposure gate; falls back to a JP 4-digit heuristic when missing. */
  symbolCurrency?: Record<string, 'USD' | 'JPY'>
  now?: () => Date
}

const DEFAULT_PENDING_LOCK_TTL_MS = 60_000
const DEFAULT_SPREAD_LIMITS = { US: 0.0025, JP: 0.006 } as const
const DEFAULT_STALE_QUOTE_MS = 15 * 60 * 1_000
const DEFAULT_GAP_REJECT_PCT = 0.03
const DEFAULT_DRAWDOWN_KILL_THRESHOLD = -0.02
const DEFAULT_MAX_PORTFOLIO_EXPOSURE_PCT = 0.6

export class TradingService {
  private readonly positionStore?: PositionStore
  private readonly portfolioStore?: PortfolioStore
  private readonly drawdownKillThreshold: number
  private readonly pendingLockTtlMs: number
  private readonly inversePairs: Record<string, string>
  private readonly spreadLimits: { US: number; JP: number }
  private readonly staleQuoteMs: number
  private readonly gapRejectPct: number
  private readonly maxPortfolioExposurePct: number
  private readonly totalCapitalUsd: number | null
  private readonly totalCapitalJpy: number | null
  private readonly symbolCurrency: Record<string, 'USD' | 'JPY'>
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
    this.maxPortfolioExposurePct =
      options.maxPortfolioExposurePct !== undefined &&
      Number.isFinite(options.maxPortfolioExposurePct) &&
      options.maxPortfolioExposurePct > 0 &&
      options.maxPortfolioExposurePct <= 1
        ? options.maxPortfolioExposurePct
        : DEFAULT_MAX_PORTFOLIO_EXPOSURE_PCT
    this.totalCapitalUsd = sanitizeTotalCapital(options.totalCapitalUsd)
    this.totalCapitalJpy = sanitizeTotalCapital(options.totalCapitalJpy)
    this.symbolCurrency = options.symbolCurrency ?? {}
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

    // Evaluated before the pending-order lock below so a kill-switched or
    // drawdown-halted account never takes a lock it can't use.
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

      // SELL reduces exposure, so only BUY is checked. An unset
      // `total_capital_<currency>` leaves the gate disabled rather than
      // fail-closing every entry against an unseeded 0 ceiling.
      if (decision.orderIntent.side === 'BUY') {
        const currency = this.resolveSymbolCurrency(decision.orderIntent.symbol)
        const totalCapital = currency === 'USD' ? this.totalCapitalUsd : this.totalCapitalJpy
        if (totalCapital !== null) {
          const ceiling = totalCapital * this.maxPortfolioExposurePct
          const current =
            currency === 'USD' ? portfolio.openExposureUsd : portfolio.openExposureJpy
          const projected = current + decision.orderIntent.notional
          if (projected > ceiling) {
            return {
              allowed: false,
              riskDecision: appendReason(
                decision.riskDecision,
                `portfolio exposure exceeded: ${currency} projected ${projected.toFixed(2)} > ceiling ${ceiling.toFixed(2)} (open ${current.toFixed(2)} + order ${decision.orderIntent.notional.toFixed(2)}; cap ${totalCapital} * ${this.maxPortfolioExposurePct})`,
              ),
            }
          }
        }
      }
    }

    // Fetched up front because evaluatePerSymbolRisk is a synchronous pure function.
    const inverseSymbol = decision.orderIntent.side === 'BUY'
      ? this.inversePairs[symbol.toUpperCase()]
      : undefined
    const inverseState = inverseSymbol
      ? await this.positionStore.getState(inverseSymbol)
      : null

    const perSymbol = evaluatePerSymbolRisk(
      {
        symbol,
        side: decision.orderIntent.side,
        intentPrice: decision.orderIntent.price,
        intentNotional: decision.orderIntent.notional,
        state,
        inverseState,
        now,
      },
      {
        inversePairs: this.inversePairs,
        spreadLimits: this.spreadLimits,
        staleQuoteMs: this.staleQuoteMs,
        gapRejectPct: this.gapRejectPct,
        evaluateCooldown: true,
      },
    )
    if (!perSymbol.approved) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, perSymbol.reasons[0] ?? 'per-symbol risk reject'),
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

  private resolveSymbolCurrency(symbol: string): 'USD' | 'JPY' {
    const upper = symbol.toUpperCase()
    const mapped = this.symbolCurrency[upper]
    if (mapped === 'USD' || mapped === 'JPY') return mapped
    // Matches `routes/trade.ts`'s heuristic. The gate only fires when
    // `total_capital_<currency>` is set, so a misclassified symbol on an
    // unseeded currency still routes through rather than false-rejecting.
    return /^\d{4}$/.test(upper) ? 'JPY' : 'USD'
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

function sanitizeTotalCapital(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return value
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
