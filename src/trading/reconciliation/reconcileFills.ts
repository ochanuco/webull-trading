import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import type { Env } from '../../config/env'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../../infrastructure/db/schema'
import { createWebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import type { WebullOrderDetailDto } from '../../infrastructure/webull/dto'

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
  updated: Array<{ clientOrderId: string; status: string }>
  stillPending: Array<{ clientOrderId: string; status?: string }>
  notFound: string[]
  errors: Array<{ clientOrderId: string; message: string }>
}

interface ReconcileOptions {
  env: Env
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
 * PnL computation + PortfolioStateDO apply is deliberately out of scope —
 * that step needs per-symbol avg-cost tracking and will land as a separate
 * issue. This is just the plumbing that turns "we placed an order" into
 * "we know what happened to it."
 */
export async function reconcileFills(options: ReconcileOptions): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    inspected: 0,
    updated: [],
    stillPending: [],
    notFound: [],
    errors: [],
  }
  if (!options.env.DB) return summary

  const now = options.now ?? (() => new Date())
  const since = new Date(now().getTime() - (options.lookbackMs ?? 48 * 3_600_000)).toISOString()
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
    if (!coid) continue
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
    const filledPrice = pickFilledPrice(detail)

    await db
      .update(tradeJournal)
      .set({
        brokerStatus: status,
        filledQty,
        filledPrice,
      })
      .where(eq(tradeJournal.id, row.id))

    summary.updated.push({ clientOrderId: coid, status })
  }

  return summary
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * The order detail payload doesn't always carry an aggregate `filled_price`
 * at the top level. Prefer the first fill item's price if present; otherwise
 * fall back to limit_price (best-effort proxy for small sandbox orders).
 */
function pickFilledPrice(detail: WebullOrderDetailDto): number | null {
  // v2 OrderHistory doesn't expose an aggregate filled_price, so average from
  // the items if available. Sandbox orders often have a single item.
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

// Exposed for tests.
export const _internal = { TERMINAL_STATUSES, pickFilledPrice }
