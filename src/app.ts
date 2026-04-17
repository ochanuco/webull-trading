import { Hono } from 'hono'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { basicAuthMiddleware } from './middleware/basicAuth'
import { health } from './routes/health'
import { trade } from './routes/trade'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string }
}

export function createApp() {
  const app = new Hono<AppBindings>()
  app.use('*', auditLogger())
  app.use('/trade/*', basicAuthMiddleware())
  app.route('/health', health)
  app.route('/trade', trade)
  return app
}
