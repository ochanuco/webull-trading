import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { TradingError } from '../../shared/errors'

export interface AuditRecord {
  requestId: string
  timestamp: string
  method: string
  path: string
  status: number
  durationMs: number
  errorClass?: string
  errorMessage?: string
}

function scrubSecret(message: string): string {
  return message
    .replace(/bearer\s+\S+/gi, '[redacted]')
    .replace(/basic\s+\S+/gi, '[redacted]')
    .replace(/sk[-_][A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 200)
}

export function auditLogger(): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const requestId = crypto.randomUUID()
    const started = Date.now()
    let status = 200
    let errorClass: string | undefined
    let errorMessage: string | undefined
    c.set('requestId', requestId)
    try {
      await next()
      status = c.res.status
    } catch (err) {
      status = err instanceof TradingError ? err.status : err instanceof HTTPException ? err.status : 500
      if (err instanceof Error) {
        errorClass = err.constructor.name
        errorMessage = scrubSecret(err.message.split('\n')[0]?.trim() ?? '')
      } else {
        errorClass = err?.constructor?.name ?? typeof err
      }
      throw err
    } finally {
      const record: AuditRecord = {
        requestId,
        timestamp: new Date().toISOString(),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        durationMs: Date.now() - started,
        errorClass,
        errorMessage,
      }
      console.log(JSON.stringify(record))
    }
  }
}