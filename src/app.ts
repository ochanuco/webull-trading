import { Hono } from 'hono'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { basicAuthMiddleware } from './middleware/basicAuth'
import { TRADE_EVENT_INGEST_SECRET_HEADER } from './infrastructure/webull/TradeEventBridge'
import { health } from './routes/health'
import { trade } from './routes/trade'
import { events } from './routes/events'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string }
}

export function createApp() {
  const app = new Hono<AppBindings>()
  app.use('*', auditLogger())
  app.use('/trade/*', basicAuthMiddleware())
  app.use('/events/*', async (c, next) => {
    const secret = c.env.EVENT_INGEST_SECRET
    const providedSecret = c.req.header(TRADE_EVENT_INGEST_SECRET_HEADER)

    if (!secret || providedSecret !== secret) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })
  app.route('/health', health)
  app.route('/trade', trade)
  app.route('/events', events)
  return app
}
