import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

const env = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
}

const authHeader = {
  Authorization: `Basic ${btoa('admin:secret')}`,
}

describe('trade routes', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it('POST /trade/decide returns signal, intent, and risk decision', async () => {
    const app = createApp()

    const response = await app.request(
      '/trade/decide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      signal: { action: string }
      orderIntent?: { symbol: string; notional: number }
      riskDecision: { allowed: boolean }
    }
    expect(body.signal.action).toBe('BUY')
    expect(body.orderIntent?.symbol).toBe('SOXL')
    expect(body.orderIntent?.notional).toBe(18)
    expect(body.riskDecision.allowed).toBe(true)
  })

  it('POST /trade/execute returns a mock execution result', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const app = createApp()

    const response = await app.request(
      '/trade/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      executionResult?: { mode: string; submitted: boolean; brokerOrderId?: string; errorReason?: string }
    }
    expect(body.executionResult?.mode).toBe('DRY_RUN')
    expect(body.executionResult?.submitted).toBe(true)
    expect(body.executionResult?.brokerOrderId).toMatch(/^mock-/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('applies a symbol-specific max notional override from D1', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ symbolMaxNotional: { SOXL: 50 } }),
    )
    const app = createApp()

    const response = await app.request(
      '/trade/decide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 20,
          quantity: 3,
          buyBelow: 25,
          sellAbove: 30,
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      riskDecision: { allowed: boolean; reasons: string[] }
    }
    expect(body.riskDecision.allowed).toBe(false)
    expect(body.riskDecision.reasons).toContain('order notional 60 exceeds max 50')
  })

  it('uses Webull execution when dryRun=false (via D1)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ dryRun: false }),
    )
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_order_id: 'cli-live-1',
          order_id: 'ord-live-1',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = createApp()

    const response = await app.request(
      '/trade/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      {
        ...env,
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        
        WEBULL_ACCOUNT_ID_JP_CASH: 'acct-jp-1',
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      executionResult?: { mode: string; submitted: boolean; brokerOrderId?: string }
    }
    expect(body.executionResult).toEqual({
      mode: 'LIVE',
      submitted: true,
      brokerOrderId: 'ord-live-1',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns 401 for /trade/* without auth', async () => {
    const app = createApp()

    const decideResponse = await app.request(
      '/trade/decide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    const executeResponse = await app.request(
      '/trade/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    expect(decideResponse.status).toBe(401)
    expect(executeResponse.status).toBe(401)
  })

  it('fail-closes when tradingEnabled=false (via D1)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: false }),
    )
    const app = createApp()

    const response = await app.request(
      '/trade/decide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      riskDecision: { allowed: boolean; reasons: string[] }
    }
    expect(body.riskDecision.allowed).toBe(false)
    expect(body.riskDecision.reasons.some((r) => r.toLowerCase().includes('trading'))).toBe(true)
  })

  it('returns 400 for an empty symbol', async () => {
    const app = createApp()

    const response = await app.request(
      '/trade/decide',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: '   ',
          price: 9,
          quantity: 2,
          buyBelow: 10,
          sellAbove: 20,
        }),
      },
      env,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'validation_error',
      message: 'symbol must be a non-empty string',
      field: 'symbol',
    })
  })
})
