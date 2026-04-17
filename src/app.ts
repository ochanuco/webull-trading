import { Hono } from 'hono'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { basicAuthMiddleware } from './middleware/basicAuth'
import { TRADE_EVENT_INGEST_SECRET_HEADER } from './infrastructure/webull/TradeEventBridge'
import { health } from './routes/health'
import { trade } from './routes/trade'
import { events } from './routes/events'
import { webull } from './routes/webull'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string }
}

export function createApp() {
  const app = new Hono<AppBindings>()
  app.use('*', auditLogger())
  app.use('/trade/*', basicAuthMiddleware())
  app.use('/webull/*', basicAuthMiddleware())
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
  app.route('/webull', webull)
  app.route('/events', events)
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
