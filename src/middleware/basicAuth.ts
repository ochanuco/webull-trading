import { basicAuth } from 'hono/basic-auth'
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../config/env'

export function basicAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const username = c.env.BASIC_AUTH_USER
    const password = c.env.BASIC_AUTH_PASSWORD
    if (!username || !password) {
      return c.json({ error: 'Internal Server Error' }, 500)
    }
    return basicAuth({ username, password })(c, next)
  }
}
