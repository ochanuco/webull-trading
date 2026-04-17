import { Hono } from 'hono'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { health } from './routes/health'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string }
}

export function createApp() {
  const app = new Hono<AppBindings>()
  app.use('*', auditLogger())
  app.route('/health', health)
  return app
}
