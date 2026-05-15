import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './config/env'
import { auditLogger } from './infrastructure/logger/AuditLogger'
import { accessJwtMiddleware } from './middleware/accessJwt'
import { health } from './routes/health'
import { trade } from './routes/trade'
// Webull routes (Phase 2 append)
import { webull } from './routes/webull'
import { BrokerRequestError, TradingError, ValidationError } from './shared/errors'
import type { ErrorHandler } from 'hono'

export type AppBindings = {
  Bindings: Env
  Variables: { requestId: string; actor: string }
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
  app.use('/trade/*', accessJwtMiddleware())
  app.route('/health', health)
  app.route('/trade', trade)
  // Webull routes (Phase 2 append)
  app.use('/webull/*', accessJwtMiddleware())
  app.route('/webull', webull)
  app.use('/admin/*', accessJwtMiddleware())
  app.route('/admin', admin)
  app.use('/dashboard/*', accessJwtMiddleware())
  app.route('/dashboard', dashboard)
  app.onError(errorHandler)
  return app
}

import { admin } from './routes/admin'
import { dashboard } from './routes/dashboard'