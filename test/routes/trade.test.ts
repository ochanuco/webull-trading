import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

const env = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'true',
  ALLOWED_SYMBOLS: 'SOXL,SOXS',
  MAX_ORDER_NOTIONAL: '100',
}

const authHeader = {
  Authorization: `Basic ${btoa('admin:secret')}`,
}

describe('trade routes', () => {
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