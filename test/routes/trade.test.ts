import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'

const env = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'true',
  ALLOWED_SYMBOLS: 'SOXL,SOXS',
  MAX_ORDER_NOTIONAL: '100',
  EVENT_INGEST_SECRET: 'change-me',
}

const authHeader = {
  Authorization: `Basic ${btoa('admin:secret')}`,
}

describe('trade routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('uses Webull execution when DRY_RUN=false and trading is enabled', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderId: 'ord-live-1',
          status: 'SUBMITTED',
          symbol: 'SOXL',
          side: 'BUY',
          quantity: 2,
          limitPrice: 9,
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
        DRY_RUN: 'false',
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        WEBULL_ACCOUNT_ID: 'acct-1',
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

  it('fail-closes to MockExecution when DRY_RUN is absent', async () => {
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
      {
        ...env,
        DRY_RUN: undefined,
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      executionResult?: { mode: string; brokerOrderId?: string }
    }
    expect(body.executionResult?.mode).toBe('DRY_RUN')
    expect(body.executionResult?.brokerOrderId).toMatch(/^mock-/)
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('fail-closes when TRADING_ENABLED is absent (defaults to false)', async () => {
    const app = createApp()
    const envWithoutTradingEnabled = {
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASSWORD: 'secret',
      ALLOWED_SYMBOLS: 'SOXL,SOXS',
      MAX_ORDER_NOTIONAL: '100',
    }

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
      envWithoutTradingEnabled,
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
    expect(await response.text()).toContain('symbol must be a non-empty string')
  })
})
