/**
 * Parity test: same SymbolState + same risk config must yield the same
 * pass/reject decision via TradingService.executeTrade() (manual route)
 * AND via runPullbackScheduler (cron route). Anchors issue #138 — both
 * call sites are wired to the shared `evaluatePerSymbolRisk` pure helper.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BarClient } from '../../../src/infrastructure/quotes/BarClient'
import {
  TradingService,
  type TradingConfig,
} from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import {
  evaluatePerSymbolRisk,
  type PerSymbolRiskConfig,
} from '../../../src/trading/risk/perSymbolRiskGate'
import type { Execution } from '../../../src/trading/execution/Execution'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import {
  emptySymbolState,
  type SymbolState,
} from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'
import { runPullbackScheduler } from '../../../src/trading/strategy/pullbackScheduler'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const now = new Date('2026-04-21T14:30:00.000Z')

const riskConfig: PerSymbolRiskConfig = {
  inversePairs: { SOXL: 'SOXS' },
  spreadLimits: { US: 0.0025, JP: 0.006 },
  staleQuoteMs: 15 * 60 * 1_000,
  gapRejectPct: 0.03,
}

function uptrendBars(): DailyBar[] {
  // #318: 20d return + 10d high で BUY 成立する形状。
  // closes[-20] ≈ 108 (bar 40)、last = 117.5、20d return ≈ +8.8% (> +8% threshold)。
  const bars: DailyBar[] = []
  for (let i = 0; i < 40; i += 1) bars.push(synth(i, 100 + i * 0.2))
  for (let i = 40; i < 55; i += 1) bars.push(synth(i, 108 + (i - 40) * 1.0))
  bars.push(synth(55, 122))
  bars.push(synth(56, 121))
  bars.push(synth(57, 120))
  bars.push(synth(58, 118))
  bars.push(synth(59, 117.5))
  return bars
}

function synth(i: number, close: number): DailyBar {
  const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  return { date, open: close, high: close * 1.005, low: close * 0.995, close }
}

function makeStore(states: Record<string, SymbolState>): PositionStore {
  return {
    async getState(symbol) {
      return states[symbol.toUpperCase()] ?? emptySymbolState(symbol, () => now)
    },
    async lockPendingOrder() {
      return { ok: true, state: emptySymbolState('_', () => now) }
    },
    async clearPendingOrder(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async recordFill(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async addPendingSettlement(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async setCooldown(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async seedSettledCash(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async overridePosition(symbol) {
      return emptySymbolState(symbol, () => now)
    },
  }
}

function mockBarClient(): BarClient {
  return { getDailyBars: vi.fn(async () => uptrendBars()) }
}

function mockExecution(): Execution & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async execute(intent) {
      calls.push(intent)
      return { mode: 'DRY_RUN', submitted: true, brokerOrderId: 'dry-run-1' }
    },
  }
}

describe('per-symbol risk gate parity (TradingService vs runPullbackScheduler) — #138', () => {
  // 各シナリオで:
  //   1. pure helper の判定
  //   2. TradingService.executeTrade() の `riskDecision`
  //   3. runPullbackScheduler の REJECT decision
  // が同じ reason で reject (or 同じく approve) することを確認する。

  const tradingConfig: TradingConfig = {
    dryRun: true,
    tradingEnabled: true,
    allowedSymbols: ['AAPL', 'SOXL'],
    maxOrderNotional: 1_000_000,
    symbolMaxNotional: {},
    marketHoursCheck: false,
  }

  function tradingService(store: PositionStore) {
    return new TradingService(
      // FixedRuleStrategy: any input below 10000 → BUY
      new FixedRuleStrategy(10_000, 20_000),
      new DefaultRiskPolicy(),
      new MockExecution(),
      {
        positionStore: store,
        inversePairs: riskConfig.inversePairs,
        spreadLimits: riskConfig.spreadLimits,
        staleQuoteMs: riskConfig.staleQuoteMs,
        gapRejectPct: riskConfig.gapRejectPct,
        now: () => now,
      },
    )
  }

  it('stale quote rejects in all 3 evaluators with the same reason', async () => {
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      lastQuote: {
        price: 118,
        asOf: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        fetchedAt: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        source: 'test',
        bid: 117.9,
        ask: 118.1,
      },
    }

    // Pure helper
    const pure = evaluatePerSymbolRisk(
      { symbol: 'AAPL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      riskConfig,
    )
    expect(pure.approved).toBe(false)
    expect(pure.reasons[0]).toContain('halt or stale quote')

    // Manual / TradingService route
    const store = makeStore({ AAPL: state })
    const result = await tradingService(store).executeTrade(
      { symbol: 'AAPL', price: 9, quantity: 1 },
      tradingConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('halt or stale quote'))).toBe(true)

    // Cron / runPullbackScheduler route
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(),
      positionStore: makeStore({ AAPL: state }),
      execution: mockExecution(),
      perSymbolRisk: riskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('halt or stale quote')
  })

  it('inverse-pair exposure rejects in all 3 evaluators with the same reason', async () => {
    const inverse: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
    }
    const subjectState = emptySymbolState('SOXL', () => now)

    // Pure helper (caller must pre-fetch inverseState)
    const pure = evaluatePerSymbolRisk(
      {
        symbol: 'SOXL',
        side: 'BUY',
        intentPrice: 9,
        intentNotional: 9,
        state: subjectState,
        inverseState: inverse,
        now,
      },
      riskConfig,
    )
    expect(pure.approved).toBe(false)
    expect(pure.reasons[0]).toContain('inverse-pair exposure')

    // Manual / TradingService route — store fetches inverse internally.
    const tradingStore = makeStore({ SOXS: inverse, SOXL: subjectState })
    const result = await tradingService(tradingStore).executeTrade(
      { symbol: 'SOXL', price: 9, quantity: 1 },
      tradingConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('inverse-pair exposure'))).toBe(true)

    // Cron / runPullbackScheduler — pre-fetches inverse symbol state.
    const cronStore = makeStore({ SOXS: inverse, SOXL: subjectState })
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(),
      positionStore: cronStore,
      execution: mockExecution(),
      perSymbolRisk: riskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('inverse-pair exposure')
  })

  it('SELL passes the stale-quote gate (exit priority — TradingService)', async () => {
    // Anchors the SOXL stop-hit bug: SELL must NOT be blocked by stale lastQuote.
    // (cron path drives BUY-only via runPullbackScheduler, so this assertion is
    // limited to TradingService — the manual / liquidate / exit code path.)
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 1, avgPrice: 124.95, openedAt: now.toISOString() },
      lastQuote: {
        price: 119.38,
        asOf: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1_000).toISOString(),
        fetchedAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1_000).toISOString(),
        source: 'test',
        bid: 119.3,
        ask: 119.46,
      },
    }

    // Pure helper: SELL bypasses the stale gate entirely.
    const pure = evaluatePerSymbolRisk(
      { symbol: 'AAPL', side: 'SELL', intentPrice: 119.38, intentNotional: 119.38, state, now },
      riskConfig,
    )
    expect(pure.approved).toBe(true)

    // TradingService route: price >= sellAbove (20_000) triggers SELL via FixedRuleStrategy.
    const result = await tradingService(makeStore({ AAPL: state })).executeTrade(
      { symbol: 'AAPL', price: 25_000, quantity: 1 },
      tradingConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
    expect(
      result.riskDecision.reasons.some((r) => r.includes('halt or stale quote')),
    ).toBe(false)
  })

  it('clean state approves in all 3 evaluators', async () => {
    const cleanState = emptySymbolState('AAPL', () => now)

    const pure = evaluatePerSymbolRisk(
      { symbol: 'AAPL', side: 'BUY', intentPrice: 9, intentNotional: 9, state: cleanState, now },
      riskConfig,
    )
    expect(pure.approved).toBe(true)

    const result = await tradingService(makeStore({ AAPL: cleanState })).executeTrade(
      { symbol: 'AAPL', price: 9, quantity: 1 },
      tradingConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)

    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(),
      positionStore: makeStore({ AAPL: cleanState }),
      execution: mockExecution(),
      perSymbolRisk: riskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
  })
})
