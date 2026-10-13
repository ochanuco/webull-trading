import { describe, expect, it } from 'vitest'
import { evaluatePromotionGate, type GateRun } from '../../../src/trading/models/promotionGate'
import type { ReplayMetrics } from '../../../src/trading/models/replay'

const NOW = new Date('2026-10-13T00:00:00.000Z')

function metrics(overrides: Partial<ReplayMetrics> = {}): ReplayMetrics {
  return {
    totalReturn: 0.12,
    sharpeRatio: 1.1,
    maxDrawdownPct: -0.1,
    totalTrades: 30,
    winRate: 0.55,
    profitFactor: 1.6,
    avgTradeReturn: 0.01,
    avgHoldingDays: 6,
    exitReasons: { TP: 12, STOP: 10, TIME_STOP: 8, END_OF_DATA: 0 },
    pnlByCurrency: { USD: 1200, JPY: 0 },
    ...overrides,
  }
}

function run(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: 10,
    purpose: 'out_of_sample',
    symbols: ['SOXL', 'SOXS'],
    fromDate: '2025-01-01',
    toDate: '2025-12-31',
    createdAt: '2026-10-10T00:00:00.000Z',
    metrics: metrics(),
    ...overrides,
  }
}

function failedChecks(result: ReturnType<typeof evaluatePromotionGate>): string[] {
  return result.checks.filter((c) => c.passed === false).map((c) => c.name)
}

describe('evaluatePromotionGate', () => {
  it('fails without an out-of-sample run', () => {
    const result = evaluatePromotionGate({ candidateRuns: [run({ purpose: 'in_sample' })], activeRuns: [], now: NOW })
    expect(result.passed).toBe(false)
    expect(failedChecks(result)).toEqual(['oos_run_exists'])
  })

  it('passes a fresh OOS run that clears every threshold; inapplicable checks do not block', () => {
    const result = evaluatePromotionGate({ candidateRuns: [run()], activeRuns: [], now: NOW })
    expect(result.passed).toBe(true)
    expect(result.evidenceRunIds).toEqual([10])
    expect(result.checks.find((c) => c.name === 'beats_active_model')?.passed).toBeNull()
  })

  it.each([
    ['min_trades', { totalTrades: 19 }],
    ['profit_factor', { profitFactor: 1.1 }],
    ['profit_factor', { profitFactor: null }],
    ['total_return', { totalReturn: 0 }],
    ['max_drawdown', { maxDrawdownPct: -0.3 }],
  ] as const)('fails %s', (name, override) => {
    const result = evaluatePromotionGate({ candidateRuns: [run({ metrics: metrics(override) })], activeRuns: [], now: NOW })
    expect(result.passed).toBe(false)
    expect(failedChecks(result)).toEqual([name])
  })

  it('fails stale evidence', () => {
    const result = evaluatePromotionGate({
      candidateRuns: [run({ createdAt: '2026-08-01T00:00:00.000Z' })],
      activeRuns: [],
      now: NOW,
    })
    expect(failedChecks(result)).toEqual(['evidence_fresh'])
  })

  it('uses the latest OOS run as evidence', () => {
    const result = evaluatePromotionGate({
      candidateRuns: [run({ id: 11, metrics: metrics({ totalTrades: 5 }) }), run({ id: 10 })],
      activeRuns: [],
      now: NOW,
    })
    expect(result.evidenceRunIds[0]).toBe(11)
    expect(failedChecks(result)).toEqual(['min_trades'])
  })

  it('fails when the OOS window overlaps the in-sample window', () => {
    const result = evaluatePromotionGate({
      candidateRuns: [run({ id: 9, purpose: 'in_sample', fromDate: '2023-01-01', toDate: '2025-06-30' }), run()],
      activeRuns: [],
      now: NOW,
    })
    expect(failedChecks(result)).toEqual(['oos_after_in_sample'])
    expect(result.evidenceRunIds).toEqual([10, 9])
  })

  it('fails when OOS sharpe collapses versus in-sample (overfit)', () => {
    const result = evaluatePromotionGate({
      candidateRuns: [
        run({ id: 9, purpose: 'in_sample', fromDate: '2022-01-01', toDate: '2024-12-31', metrics: metrics({ sharpeRatio: 3 }) }),
        run({ metrics: metrics({ sharpeRatio: 1.2 }) }),
      ],
      activeRuns: [],
      now: NOW,
    })
    expect(failedChecks(result)).toEqual(['oos_sharpe_retention'])
  })

  it('compares against the active model only on an identical window', () => {
    const sameWindow = run({ id: 3, symbols: ['SOXS', 'SOXL'], metrics: metrics({ sharpeRatio: 1.5 }) })
    const otherWindow = run({ id: 4, fromDate: '2024-01-01', metrics: metrics({ sharpeRatio: 9 }) })
    const result = evaluatePromotionGate({ candidateRuns: [run()], activeRuns: [sameWindow, otherWindow], now: NOW })
    expect(failedChecks(result)).toEqual(['beats_active_model'])
    expect(result.evidenceRunIds).toEqual([10, 3])
  })
})
