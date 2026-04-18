import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { ValidationError } from '../shared/errors'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'

/**
 * Operator-only endpoints. Basic-auth-protected by the same middleware as
 * `/trade/*` at mount time. Use sparingly — these mutate DO state out-of-band
 * and should only be called for initial seeding or reconciliation.
 */
export const admin = new Hono<AppBindings>()
  .post('/symbols/:symbol/seed-cash', async (c) => {
    const symbol = c.req.param('symbol').trim().toUpperCase()
    if (symbol.length === 0) {
      throw new ValidationError('symbol must be a non-empty path param', { field: 'symbol' })
    }
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }

    const body = (await c.req.json().catch(() => null)) as unknown
    const amount = readAmount(body)

    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const state = await client.seedSettledCash(symbol, amount)
    return c.json({ symbol, settledCash: state.settledCash, updatedAt: state.updatedAt })
  })
  .post('/portfolio/seed-equity', async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      throw new ValidationError('PORTFOLIO_STATE binding is not configured', { field: 'env' })
    }

    const body = (await c.req.json().catch(() => null)) as unknown
    const amount = readAmount(body)

    const client = new PortfolioStateClient(c.env.PORTFOLIO_STATE)
    const state = await client.seedDailyStartEquity(amount)
    return c.json({
      dailyStartEquity: state.dailyStartEquity,
      dailyRealizedPnl: state.dailyRealizedPnl,
      tradingDisabledUntil: state.tradingDisabledUntil,
      updatedAt: state.updatedAt,
    })
  })

function readAmount(body: unknown): number {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('body must be a JSON object with { amount: number }', { field: 'body' })
  }
  const value = (body as { amount?: unknown }).amount
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError('amount must be a finite number >= 0', { field: 'amount' })
  }
  return value
}
