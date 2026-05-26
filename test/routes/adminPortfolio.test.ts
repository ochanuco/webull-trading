import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
}

const unauthEnv = {
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
}

const authHeader = {}

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
  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/portfolio/seed-equity',
      { method: 'POST', body: JSON.stringify({ amount: 100_000 }) },
      unauthEnv,
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

// #77: POST /admin/portfolio/seed-exposure roundtrip — operator override of
// the openExposure{Usd,Jpy} counters. Validates strict body parsing (at
// least one of usd/jpy; >= 0; finite) and forwards to PORTFOLIO_STATE.
function fakePortfolioExposureState(
  captured: { calls: Array<{ usd?: number; jpy?: number }> },
  current = { openExposureUsd: 0, openExposureJpy: 0 },
) {
  const stub = {
    async getPortfolio() {
      return {
        dailyStartEquity: 0,
        dailyRealizedPnl: 0,
        tradingDisabledUntil: null,
        lastRolledAt: null,
        appliedClientOrderIds: [],
        openExposureUsd: current.openExposureUsd,
        openExposureJpy: current.openExposureJpy,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
    async seedOpenExposure(args: { usd?: number; jpy?: number }) {
      captured.calls.push(args)
      const next = {
        ...current,
        ...(args.usd !== undefined ? { openExposureUsd: args.usd } : {}),
        ...(args.jpy !== undefined ? { openExposureJpy: args.jpy } : {}),
      }
      current.openExposureUsd = next.openExposureUsd
      current.openExposureJpy = next.openExposureJpy
      return {
        dailyStartEquity: 0,
        dailyRealizedPnl: 0,
        tradingDisabledUntil: null,
        lastRolledAt: null,
        appliedClientOrderIds: [],
        openExposureUsd: next.openExposureUsd,
        openExposureJpy: next.openExposureJpy,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

describe('POST /admin/portfolio/seed-exposure (#77)', () => {
  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/portfolio/seed-exposure',
      { method: 'POST', body: JSON.stringify({ usd: 0 }) },
      unauthEnv,
    )
    expect(res.status).toBe(401)
  })

  it('400s when neither usd nor jpy is provided', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ usd?: number; jpy?: number }> }
    const res = await app.request(
      '/admin/portfolio/seed-exposure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioExposureState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('400s on negative usd', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ usd?: number; jpy?: number }> }
    const res = await app.request(
      '/admin/portfolio/seed-exposure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usd: -1 }),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioExposureState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('200s and forwards both usd and jpy to PORTFOLIO_STATE.seedOpenExposure', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ usd?: number; jpy?: number }> }
    const res = await app.request(
      '/admin/portfolio/seed-exposure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usd: 250, jpy: 30_000 }),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioExposureState(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      openExposureUsd: number
      openExposureJpy: number
      updatedAt: string
    }
    expect(body).toEqual({
      openExposureUsd: 250,
      openExposureJpy: 30_000,
      updatedAt: '2026-04-21T10:00:00.000Z',
    })
    expect(captured.calls).toEqual([{ usd: 250, jpy: 30_000 }])
  })

  it('accepts only one side (jpy alone) leaving usd untouched', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ usd?: number; jpy?: number }> }
    // Seed a non-zero USD so a regression that silently zeroes USD would fail.
    const initial = { openExposureUsd: 123, openExposureJpy: 0 }
    const res = await app.request(
      '/admin/portfolio/seed-exposure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jpy: 12_345 }),
      },
      { ...baseEnv, PORTFOLIO_STATE: fakePortfolioExposureState(captured, initial) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      openExposureUsd: number
      openExposureJpy: number
      updatedAt: string
    }
    expect(body.openExposureUsd).toBe(123)
    expect(body.openExposureJpy).toBe(12_345)
    expect(captured.calls).toEqual([{ jpy: 12_345 }])
  })
})
