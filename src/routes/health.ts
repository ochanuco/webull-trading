import { Hono } from 'hono'

export const health = new Hono().get('/', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})