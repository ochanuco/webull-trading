import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import type { Env } from '../../config/env'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../../infrastructure/db/schema'
import { createWebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import type { WebullOrderDetailDto } from '../../infrastructure/webull/dto'
import { inferTradingMarket, nextTradingDay } from '../domain/tradingCalendar'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'

// Terminal Webull order statuses — once we see one of these we can stop
// polling for this order. Anything else (NEW, PENDING, PARTIALLY_FILLED) is
// still in flight.
const TERMINAL_STATUSES = new Set<string>([
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
])

export interface ReconcileSummary {
  inspected: number
  updated: Array<{ clientOrderId: string; status: string; realizedPnl?: number }>
  stillPending: Array<{ clientOrderId: string; status?: string }>
  notFound: string[]
  errors: Array<{ clientOrderId: string; message: string }>
}

interface ReconcileOptions {
  env: Env
  /**
   * Correlates reconcile logs with the originating request. Callers should
   * pass `c.get('requestId')` when invoking from a route, or generate their
   * own (e.g. `crypto.randomUUID()`) for cron-triggered runs.
   */
  requestId?: string
  /** How far back to scan for unreconciled post_submit rows. Default 48h. */
  lookbackMs?: number
  /** Cap on rows inspected per call so a single invocation doesn't fan out. */
  limit?: number
  now?: () => Date
}

/**
 * Poll Webull for the current state of every locally-submitted order that
 * doesn't yet have a terminal `broker_status` recorded, and patch the
 * matching `post_submit` row in `trade_journal` with `filled_qty /
 * filled_price / broker_status`.
 *
 * Terminal FILLED rows are also applied into the DO layer:
 *   - Every filled leg (BUY or SELL) is pushed to SymbolStateDO.recordFill
 *     so per-symbol position + avg cost stay in sync with the broker.
 *   - SELL fills additionally compute realized_pnl = (fill_price - prior
 *     avg_cost) * filled_qty and apply it to PortfolioStateDO via
 *     applyRealizedPnl. The computed delta is also persisted on the
 *     trade_journal row (realized_pnl column).
 *
 * Idempotency note: the SELECT filter `broker_status IS NULL` prevents
 * double processing in the common case. If the journal UPDATE succeeds but
 * the subsequent DO apply throws, the row is marked reconciled and the DO
 * won't auto-repair on the next tick — the error is logged loudly so an
 * operator can fix it manually. Proper idempotency would need a separate
 * `applied_at` marker column; out of scope for this change.
 */
export async function reconcileFills(options: ReconcileOptions): Promise<ReconcileSummary> {
  // Fail-closed on a missing DB binding to match loadGlobalConfigFrom /
  // loadSymbolUniverse. A silent empty summary would be indistinguishable
  // from "nothing to reconcile" and hide a misconfiguration.
  if (!options.env.DB) {
    throw new Error('reconcileFills requires env.DB binding (D1 not configured)')
  }
  const summary: ReconcileSummary = {
    inspected: 0,
    updated: [],
    stillPending: [],
    notFound: [],
    errors: [],
  }

  const now = options.now ?? (() => new Date())
  // Capture a single "reconcile run" timestamp so every derived computation
  // (lookback window, cooldown expiry) uses the same basis. Using fresh
  // `new Date()` at each call site makes back-catch-up runs lengthen the
  // cooldown window incorrectly.
  const runNow = now()
  const since = new Date(runNow.getTime() - (options.lookbackMs ?? 48 * 3_600_000)).toISOString()
  const limit = options.limit ?? 50

  const db = createDb(options.env.DB)
  const candidates = await db
    .select({
      id: tradeJournal.id,
      clientOrderId: tradeJournal.clientOrderId,
      symbol: tradeJournal.symbol,
      side: tradeJournal.side,
    })
    .from(tradeJournal)
    .where(
      and(
        eq(tradeJournal.tradeEventType, 'post_submit'),
        eq(tradeJournal.submitted, true),
        isNull(tradeJournal.brokerStatus),
        gte(tradeJournal.timestamp, since),
      ),
    )
    .orderBy(desc(tradeJournal.id))
    .limit(limit)

  if (candidates.length === 0) return summary

  summary.inspected = candidates.length
  const client = createWebullHttpClient(options.env)

  for (const row of candidates) {
    const coid = row.clientOrderId
    if (!coid) {
      // In practice a post_submit row with submitted=1 always has a coid
      // (it's the idempotency key we signed the order with). Surface any
      // violation loudly instead of silently dropping the row.
      summary.errors.push({
        clientOrderId: `row_id:${row.id}`,
        message: 'missing client_order_id on post_submit row',
      })
      continue
    }
    let detail: WebullOrderDetailDto | undefined
    try {
      detail = await client.findOrderByClientId(coid)
    } catch (error) {
      summary.errors.push({
        clientOrderId: coid,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!detail) {
      summary.notFound.push(coid)
      continue
    }

    const status = detail.status
    if (!status || !TERMINAL_STATUSES.has(status)) {
      summary.stillPending.push({ clientOrderId: coid, status })
      continue
    }

    const filledQty = toNumberOrNull(detail.filled_quantity)
    const filledPrice = resolveFilledPrice(filledQty, detail)

    // Compute realized P&L for SELL fills BEFORE we touch any state. Needs
    // the symbol's current avg cost from SymbolStateDO, which is only
    // meaningful after we've been recording BUY fills. Early trades with no
    // prior position yield realized=null (can't compute).
    const side = (detail.side ?? row.side ?? null) as 'BUY' | 'SELL' | null
    const symbol = row.symbol ?? detail.symbol ?? null
    let realizedPnl: number | null = null
    if (
      status === 'FILLED' &&
      side === 'SELL' &&
      symbol !== null &&
      filledQty !== null && filledQty > 0 &&
      filledPrice !== null && filledPrice > 0 &&
      options.env.SYMBOL_STATE
    ) {
      try {
        const priorState = await new SymbolStateClient(options.env.SYMBOL_STATE).getState(symbol)
        const avg = priorState.position?.avgPrice
        if (typeof avg === 'number' && Number.isFinite(avg) && avg > 0) {
          realizedPnl = (filledPrice - avg) * filledQty
        }
      } catch (error) {
        // Not fatal — just means we can't pre-compute realized. Log + continue.
        console.error(
          JSON.stringify({
            event: 'reconcile_prior_state_error',
            requestId: options.requestId,
            clientOrderId: coid,
            symbol,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }

    try {
      await db
        .update(tradeJournal)
        .set({
          brokerStatus: status,
          filledQty,
          filledPrice,
          realizedPnl,
        })
        .where(eq(tradeJournal.id, row.id))
      summary.updated.push({ clientOrderId: coid, status, ...(realizedPnl !== null ? { realizedPnl } : {}) })

      // After the journal is stamped reconciled, push the fill into the DO
      // layer. Any DO failure here is logged but does NOT retry — see the
      // idempotency note in the module docstring.
      if (
        status === 'FILLED' &&
        side !== null &&
        symbol !== null &&
        filledQty !== null && filledQty > 0 &&
        filledPrice !== null && filledPrice > 0
      ) {
        await applyFillToState({
          env: options.env,
          requestId: options.requestId,
          clientOrderId: coid,
          symbol,
          side,
          filledQty,
          filledPrice,
          realizedPnl,
          runNow,
        })
      }

      // Release the pending-order lock on every terminal status — FILLED,
      // CANCELLED, REJECTED, EXPIRED — so pullbackScheduler can re-enter
      // the symbol on the next cron tick. Previously the removed
      // TradeEventHandler did this on every trade_event_type=fill.
      //
      // Guard by clientOrderId: a backlog reconcile for an old row A
      // shouldn't clear a newer order B's lock on the same symbol. Only
      // clear if the currently-held lock still matches this row's coid.
      if (symbol !== null) {
        await clearPendingLockIfMatches(
          options.env,
          options.requestId,
          symbol,
          coid,
        )
      }
    } catch (error) {
      // A single row's UPDATE shouldn't kill the whole batch; most other
      // rows can still be reconciled. Log the failure into the errors bucket
      // so the operator can retry just this one.
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        JSON.stringify({
          event: 'reconcile_fill_update_error',
          requestId: options.requestId,
          rowId: row.id,
          clientOrderId: coid,
          symbol: row.symbol,
          side: row.side,
          status,
          message,
        }),
      )
      summary.errors.push({ clientOrderId: coid, message: `update_failed: ${message}` })
    }
  }

  return summary
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Apply a terminal FILLED order into SymbolStateDO (position tracking) and,
 * for SELL legs, PortfolioStateDO (realized PnL aggregation).
 *
 * Failures here are logged but not rethrown — the journal row is already
 * marked reconciled at this point, so the next cron tick would skip it.
 * Proper repair would need an `applied_at` column; see module docstring.
 */
async function applyFillToState(args: {
  env: Env
  requestId?: string
  clientOrderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  filledQty: number
  filledPrice: number
  realizedPnl: number | null
  /** Reconcile run basis time — used for cooldown expiry so back-catch-up runs
   * don't lengthen the window past the original fill's next trading day. */
  runNow: Date
}): Promise<void> {
  const { env, requestId, clientOrderId, symbol, side, filledQty, filledPrice, realizedPnl, runNow } = args

  if (env.SYMBOL_STATE) {
    try {
      await new SymbolStateClient(env.SYMBOL_STATE).recordFill(symbol, {
        side,
        qty: filledQty,
        price: filledPrice,
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'reconcile_symbol_state_apply_error',
          requestId,
          clientOrderId,
          symbol,
          side,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  if (side === 'SELL' && realizedPnl !== null && env.PORTFOLIO_STATE) {
    try {
      await new PortfolioStateClient(env.PORTFOLIO_STATE).applyRealizedPnl(realizedPnl)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'reconcile_portfolio_apply_error',
          requestId,
          clientOrderId,
          symbol,
          realizedPnl,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  // Stop-out cooldown: a losing exit parks the symbol until the next trading
  // day so a whipsaw re-entry cannot compound the loss. Ported from the
  // removed TradeEventHandler — pullbackScheduler reads `state.cooldownUntil`
  // for its signal decision, so without this write the strategy never
  // backs off after a losing sell.
  if (
    side === 'SELL' &&
    realizedPnl !== null &&
    realizedPnl < 0 &&
    env.SYMBOL_STATE
  ) {
    try {
      const market = inferTradingMarket(symbol)
      const cooldownUntil = nextTradingDay(runNow, market).toISOString()
      await new SymbolStateClient(env.SYMBOL_STATE).setCooldown(symbol, cooldownUntil)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'reconcile_cooldown_apply_error',
          requestId,
          clientOrderId,
          symbol,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}

/**
 * Ported from the removed TradeEventHandler: any terminal status (FILLED or
 * otherwise) releases the symbol's pending-order lock so subsequent cron
 * ticks can re-enter. pullbackScheduler sets the lock on submit; without
 * this release a failed / cancelled order would leave a dangling
 * `pendingOrder` field that the strategy reads.
 *
 * Guard by clientOrderId: reconcile can run late (back-catch-up / cron
 * pause). By the time we process an old terminal row A, the scheduler may
 * already have issued a new order B and acquired a fresh lock on the same
 * symbol. Unconditionally clearing would drop B's lock; only clear when
 * the currently-held lock still matches row A's coid.
 */
async function clearPendingLockIfMatches(
  env: Env,
  requestId: string | undefined,
  symbol: string,
  clientOrderId: string,
): Promise<void> {
  if (!env.SYMBOL_STATE) return
  try {
    const client = new SymbolStateClient(env.SYMBOL_STATE)
    const state = await client.getState(symbol)
    const holder = state.pendingOrder?.clientOrderId
    if (!holder) return // nothing to clear
    if (holder !== clientOrderId) {
      // Newer order already holds the lock — leave it intact.
      console.log(
        JSON.stringify({
          event: 'reconcile_clear_pending_skipped_stale',
          requestId,
          symbol,
          terminalClientOrderId: clientOrderId,
          holderClientOrderId: holder,
        }),
      )
      return
    }
    await client.clearPendingOrder(symbol)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'reconcile_clear_pending_error',
        requestId,
        symbol,
        clientOrderId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * Webull's order history response doesn't expose an aggregate `filled_price`.
 * Recover a usable effective fill price in this order:
 *
 *   1. If `items[]` carries per-fill `filled_price` entries (partial or full
 *      fills), **average across all positively-priced items**.
 *   2. Otherwise fall back to the signed `limit_price` — strict upper bound
 *      for a BUY limit and lower bound for a SELL limit, good enough as a
 *      best-effort proxy for small sandbox orders where we only care about
 *      ballpark P&L aggregation.
 *   3. Otherwise `null`.
 */
function pickFilledPrice(detail: WebullOrderDetailDto): number | null {
  // Sandbox orders usually have a single item, so the average collapses to
  // that one item's price. Partial fills at multiple prices would average
  // out naturally — callers that need precise per-fill accounting will need
  // to walk items[] directly instead.
  if (detail.items && detail.items.length > 0) {
    const prices = detail.items
      .map((item) => toNumberOrNull((item as { filled_price?: string }).filled_price))
      .filter((n): n is number => n !== null && n > 0)
    if (prices.length > 0) {
      const sum = prices.reduce((acc, n) => acc + n, 0)
      return sum / prices.length
    }
  }
  // Fall back to the limit price we signed the order at. This is not
  // technically the fill price, but it's a strict upper bound for a BUY
  // limit and lower bound for a SELL limit — good enough for downstream
  // notional aggregations when the broker doesn't echo the fill back.
  return toNumberOrNull(detail.limit_price)
}

/**
 * Only record a fill price when there's actually a fill, and only if it
 * passes the "finite and > 0" guideline. For CANCELLED / REJECTED rows
 * (filledQty=0) this returns null so we don't misrepresent the row as if
 * it had transacted at the signed limit price.
 */
function resolveFilledPrice(
  filledQty: number | null,
  detail: WebullOrderDetailDto,
): number | null {
  if (filledQty === null || filledQty <= 0) return null
  const candidate = pickFilledPrice(detail)
  if (candidate === null || !Number.isFinite(candidate) || candidate <= 0) return null
  return candidate
}

// Exposed for tests.
export const _internal = { TERMINAL_STATUSES, pickFilledPrice, resolveFilledPrice }
