import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { BrokerRequestError, TradingError, ValidationError } from '../src/shared/errors'
import { errorHandler, type AppBindings } from '../src/app'

describe('app-level onError', () => {
  it('returns 500 for unknown errors', async () => {
    const app = createErrorTestApp()
    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'internal_error' })
  })

  it('returns 400 for ValidationError', async () => {
    const app = createErrorTestApp()
    const response = await app.request('/validation')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'validation_error',
      message: 'symbol must be a non-empty string',
      field: 'symbol',
    })
  })
})

function createErrorTestApp() {
  const app = new Hono<AppBindings>()

  app.get('/boom', () => {
    throw new Error('unexpected')
  })

  app.get('/validation', () => {
    throw new ValidationError('symbol must be a non-empty string', { field: 'symbol' })
  })

  app.get('/broker', () => {
    throw new BrokerRequestError('Webull order placement failed', 'placeOrder')
  })

  app.onError(errorHandler)

  return app
}