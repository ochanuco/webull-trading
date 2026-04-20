import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { ValidationError } from '../shared/errors'
import { createWebullHttpClient } from '../infrastructure/webull/WebullHttpClient'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import { reconcileFills } from '../trading/reconciliation/reconcileFills'
import { runStrategyCron } from '../trading/strategy/runStrategyCron'

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
  /**
   * Manual trigger for `runStrategyCron`. Returns the same `StrategyCronResult`
   * the hourly scheduled handler would console.log. Useful for debugging bar
   * fetch failures / skip reasons without waiting for :15 of the hour.
   *
   * Honours `global_config.dry_run` via runStrategyCron itself — does NOT
   * bypass. Protected by the same basic-auth as the rest of /admin/*.
   */
  .post('/strategy/run', async (c) => {
    const result = await runStrategyCron(c.env)
    return c.json(result)
  })
  /**
   * Lookup the Webull-side status of an order by client_order_id.
   *
   * The JP UAT tenant does not expose `/openapi/account/orders/detail` (404
   * on both v1 and v2), so we fetch the first page of
   * `/openapi/account/orders/history` (50 entries) and filter client-side.
   * If the order is older than that window, returns 404
   * `order_not_found_in_recent_history`.
   */
  /**
   * Poll Webull for every locally-submitted order that doesn't yet have a
   * terminal `broker_status` in trade_journal, and patch the row with
   * `filled_qty / filled_price / broker_status`. Safe to call on demand —
   * idempotent (terminal rows are already excluded by the WHERE clause).
   *
   * PnL roll-up into PortfolioStateDO is a follow-up; this just makes sure
   * the journal reflects what Webull says about each order.
   */
  .post('/orders/reconcile', async (c) => {
    const summary = await reconcileFills({ env: c.env })
    return c.json(summary)
  })
  .get('/orders/:clientOrderId', async (c) => {
    const clientOrderId = c.req.param('clientOrderId').trim()
    if (clientOrderId.length === 0) {
      throw new ValidationError('clientOrderId must be non-empty', { field: 'clientOrderId' })
    }
    const client = createWebullHttpClient(c.env)
    const detail = await client.findOrderByClientId(clientOrderId)
    if (!detail) {
      return c.json({ error: 'order_not_found_in_recent_history', clientOrderId }, 404)
    }
    return c.json(detail)
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
