import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
  EVENT_INGEST_SECRET: 'change-me',
}

const authHeader = { Authorization: `Basic ${btoa('admin:secret')}` }

function fakePortfolioState(captured: { calls: Array<{ amount: number }> }) {
  const stub = {
    async seedDailyStartEquity(amount: number) {
      captured.calls.push({ amount })
      return {
        dailyStartEquity: amount,
        dailyRealizedPnl: 0,
        tradingDisabledUntil: null,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

describe('POST /admin/portfolio/seed-equity', () => {
  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/portfolio/seed-equity',
      { method: 'POST', body: JSON.stringify({ amount: 100_000 }) },
      baseEnv,
    )
    expect(res.status).toBe(401)
  })

  it('400s on negative amount', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ amount: number }> }
    const res = await app.request(
      '/admin/portfolio/seed-equity',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: -1 }),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('200s and forwards the amount to PORTFOLIO_STATE.seedDailyStartEquity', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ amount: number }> }
    const res = await app.request(
      '/admin/portfolio/seed-equity',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: 100_000 }),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioState(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      dailyStartEquity: number
      dailyRealizedPnl: number
      tradingDisabledUntil: string | null
      updatedAt: string
    }
    expect(body).toEqual({
      dailyStartEquity: 100_000,
      dailyRealizedPnl: 0,
      tradingDisabledUntil: null,
      updatedAt: '2026-04-21T10:00:00.000Z',
    })
    expect(captured.calls).toEqual([{ amount: 100_000 }])
  })
})
