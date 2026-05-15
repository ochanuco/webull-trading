import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'

/**
 * Integration test for issue #274: state-changing admin POST handlers must
 * write a `config_audit_log` row via `recordChange`. Uses the seed-cash
 * endpoint because it is the smallest path that goes through the wrapper.
 *
 * `createDb` is spied so we can capture the drizzle `insert().values()` call
 * without spinning up a real D1.
 */

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
}

const authHeader = {}

interface SeedCashCall {
  symbol: string
  amount: number
}

function fakeSymbolState(captured: { calls: SeedCashCall[] }, beforeCash: number) {
  const stub = {
    async getState(symbol: string) {
      return {
        symbol,
        position: null,
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil: null,
        settledCash: beforeCash,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: null,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
    async seedSettledCash(symbol: string, amount: number) {
      captured.calls.push({ symbol, amount })
      return {
        symbol,
        position: null,
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil: null,
        settledCash: amount,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: null,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

interface InsertCapture {
  table?: unknown
  values: unknown[]
}

function fakeDbCapturingInserts(captured: InsertCapture) {
  return {
    insert: (table: unknown) => {
      captured.table = table
      return {
        values: async (v: unknown) => {
          captured.values.push(v)
        },
      }
    },
  }
}

describe('admin audit log integration (#274)', () => {
  it('writes a config_audit_log row when seed-cash mutates settledCash', async () => {
    const dbModule = await import('../../src/infrastructure/db/tradeJournalRepo')
    const insertCapture: InsertCapture = { values: [] }
    const spy = vi
      .spyOn(dbModule, 'createDb')
      .mockReturnValue(fakeDbCapturingInserts(insertCapture) as never)

    try {
      const app = createApp()
      const symbolStateCalls = { calls: [] as SeedCashCall[] }
      const res = await app.request(
        '/admin/symbols/SOXL/seed-cash',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ amount: 5_000 }),
        },
        {
          ...baseEnv,
          DB: {} as unknown as D1Database,
          SYMBOL_STATE: fakeSymbolState(symbolStateCalls, 1_000),
        },
      )
      expect(res.status).toBe(200)
      expect(symbolStateCalls.calls).toEqual([{ symbol: 'SOXL', amount: 5_000 }])

      expect(insertCapture.values).toHaveLength(1)
      const row = insertCapture.values[0] as {
        actor: string
        endpoint: string
        targetKey: string | null
        beforeJson: string
        afterJson: string
        requestId: string | null
        timestamp: string
      }
      expect(row.actor).toBe('admin')
      expect(row.endpoint).toBe('/admin/symbols/:symbol/seed-cash')
      expect(row.targetKey).toBe('symbol=SOXL')
      expect(JSON.parse(row.beforeJson)).toEqual({ settledCash: 1_000 })
      expect(JSON.parse(row.afterJson)).toEqual({ settledCash: 5_000 })
      expect(typeof row.requestId).toBe('string')
      expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      spy.mockRestore()
    }
  })

  it('skips the audit row when seed-cash is a no-op (before == after)', async () => {
    const dbModule = await import('../../src/infrastructure/db/tradeJournalRepo')
    const insertCapture: InsertCapture = { values: [] }
    const spy = vi
      .spyOn(dbModule, 'createDb')
      .mockReturnValue(fakeDbCapturingInserts(insertCapture) as never)

    try {
      const app = createApp()
      const symbolStateCalls = { calls: [] as SeedCashCall[] }
      const res = await app.request(
        '/admin/symbols/SOXL/seed-cash',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ amount: 1_000 }),
        },
        {
          ...baseEnv,
          DB: {} as unknown as D1Database,
          SYMBOL_STATE: fakeSymbolState(symbolStateCalls, 1_000),
        },
      )
      expect(res.status).toBe(200)
      expect(symbolStateCalls.calls).toEqual([{ symbol: 'SOXL', amount: 1_000 }])
      expect(insertCapture.values).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
