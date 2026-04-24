import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
}

const authHeader = { Authorization: `Basic ${btoa('admin:secret')}` }

function fakeSymbolState(captured: { calls: Array<{ symbol: string; amount: number }> }) {
  const stub = {
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
  // Minimal DurableObjectNamespace shape for the SymbolStateClient wrapper.
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

describe('POST /admin/symbols/:symbol/seed-cash', () => {
  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      { method: 'POST', body: JSON.stringify({ amount: 100 }) },
      baseEnv,
    )
    expect(res.status).toBe(401)
  })

  it('400s when body is not a JSON object', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: 'not-json',
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('400s on negative amount', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: -5 }),
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('200s and forwards the amount to SYMBOL_STATE.seedSettledCash', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/soxl/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: 12_345 }),
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { symbol: string; settledCash: number }
    expect(body).toEqual({
      symbol: 'SOXL',
      settledCash: 12_345,
      updatedAt: '2026-04-21T10:00:00.000Z',
    })
    expect(captured.calls).toEqual([{ symbol: 'SOXL', amount: 12_345 }])
  })
})

describe('POST /admin/symbols/:symbol/clear-cooldown', () => {
  function fakeCooldownNamespace(captured: { calls: Array<{ symbol: string; untilIso: string }> }) {
    const stub = {
      async setCooldown(symbol: string, untilIso: string) {
        captured.calls.push({ symbol, untilIso })
        return {
          symbol,
          position: null,
          pendingOrder: null,
          lastSignalAt: null,
          cooldownUntil: untilIso,
          settledCash: 0,
          pendingSettlement: [],
          lastExecutedPrice: null,
          lastQuote: null,
          updatedAt: '2026-04-25T00:00:00.000Z',
        }
      },
    }
    return {
      idFromName: () => 'id',
      get: () => stub,
    } as unknown
  }

  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request('/admin/symbols/SOXL/clear-cooldown', { method: 'POST' }, baseEnv)
    expect(res.status).toBe(401)
  })

  it('200s and sets cooldown to epoch 0 (effectively cleared)', async () => {
    const captured = { calls: [] as Array<{ symbol: string; untilIso: string }> }
    const app = createApp()
    const res = await app.request(
      '/admin/symbols/soxl/clear-cooldown',
      { method: 'POST', headers: { ...authHeader } },
      { ...baseEnv, SYMBOL_STATE: fakeCooldownNamespace(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { symbol: string; cooldownUntil: string }
    expect(body.symbol).toBe('SOXL')
    expect(body.cooldownUntil).toBe('1970-01-01T00:00:00.000Z')
    expect(captured.calls).toEqual([{ symbol: 'SOXL', untilIso: '1970-01-01T00:00:00.000Z' }])
  })
})
