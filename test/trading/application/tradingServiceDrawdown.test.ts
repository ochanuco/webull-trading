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

const fixedNow = new Date('2026-04-20T14:00:00.000Z')

const config: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SOXL'],
  maxOrderNotional: 1_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

const buyInput = {
  symbol: 'SOXL',
  price: 9,
  quantity: 3,
  buyBelow: 10,
  sellAbove: 20,
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
  }
}

function makePortfolioStore(initial: PortfolioState): {
  store: PortfolioStore
  captured: { setDisabledCalls: Array<string | null> }
  current: () => PortfolioState
} {
  let current = initial
  const captured = { setDisabledCalls: [] as Array<string | null> }
  const store: PortfolioStore = {
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
      captured.setDisabledCalls.push(iso)
      current = { ...current, tradingDisabledUntil: iso }
      return current
    },
  }
  return { store, captured, current: () => current }
}

function makeService(positionStore: PositionStore, portfolioStore: PortfolioStore): TradingService {
  return new TradingService(
    new FixedRuleStrategy(buyInput.buyBelow, buyInput.sellAbove),
    new DefaultRiskPolicy(),
    new MockExecution(),
    { positionStore, portfolioStore, now: () => fixedNow },
  )
}

describe('TradingService drawdown kill switch', () => {
  it('rejects BUY when realized PnL breaches the -2% threshold and arms tradingDisabledUntil', async () => {
    const symbolState = emptySymbolState('SOXL', () => fixedNow)
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      dailyStartEquity: 100_000,
      dailyRealizedPnl: -2_000,
    }
    const { store, captured } = makePortfolioStore(portfolio)

    const result = await makeService(makePositionStore(symbolState), store).executeTrade(
      buyInput,
      config,
    )

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('daily drawdown kill'))).toBe(true)
    expect(captured.setDisabledCalls).toHaveLength(1)
    expect(captured.setDisabledCalls[0]).toMatch(/^2026-04-20T23:59:59\.999Z$/)
    expect(result.executionResult).toBeUndefined()
  })

  it('does not reject when realized PnL is above threshold (-1%)', async () => {
    const symbolState = emptySymbolState('SOXL', () => fixedNow)
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      dailyStartEquity: 100_000,
      dailyRealizedPnl: -1_000,
    }
    const { store, captured } = makePortfolioStore(portfolio)

    const result = await makeService(makePositionStore(symbolState), store).executeTrade(
      buyInput,
      config,
    )

    expect(result.riskDecision.allowed).toBe(true)
    expect(captured.setDisabledCalls).toEqual([])
  })

  it('rejects submits while tradingDisabledUntil is in the future even before threshold is re-evaluated', async () => {
    const symbolState = emptySymbolState('SOXL', () => fixedNow)
    const portfolio: PortfolioState = {
      ...emptyPortfolioState(() => fixedNow),
      dailyStartEquity: 100_000,
      dailyRealizedPnl: 0,
      tradingDisabledUntil: '2026-04-20T23:59:59.999Z',
    }
    const { store } = makePortfolioStore(portfolio)

    const result = await makeService(makePositionStore(symbolState), store).executeTrade(
      buyInput,
      config,
    )

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('trading disabled until'))).toBe(true)
  })

  it('allows the BUY when portfolio equity is unseeded (fail-open)', async () => {
    const symbolState = emptySymbolState('SOXL', () => fixedNow)
    const { store } = makePortfolioStore(emptyPortfolioState(() => fixedNow))

    const result = await makeService(makePositionStore(symbolState), store).executeTrade(
      buyInput,
      config,
    )

    expect(result.riskDecision.allowed).toBe(true)
  })
})
