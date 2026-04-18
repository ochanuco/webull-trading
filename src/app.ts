import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { basicAuthMiddleware } from './middleware/basicAuth'
import { TRADE_EVENT_INGEST_SECRET_HEADER } from './infrastructure/webull/TradeEventBridge'
import { admin } from './routes/admin'
import { health } from './routes/health'
import { trade } from './routes/trade'
import { events } from './routes/events'
// Webull routes (Phase 2 append)
import { webull } from './routes/webull'
import { BrokerRequestError, TradingError, ValidationError } from './shared/errors'
import type { ErrorHandler } from 'hono'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string }
}

export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  if (err instanceof BrokerRequestError) {
    return c.json({ error: err.code, status: err.status }, err.status)
  }

  if (err instanceof ValidationError) {
    return c.json(
      {
        error: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
      },
      err.status,
    )
  }

  if (err instanceof TradingError) {
    return c.json({ error: err.code, message: err.message }, err.status)
  }

  if (err instanceof HTTPException) {
    return err.getResponse()
  }

  return c.json({ error: 'internal_error' }, 500)
}

export function createApp() {
  const app = new Hono<AppBindings>()
  app.use('*', auditLogger())
  app.use('/trade/*', basicAuthMiddleware())
  app.use('/events/*', async (c, next) => {
    const secret = c.env.EVENT_INGEST_SECRET
    const providedSecret = c.req.header(TRADE_EVENT_INGEST_SECRET_HEADER)

    if (!secret || !providedSecret || !timingSafeEqual(providedSecret, secret)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })
  app.route('/health', health)
  app.route('/trade', trade)
  app.route('/events', events)
  // Webull routes (Phase 2 append)
  app.use('/webull/*', basicAuthMiddleware())
  app.route('/webull', webull)
  app.use('/admin/*', basicAuthMiddleware())
  app.route('/admin', admin)
  app.onError(errorHandler)
  return app
}

function timingSafeEqual(a: string, b: string) {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)

  if (ab.byteLength !== bb.byteLength) {
    return false
  }

  let diff = 0
  for (let i = 0; i < ab.byteLength; i++) {
    diff |= ab[i]! ^ bb[i]!
  }

  return diff === 0
}