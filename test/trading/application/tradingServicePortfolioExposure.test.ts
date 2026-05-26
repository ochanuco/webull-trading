import { describe, expect, it } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PortfolioStore } from '../../../src/trading/state/PortfolioStore'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import {
  emptyPortfolioState,
  type PortfolioState,
} from '../../../src/trading/state/portfolioTypes'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const fixedNow = new Date('2026-04-21T14:00:00.000Z')

// Stretched maxOrderNotional so the per-symbol risk gate never trips before
// the portfolio exposure gate. The point of these tests is the exposure
// ceiling specifically (#77).
const baseConfig: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SOXL', '7203'],
  maxOrderNotional: 10_000_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

const buyUsd = {
  symbol: 'SOXL',
  price: 10,
  quantity: 50, // notional = 500
  buyBelow: 11,
  sellAbove: 999,
}

const buyJpy = {
  symbol: '7203',
  price: 1_000,
  quantity: 100, // notional = 100_000
  buyBelow: 1_100,
  sellAbove: 999_999,
}

function makePositionStore(state: SymbolState): PositionStore {
  return {
    async getState() {
      return state
    },
    async lockPendingOrder() {
      return { ok: true, state }
    },
    async clearPendingOrder() {
      return state
    },
    async recordFill() {
      return state
    },
    async addPendingSettlement() {
      return state
    },
    async setCooldown() {
      return state
    },
    async seedSettledCash() {
      return state
    },
    async overridePosition() {
      return state
    },
  }
}

function makePortfolioStore(initial: PortfolioState): PortfolioStore {
  let current = initial
  return {
    async getPortfolio() {
      return current
    },
    async seedDailyStartEquity(amount: number) {
      current = { ...current, dailyStartEquity: amount, dailyRealizedPnl: 0 }
      return current
    },
    async applyRealizedPnl(delta: number) {
      current = { ...current, dailyRealizedPnl: current.dailyRealizedPnl + delta }
      return current
    },
    async setTradingDisabledUntil(iso: string | null) {
      current = { ...current, tradingDisabledUntil: iso }
      return current
    },
    async applyFillExposure(args: {
      currency: 'USD' | 'JPY'
      side: 'BUY' | 'SELL'
      notional: number
    }) {
      const delta = args.side === 'BUY' ? args.notional : -args.notional
      if (args.currency === 'USD') {
        current = { ...current, openExposureUsd: Math.max(0, current.openExposureUsd + delta) }
      } else {
        current = { ...current, openExposureJpy: Math.max(0, current.openExposureJpy + delta) }
      }
      return current
    },
    async seedOpenExposure(args: { usd?: number; jpy?: number }) {
      current = {
        ...current,
        ...(args.usd !== undefined ? { openExposureUsd: args.usd } : {}),
        ...(args.jpy !== undefined ? { openExposureJpy: args.jpy } : {}),
      }
      return current
    },
    async rollDaily() {
      const before = current
      const nextStart = current.dailyStartEquity + current.dailyRealizedPnl
      current = { ...current, dailyStartEquity: nextStart, dailyRealizedPnl: 0 }
      return { before, after: current }
    },
  }
}

function makeService(
  positionStore: PositionStore,
  portfolioStore: PortfolioStore,
  opts: {
    totalCapitalUsd?: number | null
    totalCapitalJpy?: number | null
    maxPortfolioExposurePct?: number
    symbolCurrency?: Record<string, 'USD' | 'JPY'>
    buyBelow?: number
    sellAbove?: number
  } = {},
): TradingService {
  return new TradingService(
    new FixedRuleStrategy(opts.buyBelow ?? buyUsd.buyBelow, opts.sellAbove ?? buyUsd.sellAbove),
    new DefaultRiskPolicy(),
    new MockExecution(),
    {
      positionStore,
      portfolioStore,
      now: () => fixedNow,
      ...(opts.totalCapitalUsd !== undefined ? { totalCapitalUsd: opts.totalCapitalUsd } : {}),
      ...(opts.totalCapitalJpy !== undefined ? { totalCapitalJpy: opts.totalCapitalJpy } : {}),
      ...(opts.maxPortfolioExposurePct !== undefined
        ? { maxPortfolioExposurePct: opts.maxPortfolioExposurePct }
        : {}),
      symbolCurrency: opts.symbolCurrency ?? { SOXL: 'USD', '7203': 'JPY' },
    },
  )
}

describe('TradingService portfolio exposure gate (#77)', () => {
  it('rejects BUY when projected USD exposure exceeds the ceiling', async () => {
    // total_capital_usd = 1333, max_pct = 0.6 → ceiling = 799.8.
    // openExposure = 500, order = 500 → projected 1000 > 799.8 → reject.
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      openExposureUsd: 500,
    }
    const service = makeService(
      makePositionStore(emptySymbolState('SOXL', () => fixedNow)),
      makePortfolioStore(portfolio),
      { totalCapitalUsd: 1333, totalCapitalJpy: null, maxPortfolioExposurePct: 0.6 },
    )

    const result = await service.executeTrade(buyUsd, baseConfig)

    expect(result.riskDecision.allowed).toBe(false)
    expect(
      result.riskDecision.reasons.some((r) => r.includes('portfolio exposure exceeded')),
    ).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('allows BUY when projected exposure stays at or below the ceiling', async () => {
    // ceiling = 800 (= 1333 * 0.6). open 0 + order 500 = 500 ≤ 800.
    const portfolio: PortfolioState = emptyPortfolioState(() => fixedNow)
    const service = makeService(
      makePositionStore(emptySymbolState('SOXL', () => fixedNow)),
      makePortfolioStore(portfolio),
      { totalCapitalUsd: 1333, totalCapitalJpy: null, maxPortfolioExposurePct: 0.6 },
    )

    const result = await service.executeTrade(buyUsd, baseConfig)

    expect(result.riskDecision.allowed).toBe(true)
  })

  it('skips the gate when total_capital_usd is null (POC default)', async () => {
    // With null capital baseline, openExposure can be arbitrarily large but
    // the gate must not trigger — POC requirement is "fail-open until the
    // operator seeds a number".
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      openExposureUsd: 9_999_999,
    }
    const service = makeService(
      makePositionStore(emptySymbolState('SOXL', () => fixedNow)),
      makePortfolioStore(portfolio),
      { totalCapitalUsd: null, totalCapitalJpy: null },
    )

    const result = await service.executeTrade(buyUsd, baseConfig)

    expect(result.riskDecision.allowed).toBe(true)
  })

  it('treats USD and JPY budgets independently (USD exposure does not consume JPY ceiling)', async () => {
    // USD heavily exposed but a JPY BUY still passes because the JPY budget
    // is untouched.
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      openExposureUsd: 1_000_000,
    }
    const service = makeService(
      makePositionStore(emptySymbolState('7203', () => fixedNow)),
      makePortfolioStore(portfolio),
      {
        totalCapitalUsd: 1_000,
        totalCapitalJpy: 1_000_000,
        maxPortfolioExposurePct: 0.6,
        buyBelow: buyJpy.buyBelow,
        sellAbove: buyJpy.sellAbove,
      },
    )

    const result = await service.executeTrade(buyJpy, baseConfig)

    expect(result.riskDecision.allowed).toBe(true)
  })

  it('SELL is never rejected by the exposure gate even when exposure is over-ceiling', async () => {
    // SELLs reduce exposure; the gate only applies to BUYs.
    const sellInput = {
      symbol: 'SOXL',
      price: 20, // strategy → SELL when > 15
      quantity: 5,
      buyBelow: 5,
      sellAbove: 15,
    }
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      openExposureUsd: 10_000,
    }
    const symbolState: SymbolState = {
      ...emptySymbolState('SOXL', () => fixedNow),
      position: { qty: 5, avgPrice: 18, openedAt: '2026-04-20T00:00:00.000Z' },
    }
    const service = new TradingService(
      new FixedRuleStrategy(sellInput.buyBelow, sellInput.sellAbove),
      new DefaultRiskPolicy(),
      new MockExecution(),
      {
        positionStore: makePositionStore(symbolState),
        portfolioStore: makePortfolioStore(portfolio),
        now: () => fixedNow,
        totalCapitalUsd: 100,
        maxPortfolioExposurePct: 0.6,
        symbolCurrency: { SOXL: 'USD' },
      },
    )

    const result = await service.executeTrade(sellInput, baseConfig)

    expect(result.riskDecision.allowed).toBe(true)
    expect(
      result.riskDecision.reasons.some((r) => r.includes('portfolio exposure exceeded')),
    ).toBe(false)
  })
})
