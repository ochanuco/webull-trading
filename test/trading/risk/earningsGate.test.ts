import { describe, expect, it, vi } from 'vitest'
import {
  evaluateEarningsGate,
  type EarningsGateConfig,
} from '../../../src/trading/risk/earningsGate'
import type {
  EarningsCalendarRepo,
  EarningsCalendarSeedInput,
} from '../../../src/infrastructure/calendar/earningsCalendarRepo'
import type { EarningsCalendarRow } from '../../../src/infrastructure/db/schema'

/**
 * Tests for the earnings calendar gate (#196 1/3).
 *
 * 観点:
 *   - ±1 営業日以内 → reject (BUY)
 *   - 範囲外 → approve
 *   - 該当 row なし → approve
 *   - SELL → 常に approve (撤退路を妨げない)
 *   - DB read 失敗 → fail-closed reject
 *   - 営業日計算 (土日/祝日 skip) が正しく窓に効いている
 */

const baseConfig: EarningsGateConfig = { freezeBusinessDays: 1 }

function row(symbol: string, date: string, id = 1): EarningsCalendarRow {
  return {
    id,
    symbol: symbol.toUpperCase(),
    earningsDate: date,
    notes: null,
    createdAt: '2026-04-21T00:00:00.000Z',
  }
}

function fakeRepo(rows: EarningsCalendarRow[]): EarningsCalendarRepo & {
  calls: Array<{ symbol: string; from: string; to: string }>
} {
  const calls: Array<{ symbol: string; from: string; to: string }> = []
  return {
    calls,
    async fetchByRange(symbol, from, to) {
      calls.push({ symbol: symbol.toUpperCase(), from, to })
      return rows.filter(
        (r) => r.symbol === symbol.toUpperCase() && r.earningsDate >= from && r.earningsDate <= to,
      )
    },
    async fetchBySymbol(symbol) {
      return rows.filter((r) => r.symbol === symbol.toUpperCase())
    },
    async bulkUpsert(_records: EarningsCalendarSeedInput[]) {
      return { inserted: 0, skipped: 0 }
    },
    async deleteById(_id: number) {
      return false
    },
  }
}

describe('evaluateEarningsGate — base behaviour', () => {
  it('approves when no earnings row exists for the symbol', async () => {
    const repo = fakeRepo([])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reason).toBeUndefined()
    expect(repo.calls).toHaveLength(1)
  })

  it('always approves SELL regardless of earnings proximity', async () => {
    const repo = fakeRepo([row('AAPL', '2026-04-20')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'SELL' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(repo.calls).toHaveLength(0)
  })
})

describe('evaluateEarningsGate — within window', () => {
  it('rejects on the earnings day itself', async () => {
    const repo = fakeRepo([row('AAPL', '2026-04-20')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('earnings_within_1bd: 2026-04-20')
  })

  it('rejects 1 business day before earnings', async () => {
    // earnings on Tue 2026-04-21, evaluating on Mon 2026-04-20 (1 BD ahead)
    const repo = fakeRepo([row('AAPL', '2026-04-21')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('earnings_within_1bd: 2026-04-21')
  })

  it('rejects 1 business day after earnings', async () => {
    // earnings on Mon 2026-04-20, evaluating on Tue 2026-04-21
    const repo = fakeRepo([row('AAPL', '2026-04-20')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-21', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('earnings_within_1bd: 2026-04-20')
  })

  it('rejects across a weekend (Friday earnings, Monday eval = 1 BD)', async () => {
    // Friday earnings 2026-04-17, Monday eval 2026-04-20 — 3 calendar days but
    // 1 business day with weekend skip, must reject under freezeBusinessDays=1.
    const repo = fakeRepo([row('AAPL', '2026-04-17')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('2026-04-17')
  })
})

describe('evaluateEarningsGate — outside window', () => {
  it('approves 2 business days before earnings (range exclusive)', async () => {
    // Friday earnings 2026-04-24, eval Tuesday 2026-04-21 — 2 business days
    // gap (Wed and Thu) under freezeBusinessDays=1.
    const repo = fakeRepo([row('AAPL', '2026-04-24')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-21', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves 2 business days after earnings', async () => {
    // earnings Mon 2026-04-20, eval Wed 2026-04-22 — 2 business days gap.
    const repo = fakeRepo([row('AAPL', '2026-04-20')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-22', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('does not match a different symbol with a same-day earnings row', async () => {
    const repo = fakeRepo([row('MSFT', '2026-04-20')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })
})

describe('evaluateEarningsGate — fail-closed paths', () => {
  it('rejects when D1 read throws (fail-closed)', async () => {
    const repo: EarningsCalendarRepo = {
      async fetchByRange() {
        throw new Error('d1 connection lost')
      },
      async fetchBySymbol() {
        return []
      },
      async bulkUpsert() {
        return { inserted: 0, skipped: 0 }
      },
      async deleteById() {
        return false
      },
    }
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('earnings_gate_fetch_failed')
    expect(decision.reason).toContain('d1 connection lost')
  })

  it('rejects on invalid evalDate', async () => {
    const repo = fakeRepo([])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: 'not-a-date', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('earnings_gate_invalid_eval_date')
  })

  it('reports the nearest earnings date when multiple rows are within window', async () => {
    const repo = fakeRepo([row('AAPL', '2026-04-19', 1), row('AAPL', '2026-04-21', 2)])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    // both within ±1 BD; reason picks the earliest deterministically
    expect(decision.reason).toBe('earnings_within_1bd: 2026-04-19')
  })
})

describe('evaluateEarningsGate — config sanitisation', () => {
  it('clamps negative freezeBusinessDays to default 1', async () => {
    const repo = fakeRepo([row('AAPL', '2026-04-21')])
    const decision = await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      { freezeBusinessDays: -3 },
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('earnings_within_1bd: 2026-04-21')
  })

  it('clamps absurdly large freezeBusinessDays to 30', async () => {
    const repo = fakeRepo([row('AAPL', '2026-04-21')])
    const fetchSpy = vi.spyOn(repo, 'fetchByRange')
    await evaluateEarningsGate(
      { symbol: 'AAPL', evalDate: '2026-04-20', side: 'BUY' },
      repo,
      { freezeBusinessDays: 9999 },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]!
    // window expanded to ±30 BD around 2026-04-20 — `from` should be well
    // before, `to` well after.
    expect(call[1] < '2026-04-01').toBe(true)
    expect(call[2] > '2026-05-01').toBe(true)
  })
})
