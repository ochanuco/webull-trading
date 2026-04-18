import type { BarClient } from '../../infrastructure/quotes/BarClient'
import type { Execution } from '../execution/Execution'
import type { PositionStore } from '../state/PositionStore'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from './indicators'
import { computePullbackSizing } from './pullbackSizing'
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import {
  DEFAULT_RULE,
  PullbackUptrendStrategy,
  type SymbolRule,
} from './strategies/PullbackUptrendStrategy'

const DEFAULT_BAR_LOOKBACK = 60

export interface PullbackSchedulerOptions {
  symbols: string[]
  equity: number
  barClient: BarClient
  positionStore: PositionStore
  execution: Execution
  strategy?: PullbackUptrendStrategy
  rulesMap?: Record<string, SymbolRule>
  symbolCapMap?: Record<string, number>
  barLookback?: number
  riskPerTradePct?: number
  pendingLockTtlMs?: number
  now?: () => Date
}

export interface PullbackRunSummary {
  evaluated: number
  buys: number
  sells: number
  holds: number
  rejected: Array<{ symbol: string; reason: string }>
  errors: Array<{ symbol: string; message: string }>
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
  const strategy =
    options.strategy ?? new PullbackUptrendStrategy(options.rulesMap ?? {})
  const pendingLockTtlMs = options.pendingLockTtlMs ?? 60_000
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
  }

  for (const symbol of options.symbols) {
    summary.evaluated += 1
    const upper = symbol.toUpperCase()
    let bars: DailyBar[]
    try {
      bars = await options.barClient.getDailyBars(symbol, lookback)
    } catch (error) {
      summary.errors.push({ symbol: upper, message: messageOf(error) })
      continue
    }

    const indicators = computePullbackIndicators(bars)
    if (!indicators) {
      summary.rejected.push({ symbol: upper, reason: 'insufficient bars for indicators' })
      continue
    }

    const state = await options.positionStore.getState(upper)
    const holdBusinessDays =
      state.position !== null ? computeHoldBusinessDays(state.position.openedAt, now()) : 0

    const signal = strategy.decide({
      symbol: upper,
      indicators,
      position: state.position,
      pendingOrder: state.pendingOrder,
      cooldownUntil: state.cooldownUntil,
      holdBusinessDays,
      now: now(),
    })

    if (signal.action === 'HOLD') {
      summary.holds += 1
      continue
    }

    let intent: OrderIntent
    if (signal.action === 'BUY') {
      const rule = strategy.resolveRule(upper)
      const sizing = computePullbackSizing({
        equity: options.equity,
        entryPrice: indicators.price,
        stopPct: rule.stopPct,
        atr20: indicators.atr20,
        baselineAtr20: indicators.baselineAtr20,
        symbolCap: options.symbolCapMap?.[upper],
        riskPerTradePct: options.riskPerTradePct,
      })
      if (sizing.quantity <= 0) {
        summary.rejected.push({
          symbol: upper,
          reason: `sizing rejected: ${sizing.capReason ?? 'zero qty'}`,
        })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        summary.rejected.push({ symbol: upper, reason: `invalid price: ${indicators.price}` })
        continue
      }
      const notional = sizing.quantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        summary.rejected.push({ symbol: upper, reason: `invalid notional: ${notional} (qty=${sizing.quantity}, price=${indicators.price})` })
        continue
      }
      intent = buildIntent(upper, 'BUY', sizing.quantity, indicators.price)
    } else {
      // SELL: close the full open position.
      if (state.position === null) {
        summary.rejected.push({ symbol: upper, reason: 'SELL without position' })
        continue
      }
      if (!Number.isFinite(state.position.qty) || state.position.qty <= 0) {
        summary.rejected.push({ symbol: upper, reason: `invalid position qty: ${state.position.qty}` })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        summary.rejected.push({ symbol: upper, reason: `invalid price: ${indicators.price}` })
        continue
      }
      const notional = state.position.qty * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        summary.rejected.push({ symbol: upper, reason: `invalid notional: ${notional} (qty=${state.position.qty}, price=${indicators.price})` })
        continue
      }
      intent = buildIntent(upper, 'SELL', state.position.qty, indicators.price)
    }

    const expiresAtMs = now().getTime() + pendingLockTtlMs
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      summary.rejected.push({ symbol: upper, reason: `invalid expiresAt computed from pendingLockTtlMs: ${pendingLockTtlMs}` })
      continue
    }
    const lockResult = await options.positionStore.lockPendingOrder(upper, {
      clientOrderId: intent.clientOrderId,
      side: intent.side,
      submittedAt: now().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
    if (!lockResult.ok) {
      summary.rejected.push({ symbol: upper, reason: 'pending order already in flight' })
      continue
    }

    let result: ExecutionResult | undefined
    try {
      result = await options.execution.execute(intent)
    } catch (error) {
      await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
      summary.errors.push({ symbol: upper, message: messageOf(error) })
      continue
    }

    // Increment counters only after successful execution.
    if (intent.side === 'BUY') {
      summary.buys += 1
    } else {
      summary.sells += 1
    }

    if (result.mode === 'DRY_RUN') {
      // No broker event will clear the lock; release it eagerly.
      await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
    }
  }

  return summary
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

// Re-export DEFAULT_RULE so callers can seed options without another import.
export { DEFAULT_RULE }