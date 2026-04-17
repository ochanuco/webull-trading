import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditLogger } from '../../../src/infrastructure/logger/AuditLogger'

describe('auditLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits status 200 for a normal route', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = new Hono()
    app.use('*', auditLogger())
    app.get('/ok', (c) => c.json({ ok: true }))

    const response = await app.request('/ok')

    expect(response.status).toBe(200)
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')).toMatchObject({ status: 200, path: '/ok', method: 'GET' })
  })

  it('emits status 400 for an HTTPException route', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = new Hono()
    app.use('*', auditLogger())
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return err.getResponse()
      }
      return c.text('internal error', 500)
    })
    app.get('/bad-request', () => {
      throw new HTTPException(400, { message: 'bad request' })
    })

    const response = await app.request('/bad-request')

    expect(response.status).toBe(400)
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')).toMatchObject({
      status: 400,
      path: '/bad-request',
      method: 'GET',
    })
  })

  it('emits status 500 for a generic error route', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = new Hono()
    app.use('*', auditLogger())
    app.onError((_err, c) => c.text('internal error', 500))
    app.get('/boom', () => {
      throw new Error('boom')
    })

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')).toMatchObject({ status: 500, path: '/boom', method: 'GET' })
  })
})
