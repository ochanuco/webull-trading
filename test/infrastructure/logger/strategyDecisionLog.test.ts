import { describe, expect, it, vi } from 'vitest'
import { logStrategyDecision } from '../../../src/infrastructure/logger/strategyDecisionLog'

function fakeDb() {
  const inserted: Record<string, unknown>[] = []
  const db = {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v)
      },
    }),
  }
  return { db: db as unknown as Parameters<typeof logStrategyDecision>[0], inserted }
}

describe('logStrategyDecision', () => {
  it('persists traceJson when provided (#decision-trace)', async () => {
    const { db, inserted } = fakeDb()
    await logStrategyDecision(db, {
      timestamp: '2026-06-06T00:00:00.000Z',
      symbol: 'TQQQ',
      decision: 'HOLD',
      reason: 'holding',
      traceJson: '[{"label":"x","passed":true}]',
    })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]!.traceJson).toBe('[{"label":"x","passed":true}]')
  })

  it('defaults traceJson to null when omitted', async () => {
    const { db, inserted } = fakeDb()
    await logStrategyDecision(db, { timestamp: 't', symbol: 'A', decision: 'BUY' })
    expect(inserted[0]!.traceJson).toBeNull()
  })

  it('no-ops when db is undefined', async () => {
    await expect(logStrategyDecision(undefined, { timestamp: 't', symbol: 'A', decision: 'BUY' })).resolves.toBeUndefined()
  })
})
