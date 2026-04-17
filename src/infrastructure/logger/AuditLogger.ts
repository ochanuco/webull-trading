import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

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
    let status = 200
    c.set('requestId', requestId)
    try {
      await next()
      status = c.res.status
    } catch (err) {
      status = err instanceof HTTPException ? err.status : 500
      throw err
    } finally {
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
