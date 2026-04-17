import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditLogger } from '../../../src/infrastructure/logger/AuditLogger'

function createMockContext() {
  return {
    req: {
      method: 'GET',
      url: 'http://localhost/test',
    },
    res: {
      status: 200,
    },
    set: vi.fn(),
  }
}

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
      throw new Error('bearer sk-abcdef1234567890ABCDEF failed')
    })

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')).toMatchObject({ status: 500, path: '/boom', method: 'GET' })
  })

  it('omits error fields when next completes normally', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const middleware = auditLogger()
    const c = createMockContext()

    await middleware(c as never, async () => {})

    const record = JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')
    expect(record).toMatchObject({ status: 200, path: '/test', method: 'GET' })
    expect(record).not.toHaveProperty('errorClass')
    expect(record).not.toHaveProperty('errorMessage')
  })

  it('emits scrubbed HTTPException details when next throws an HTTPException', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const middleware = auditLogger()
    const c = createMockContext()

    await expect(
      middleware(c as never, async () => {
        throw new HTTPException(400, { message: 'symbol must be a non-empty string' })
      }),
    ).rejects.toBeInstanceOf(HTTPException)

    const record = JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')
    expect(record).toMatchObject({ status: 400, path: '/test', method: 'GET', errorClass: 'HTTPException' })
    expect(record.errorMessage).toContain('symbol must')
  })

  it('redacts secrets from generic error messages when next throws', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const middleware = auditLogger()
    const c = createMockContext()

    await expect(
      middleware(c as never, async () => {
        throw new Error('bearer sk-abcdef1234567890ABCDEF failed')
      }),
    ).rejects.toBeInstanceOf(Error)

    const record = JSON.parse(logSpy.mock.calls[0]?.[0] ?? '')
    expect(record).toMatchObject({ status: 500, path: '/test', method: 'GET', errorClass: 'Error' })
    expect(record.errorMessage).toContain('[redacted]')
    expect(record.errorMessage).not.toContain('sk-abcdef1234567890ABCDEF')
  })
})
