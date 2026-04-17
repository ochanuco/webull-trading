import type { MiddlewareHandler } from 'hono'

export interface AuditRecord {
  requestId: string
  timestamp: string
  method: string
  path: string
  status: number
  durationMs: number
}

export function auditLogger(): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const requestId = crypto.randomUUID()
    const started = Date.now()
    c.set('requestId', requestId)
    try {
      await next()
    } finally {
      const status = c.error ? 500 : (c.res?.status ?? 200)

      const record: AuditRecord = {
        requestId,
        timestamp: new Date().toISOString(),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        durationMs: Date.now() - started,
      }
      console.log(JSON.stringify(record))
    }
  }
}