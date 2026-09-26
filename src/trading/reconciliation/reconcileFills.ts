import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { Env } from '../../config/env'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import type { PairRegimeEntry } from '../strategy/pairRegime'
import { tradeJournal } from '../../infrastructure/db/schema'
import { resolveAccessToken } from '../../infrastructure/webull/resolveAccessToken'
import { createWebullReadClient } from '../../infrastructure/webull/WebullReadClient'
import type { WebullOrderDetailDto } from '../../infrastructure/webull/dto'
import { inferWebullMarket } from '../../infrastructure/webull/mapper'
import { inferTradingMarket, nextSessionOpen } from '../domain/tradingCalendar'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { loadGlobalConfig } from '../../infrastructure/db/globalConfigRepo'
import { netRealizedPnl, type TradeCostConfig } from '../domain/tradingCost'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'

// Statuses after which polling stops for an order (anything else — NEW,
// PENDING, PARTIALLY_FILLED — is still in flight). Both spellings of
// cancelled are included: the broker's own API returns `CANCELED`
// (American) as well as the SDK's `CANCELLED` (British); matching only one
// leaves cancelled orders permanently "stillPending".
const TERMINAL_STATUSES = new Set<string>([
  'FILLED',
  'CANCELLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
])

/**
 * Subset of `TERMINAL_STATUSES` that can carry real filled shares — a limit
 * order may partially fill before the remainder is CANCELLED/EXPIRED, and
 * that filled portion is still owed to the DO. Excludes `REJECTED`: Webull
 * has no partial-fill-then-reject shape, so a REJECTED row with
 * `filled_quantity>0` is a broker data anomaly, not a fill to apply.
 */
const FILL_CARRYING_TERMINAL_STATUSES = new Set<string>([
  'FILLED',
  'CANCELLED',
  'CANCELED',
  'EXPIRED',
])

export interface ReconcileSummary {
  inspected: number
  updated: Array<{ clientOrderId: string; status: string; realizedPnl?: number }>
  stillPending: Array<{ clientOrderId: string; status?: string }>
  /** @deprecated Union of `notFoundRecentWindow` + `notFoundAfterDeepLookup`, kept so existing dashboard/alert readers keep working; prefer the split buckets. */
  notFound: string[]
  /** Missed the single-page lookup — may simply be off page 1, not authoritative absence. */
  notFoundRecentWindow: string[]
  /** Missed even the `historyMaxPages` deep sweep — stronger signal the broker doesn't have it. */
  notFoundAfterDeepLookup: string[]
  errors: Array<{ clientOrderId: string; message: string }>
  /** Rows where the DO apply succeeded this run, first-seen or repaired (see `repaired`). */
  stateApplied: number
  stateApplyFailed: number
  /** Subset of `stateApplied` that were repair-mode retries of a previously-failed apply. */
  repaired: number
  /**
   * Rows force-stamped `state_applied_at` after exceeding `MAX_REPAIR_ATTEMPTS`
   * on a permanent sanity failure. Excluded from `errors` so a stuck row
   * stops re-firing the same alert forever.
   */
  abandoned: number
}

// 5 gives a few cron ticks of grace for a transient DO blip without letting
// a structurally-broken row (e.g. broker permanently echoing a stub price)
// keep the alert siren going forever — see `markAsAbandoned`.
const MAX_REPAIR_ATTEMPTS = 5

// 48h rides out a brief cron pause without re-scanning the whole table every
// tick. Overridable via `ReconcileOptions.lookbackMs` for a longer catch-up.
const DEFAULT_LOOKBACK_MS = 48 * 3_600_000

// Narrower than DEFAULT_LOOKBACK_MS: an errored submit (ack lost, e.g. an
// auth blip) surfaces within a few 5-minute cron ticks, so 30 minutes is
// plenty. Keeping it narrow also avoids re-processing old errored rows,
// which could re-apply a stale SELL against a since-changed position.
const ERRORED_SUBMIT_LOOKBACK_MS = 30 * 60_000

// Bounds each invocation so a backlog can't fan out into a runaway batch.
// Overridable via `ReconcileOptions.limit` to drain a backlog deliberately.
const DEFAULT_ROW_LIMIT = 50

// `sanity_failed` / `repair_skipped_invalid_row` are structural — retrying
// won't change the broker's data or fix a malformed row. Everything else
// (broker_5xx, network, DO unavailable) is transient and should keep
// retrying past MAX_REPAIR_ATTEMPTS.
function isPermanentSanityFailure(error: string | null | undefined): boolean {
  if (!error) return false
  return error.includes('sanity_failed') || error.includes('repair_skipped_invalid_row')
}

interface ReconcileOptions {
  env: Env
  /** Correlates reconcile logs with the originating request/cron run. */
  requestId?: string
  /** How far back to scan for unreconciled post_submit rows. Default 48h. */
  lookbackMs?: number
  /** Cap on rows inspected per call so a single invocation doesn't fan out. */
  limit?: number
  /**
   * Pages of broker history to sweep when the first-page lookup misses.
   * `1` (default) = single page only. The repair cohort never re-polls
   * Webull regardless of this value — only the fresh-poll cohort uses it.
   */
  historyMaxPages?: number
  /** Page size for both the initial lookup and the deep-lookup sweep. Default 50. */
  historyPageSize?: number
  now?: () => Date
  /** @deprecated No-op since the repair cohort started ignoring `lookbackMs` unconditionally; kept for route/signature compatibility. */
  retryStateApply?: boolean
}

/**
 * Polls Webull for locally-submitted orders without a terminal
 * `broker_status`, applies fill-carrying terminal rows into SymbolStateDO /
 * PortfolioStateDO, and stamps `state_applied_at` so a failed DO apply
 * retries on the next tick instead of leaving D1 and the DO split-brained.
 */
export async function reconcileFills(options: ReconcileOptions): Promise<ReconcileSummary> {
  // Fail-closed: a silent empty summary would be indistinguishable from
  // "nothing to reconcile" and hide a misconfigured binding.
  if (!options.env.DB) {
    throw new Error('reconcileFills requires env.DB binding (D1 not configured)')
  }
  const summary: ReconcileSummary = {
    inspected: 0,
    updated: [],
    stillPending: [],
    notFound: [],
    notFoundRecentWindow: [],
    notFoundAfterDeepLookup: [],
    errors: [],
    stateApplied: 0,
    stateApplyFailed: 0,
    repaired: 0,
    abandoned: 0,
  }

  const now = options.now ?? (() => new Date())
  // Single basis timestamp for this run — per-call `new Date()` would
  // lengthen the lookback/cooldown windows on a delayed catch-up run.
  const runNow = now()
  const since = new Date(runNow.getTime() - (options.lookbackMs ?? DEFAULT_LOOKBACK_MS)).toISOString()
  const erroredSince = new Date(runNow.getTime() - ERRORED_SUBMIT_LOOKBACK_MS).toISOString()
  const limit = options.limit ?? DEFAULT_ROW_LIMIT
  const historyMaxPages = Math.max(1, options.historyMaxPages ?? 1)
  const historyPageSize = options.historyPageSize ?? 50

  // Preloads the symbol→currency map (exposure tracking) and pair-regime
  // table (pair-switch cooldown) in one shot. Best-effort: on failure both
  // stay undefined and callers fall back (JP-numeric currency heuristic;
  // pair cooldown simply skipped) rather than blocking reconcile — the
  // exposure counter alone is recoverable via /admin/portfolio/seed-exposure.
  // Loaded before `createDb` below so mocked test fixtures that depend on
  // call order keep their SELECT mock on the second `createDb` call.
  let symbolCurrency: Record<string, SymbolCurrency> | undefined
  let pairRegimes: PairRegimeEntry[] | undefined
  if (options.env.PORTFOLIO_STATE) {
    try {
      const universe = await loadSymbolUniverse(options.env)
      symbolCurrency = universe.symbolCurrency
      pairRegimes = universe.pairRegimes
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'reconcile_symbol_currency_load_failed',
          requestId: options.requestId,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  const db = createDb(options.env.DB)

  // Reuses the `db` handle above (a second createDb call would break
  // call-order-dependent test mocks). Read failure falls back to gross
  // (fee=0) rather than aborting — blocking here would stall every fill's
  // DO apply, which is worse than an unadjusted PnL.
  let tradeCost: TradeCostConfig = { feePctOfNotional: 0, feeFixedPerOrder: 0 }
  try {
    const globalConfigSnapshot = await loadGlobalConfig(db, options.requestId)
    tradeCost = {
      feePctOfNotional: globalConfigSnapshot.feePctOfNotional,
      feeFixedPerOrder: globalConfigSnapshot.feeFixedPerOrder,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'reconcile_trade_cost_config_error',
        requestId: options.requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  // Terminal-with-fill, DO apply not yet stamped — status is already known,
  // so no broker poll is needed, just a DO retry. Ignores `since`: a repair
  // row is a cheap DO-only retry, so aging it out of the lookback window
  // would strand it in split-brain indefinitely (bounded instead by
  // LIMIT + the MAX_REPAIR_ATTEMPTS auto-abandon path below).
  const repairFilter = and(
    isNull(tradeJournal.stateAppliedAt),
    isNotNull(tradeJournal.filledPrice),
    or(
      eq(tradeJournal.brokerStatus, 'FILLED'),
      and(
        inArray(tradeJournal.brokerStatus, ['CANCELLED', 'CANCELED', 'EXPIRED']),
        // Without this guard, every no-fill cancel/expiry ever recorded
        // would match isNull(stateAppliedAt) and get re-swept into
        // repair_skipped_invalid_row on every tick, forever.
        gt(tradeJournal.filledQty, 0),
      ),
    ),
  )
  // Same terminal-with-fill shape as `repairFilter`, but for rows whose
  // cached filled_price was rejected by the sanity guard (null) — that
  // cache can't be trusted, so these get a fresh broker poll instead of
  // the cache-only repair path.
  const priceRetryFilter = and(
    isNull(tradeJournal.stateAppliedAt),
    isNull(tradeJournal.filledPrice),
    gt(tradeJournal.filledQty, 0),
    inArray(tradeJournal.brokerStatus, ['FILLED', 'CANCELLED', 'CANCELED', 'EXPIRED']),
  )
  const preSubmit = alias(tradeJournal, 'pre_submit')

  // submitted=true rows are polled/repaired: fresh-poll and price-retry
  // within the `since` lookback (bounds broker pressure from old rows),
  // repair unconditionally (see repairFilter above).
  const freshPollCohort = and(isNull(tradeJournal.brokerStatus), gte(tradeJournal.timestamp, since))
  const priceRetryCohort = and(priceRetryFilter, gte(tradeJournal.timestamp, since))
  const submittedCohort = and(
    eq(tradeJournal.submitted, true),
    or(freshPollCohort, priceRetryCohort, repairFilter),
  )
  // Rows where submit itself threw (ack lost, e.g. an auth blip) — status
  // was never recorded, so these need the same broker poll as a fresh row,
  // but bounded to the much narrower `erroredSince` window (see
  // ERRORED_SUBMIT_LOOKBACK_MS).
  const erroredAckLostCohort = and(
    isNotNull(tradeJournal.errorClass),
    isNull(tradeJournal.brokerStatus),
    gte(tradeJournal.timestamp, erroredSince),
  )

  const candidates = await db
    .select({
      id: tradeJournal.id,
      clientOrderId: tradeJournal.clientOrderId,
      symbol: tradeJournal.symbol,
      side: tradeJournal.side,
      preSubmitSide: preSubmit.side,
      // Our signed intent at order time — preferred over the broker's
      // echoed limit_price as resolveFilledPrice's sanity-check reference
      // because it can't be poisoned by a broker stub.
      preSubmitLimitPrice: preSubmit.limitPrice,
      brokerStatus: tradeJournal.brokerStatus,
      filledQty: tradeJournal.filledQty,
      filledPrice: tradeJournal.filledPrice,
      realizedPnl: tradeJournal.realizedPnl,
      stateAppliedAt: tradeJournal.stateAppliedAt,
      stateApplyAttempts: tradeJournal.stateApplyAttempts,
      // Read by isPermanentSanityFailure to classify auto-abandon eligibility.
      stateApplyError: tradeJournal.stateApplyError,
    })
    .from(tradeJournal)
    .leftJoin(
      preSubmit,
      and(
        eq(preSubmit.clientOrderId, tradeJournal.clientOrderId),
        eq(preSubmit.tradeEventType, 'pre_submit'),
      ),
    )
    .where(
      and(
        eq(tradeJournal.tradeEventType, 'post_submit'),
        or(submittedCohort, erroredAckLostCohort),
      ),
    )
    .groupBy(tradeJournal.id)
    // Oldest first so a BUY is always applied before its dependent SELL
    // within one tick — DESC would apply the SELL first and false-trigger
    // a "no open position" alert.
    .orderBy(asc(tradeJournal.id))
    .limit(limit)

  const uniqueCandidates = dedupeCandidatesByRowId(candidates)
  if (uniqueCandidates.length === 0) return summary

  summary.inspected = uniqueCandidates.length
  const client = createWebullReadClient(options.env, {
    accessToken: await resolveAccessToken(options.env),
  })

  for (const row of uniqueCandidates) {
    const coid = row.clientOrderId
    if (!coid) {
      // A post_submit row should always have a coid (our idempotency key) —
      // surface the violation instead of silently dropping the row.
      summary.errors.push({
        clientOrderId: `row_id:${row.id}`,
        message: 'missing client_order_id on post_submit row',
      })
      continue
    }

    // Checked before the repair/price-retry split so a permanently-bad
    // price still hits MAX_REPAIR_ATTEMPTS even after it moves from the
    // cache-only repair path to the fresh-poll path.
    const stuckPendingApply =
      row.stateAppliedAt === null &&
      row.brokerStatus !== null &&
      FILL_CARRYING_TERMINAL_STATUSES.has(row.brokerStatus)

    if (stuckPendingApply) {
      // Only permanent sanity-class failures are abandoned — transient
      // ones (broker_5xx, DO down, network) keep retrying since they can
      // clear on their own. See `isPermanentSanityFailure`.
      if (
        row.stateApplyAttempts >= MAX_REPAIR_ATTEMPTS &&
        isPermanentSanityFailure(row.stateApplyError)
      ) {
        try {
          await markAsAbandoned(
            db,
            row.id,
            row.stateApplyAttempts,
            row.stateApplyError ?? '',
            runNow.toISOString(),
          )
        } catch (error) {
          // Don't let one row's UPDATE failure kill the batch — record it
          // and retry the abandon next tick.
          const message = error instanceof Error ? error.message : String(error)
          console.error(
            JSON.stringify({
              event: 'reconcile_auto_abandon_error',
              requestId: options.requestId,
              rowId: row.id,
              clientOrderId: coid,
              symbol: row.symbol,
              message,
            }),
          )
          summary.errors.push({ clientOrderId: coid, message: `auto_abandon_failed: ${message}` })
          continue
        }
        console.warn(
          JSON.stringify({
            event: 'reconcile_auto_abandon',
            requestId: options.requestId,
            rowId: row.id,
            clientOrderId: coid,
            symbol: row.symbol,
            side: row.side,
            attempts: row.stateApplyAttempts,
            priorError: row.stateApplyError,
          }),
        )
        summary.abandoned += 1
        continue
      }
    }

    // Mirrors the SQL `repairFilter`: same shape means the cached fill is
    // usable and only the DO apply needs retry, so the Webull poll is
    // skipped. `filledPrice === null` routes to the fresh-poll path instead
    // (see `priceRetryFilter`) — that cache is untrustworthy.
    const isRepair =
      row.stateAppliedAt === null &&
      row.filledPrice !== null &&
      (row.brokerStatus === 'FILLED' ||
        ((row.filledQty ?? 0) > 0 &&
          row.brokerStatus !== null &&
          FILL_CARRYING_TERMINAL_STATUSES.has(row.brokerStatus)))

    if (isRepair) {
      // Must not re-poll Webull — history can rotate the row off page 1
      // after a few days, wasting quota for nothing new.
      const symbol = row.symbol
      const side = resolveJournalSide(row.side, row.preSubmitSide)
      const filledQty = row.filledQty ?? null
      const filledPrice = row.filledPrice ?? null
      if (
        symbol === null ||
        side === null ||
        filledQty === null || filledQty <= 0 ||
        filledPrice === null || filledPrice <= 0
      ) {
        // Defensive: should be unreachable given repairFilter's shape, but
        // guards against a malformed row instead of applying garbage.
        const message = `repair_skipped_invalid_row: symbol=${symbol} side=${side} qty=${filledQty} price=${filledPrice}`
        await recordApplyFailure(db, row.id, message)
        summary.errors.push({ clientOrderId: coid, message })
        summary.stateApplyFailed += 1
        continue
      }
      const realizedPnl = row.realizedPnl ?? null
      const ok = await tryApplyAndStamp({
        env: options.env,
        requestId: options.requestId,
        db,
        rowId: row.id,
        clientOrderId: coid,
        symbol,
        side,
        filledQty,
        filledPrice,
        realizedPnl,
        runNow,
        nowIso: runNow.toISOString(),
        symbolCurrency,
        pairRegimes,
      })
      if (ok) {
        summary.stateApplied += 1
        summary.repaired += 1
      } else {
        summary.stateApplyFailed += 1
        summary.errors.push({
          clientOrderId: coid,
          message: 'state_apply_failed (see reconcile_state_apply_error log)',
        })
      }
      continue
    }

    let detail: WebullOrderDetailDto | undefined
    try {
      detail = await client.findOrderByClientId(coid, { pageSize: historyPageSize })
    } catch (error) {
      summary.errors.push({
        clientOrderId: coid,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!detail) {
      if (historyMaxPages <= 1) {
        // Ambiguous: can't tell rotated-off-page-1 from never-existed.
        summary.notFoundRecentWindow.push(coid)
        summary.notFound.push(coid)
        continue
      }
      try {
        detail = await client.findOrderByClientId(coid, {
          maxPages: historyMaxPages,
          pageSize: historyPageSize,
        })
      } catch (error) {
        summary.errors.push({
          clientOrderId: coid,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (!detail) {
        summary.notFoundAfterDeepLookup.push(coid)
        summary.notFound.push(coid)
        continue
      }
    }

    // The JP tenant's filled_price unit isn't documented; keep the raw
    // response (body only — never request/signature/auth headers) so it can
    // be verified offline instead of trusting the parsed value blind.
    {
      const logSymbol = row.symbol ?? detail.symbol
      if (logSymbol && inferWebullMarket(logSymbol) === 'JP') {
        console.log(
          JSON.stringify({
            event: 'webull_order_detail_raw',
            requestId: options.requestId,
            symbol: logSymbol,
            clientOrderId: coid,
            detail_status: detail.status,
            detail_side: detail.side,
            detail_limit_price: detail.limit_price,
            detail_quantity: detail.quantity,
            detail_filled_quantity: detail.filled_quantity,
            items_count: detail.items?.length ?? 0,
            items_summary: detail.items?.map((item) => ({
              filled_price: item.filled_price,
              filled_quantity: item.filled_quantity,
              side: item.side,
              status: item.status,
              raw_keys: Object.keys(item ?? {}),
            })),
            detail_keys: Object.keys(detail ?? {}),
          }),
        )
      }
    }

    const status = detail.status
    if (!status || !TERMINAL_STATUSES.has(status)) {
      summary.stillPending.push({ clientOrderId: coid, status })
      continue
    }

    const filledQty = toNumberOrNull(detail.filled_quantity)
    const filledPrice = resolveFilledPrice(filledQty, detail, {
      requestId: options.requestId,
      clientOrderId: coid,
      symbol: row.symbol ?? detail.symbol ?? null,
      referenceLimitPrice: row.preSubmitLimitPrice ?? null,
    })

    const journalSide = resolveJournalSide(row.side, row.preSubmitSide)
    const resolvedSide = resolveJournalSide(detail.side, journalSide)
    const symbol = row.symbol ?? detail.symbol ?? null

    if (status === 'REJECTED' && filledQty !== null && filledQty > 0) {
      // Applying this would risk poisoning DO state with shares never
      // actually ours — log and leave unapplied for manual reconciliation.
      console.error(
        JSON.stringify({
          event: 'reconcile_rejected_with_fill',
          requestId: options.requestId,
          clientOrderId: coid,
          symbol,
          filledQty,
        }),
      )
    }

    // Must read priorState before the fill is applied to SymbolStateDO —
    // afterward avg cost no longer reflects the pre-fill position.
    let realizedPnl: number | null = null
    let estimatedCost: number | null = null
    if (
      FILL_CARRYING_TERMINAL_STATUSES.has(status) &&
      resolvedSide === 'SELL' &&
      symbol !== null &&
      filledQty !== null && filledQty > 0 &&
      filledPrice !== null && filledPrice > 0 &&
      options.env.SYMBOL_STATE
    ) {
      try {
        const priorState = await new SymbolStateClient(options.env.SYMBOL_STATE).getState(symbol)
        const avg = priorState.position?.avgPrice
        if (typeof avg === 'number' && Number.isFinite(avg) && avg > 0) {
          // Broker doesn't return actual fees — estimate from configured
          // rates; feePctOfNotional=0 (default) makes net equal gross.
          const pnl = netRealizedPnl({
            avgPrice: avg,
            exitPrice: filledPrice,
            quantity: filledQty,
            config: tradeCost,
          })
          realizedPnl = pnl.net
          estimatedCost = pnl.cost > 0 ? pnl.cost : null
        }
      } catch (error) {
        // Non-fatal — realizedPnl just stays unset for this row.
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
          ...(estimatedCost !== null ? { estimatedCost } : {}),
        })
        .where(eq(tradeJournal.id, row.id))
      summary.updated.push({ clientOrderId: coid, status, ...(realizedPnl !== null ? { realizedPnl } : {}) })

      if (
        FILL_CARRYING_TERMINAL_STATUSES.has(status) &&
        resolvedSide !== null &&
        symbol !== null &&
        filledQty !== null && filledQty > 0 &&
        filledPrice !== null && filledPrice > 0
      ) {
        const ok = await tryApplyAndStamp({
          env: options.env,
          requestId: options.requestId,
          db,
          rowId: row.id,
          clientOrderId: coid,
          symbol,
          side: resolvedSide,
          filledQty,
          filledPrice,
          realizedPnl,
          runNow,
          nowIso: runNow.toISOString(),
          symbolCurrency,
        })
        if (ok) {
          summary.stateApplied += 1
        } else {
          summary.stateApplyFailed += 1
          summary.errors.push({
            clientOrderId: coid,
            message: 'state_apply_failed (see reconcile_state_apply_error log)',
          })
        }
      } else if (FILL_CARRYING_TERMINAL_STATUSES.has(status)) {
        // shouldRetryStateApply distinguishes a genuine no-op (stamp the
        // marker, never retry) from a price sanity-rejection (leave NULL so
        // the repair cohort retries once the broker returns a realistic
        // price).
        if (shouldRetryStateApply(filledQty, filledPrice, status)) {
          await recordApplyFailure(db, row.id, 'sanity_failed: filled_price rejected by ratio guard')
          summary.stateApplyFailed += 1
          summary.errors.push({
            clientOrderId: coid,
            message: 'state_apply_failed (sanity_failed: filled_price rejected by ratio guard)',
          })
        } else {
          await db
            .update(tradeJournal)
            .set({
              stateAppliedAt: runNow.toISOString(),
              stateApplyError: null,
              stateApplyAttempts: sql`${tradeJournal.stateApplyAttempts} + 1`,
            })
            .where(eq(tradeJournal.id, row.id))
        }
      }

      if (symbol !== null) {
        await clearPendingLockIfMatches(
          options.env,
          options.requestId,
          symbol,
          coid,
        )
      }
    } catch (error) {
      // Don't let one row's UPDATE failure kill the batch — record it and
      // retry next tick.
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
 * Applies a fill into SymbolStateDO/PortfolioStateDO and, on success, stamps
 * `state_applied_at`. Returns `false` (leaving the marker NULL) on any
 * failure so the row retries on the next reconcile tick.
 */
async function tryApplyAndStamp(args: {
  env: Env
  requestId?: string
  db: ReturnType<typeof createDb>
  rowId: number
  clientOrderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  filledQty: number
  filledPrice: number
  realizedPnl: number | null
  runNow: Date
  nowIso: string
  /** Undefined when the universe load failed; `applyFillToState` then falls back to the JP-numeric currency heuristic. */
  symbolCurrency?: Record<string, SymbolCurrency>
  /** Pre-loaded regime-enabled pairs for pair-switch cooldown (best-effort; undefined skips it). */
  pairRegimes?: PairRegimeEntry[]
}): Promise<boolean> {
  const {
    env,
    requestId,
    db,
    rowId,
    clientOrderId,
    symbol,
    side,
    filledQty,
    filledPrice,
    realizedPnl,
    runNow,
    nowIso,
    symbolCurrency,
    pairRegimes,
  } = args

  try {
    await applyFillToState({
      env,
      requestId,
      clientOrderId,
      symbol,
      side,
      filledQty,
      filledPrice,
      realizedPnl,
      runNow,
      symbolCurrency,
      pairRegimes,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      JSON.stringify({
        event: 'reconcile_state_apply_error',
        requestId,
        rowId,
        clientOrderId,
        symbol,
        side,
        message,
      }),
    )
    await recordApplyFailure(db, rowId, message)
    return false
  }

  try {
    await db
      .update(tradeJournal)
      .set({
        stateAppliedAt: nowIso,
        stateApplyError: null,
        stateApplyAttempts: sql`${tradeJournal.stateApplyAttempts} + 1`,
      })
      .where(eq(tradeJournal.id, rowId))
    console.log(
      JSON.stringify({
        event: 'reconcile_state_applied',
        requestId,
        rowId,
        clientOrderId,
        symbol,
        side,
      }),
    )
  } catch (error) {
    // Marker UPDATE failed after the DO apply succeeded — the row will be
    // re-selected and retried next tick. Safe: recordFillOnce /
    // applyRealizedPnlOnce are idempotent by clientOrderId, so the retry
    // no-ops on the DO side; only the marker stamp is actually missing.
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      JSON.stringify({
        event: 'reconcile_state_marker_update_error',
        requestId,
        rowId,
        clientOrderId,
        symbol,
        side,
        message,
      }),
    )
    return false
  }
  return true
}

function resolveJournalSide(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): 'BUY' | 'SELL' | null {
  if (primary === 'BUY' || primary === 'SELL') return primary
  if (fallback === 'BUY' || fallback === 'SELL') return fallback
  return null
}

/**
 * True when a fill-carrying terminal row has a real fill (qty>0) but
 * `resolveFilledPrice` rejected the price as a stub (filledPrice=null).
 * Leaves `state_applied_at` NULL instead of stamping it, so the repair
 * cohort retries with a fresh broker poll rather than a permanent no-op.
 */
function shouldRetryStateApply(
  filledQty: number | null,
  filledPrice: number | null,
  brokerStatus: string | null,
): boolean {
  return (
    brokerStatus !== null &&
    FILL_CARRYING_TERMINAL_STATUSES.has(brokerStatus) &&
    filledQty !== null &&
    filledQty > 0 &&
    filledPrice === null
  )
}

function dedupeCandidatesByRowId<T extends { id: number; side: string | null; preSubmitSide?: string | null }>(
  rows: T[],
): T[] {
  const byId = new Map<number, T>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    if (!existing) {
      byId.set(row.id, row)
      continue
    }
    // Prefer whichever duplicate join row has a resolvable side (an
    // append-only journal can produce more than one pre_submit join match).
    if (resolveJournalSide(existing.side, existing.preSubmitSide) === null &&
      resolveJournalSide(row.side, row.preSubmitSide) !== null) {
      byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

/**
 * Force-stamps `state_applied_at` so a permanently-stuck repair row drops
 * out of the cohort. Not best-effort: if this UPDATE fails, the caller must
 * see it (row stays in cohort, same alert keeps firing) — caller wraps it
 * in try/catch so one row's failure doesn't kill the batch.
 */
async function markAsAbandoned(
  db: ReturnType<typeof createDb>,
  rowId: number,
  attempts: number,
  priorError: string,
  nowIso: string,
): Promise<void> {
  const message = `auto_abandoned_after_${attempts}_attempts: ${priorError}`
  await db
    .update(tradeJournal)
    .set({
      stateAppliedAt: nowIso,
      stateApplyError: message,
      stateApplyAttempts: sql`${tradeJournal.stateApplyAttempts} + 1`,
    })
    .where(eq(tradeJournal.id, rowId))
}

async function recordApplyFailure(
  db: ReturnType<typeof createDb>,
  rowId: number,
  message: string,
): Promise<void> {
  // Best-effort. If even this UPDATE fails the row simply keeps its prior
  // attempts/error state and gets re-tried next tick — no need to escalate.
  try {
    await db
      .update(tradeJournal)
      .set({
        stateApplyError: message,
        stateApplyAttempts: sql`${tradeJournal.stateApplyAttempts} + 1`,
      })
      .where(eq(tradeJournal.id, rowId))
  } catch {
    // Swallow — logged at the call site already.
  }
}

/**
 * Applies a fill into SymbolStateDO (position tracking) and, for SELL legs,
 * PortfolioStateDO (realized PnL). Throws on any DO call failure — caller
 * (`tryApplyAndStamp`) catches it and records the error so the row stays
 * repair-able.
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
  /** Reconcile run basis time — used for cooldown expiry so back-catch-up runs don't lengthen the window past the original fill's next trading day. */
  runNow: Date
  symbolCurrency?: Record<string, SymbolCurrency>
  /** Regime-enabled pairs for pair-switch cooldown (best-effort; undefined skips it). */
  pairRegimes?: PairRegimeEntry[]
}): Promise<void> {
  const {
    env,
    requestId,
    clientOrderId,
    symbol,
    side,
    filledQty,
    filledPrice,
    realizedPnl,
    runNow,
    symbolCurrency,
    pairRegimes,
  } = args
  let symbolApplied = false
  let portfolioApplied = false

  if (env.SYMBOL_STATE) {
    const result = await new SymbolStateClient(env.SYMBOL_STATE).recordFillOnce(symbol, clientOrderId, {
      side,
      qty: filledQty,
      price: filledPrice,
    })
    symbolApplied = result.applied
  }

  if (side === 'SELL' && realizedPnl !== null && env.PORTFOLIO_STATE) {
    const result = await new PortfolioStateClient(env.PORTFOLIO_STATE).applyRealizedPnlOnce(clientOrderId, realizedPnl)
    portfolioApplied = result.applied
  }

  // Non-fatal (drift is repairable via /admin/portfolio/seed-exposure) —
  // must not poison the journal marker since recordFillOnce already
  // idempotently applied the position side. Gated on symbolApplied so a
  // repair retry of an already-applied row doesn't double-count exposure.
  if (env.PORTFOLIO_STATE && symbolApplied) {
    const currency = resolveFillCurrency(symbol, symbolCurrency)
    const notional = filledPrice * filledQty
    if (Number.isFinite(notional) && notional > 0) {
      try {
        await new PortfolioStateClient(env.PORTFOLIO_STATE).applyFillExposure({
          currency,
          side,
          notional,
        })
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'reconcile_exposure_apply_error',
            requestId,
            clientOrderId,
            symbol,
            side,
            currency,
            notional,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
  }

  // Cooldown applies to every completed SELL regardless of realized PnL
  // sign — restricting it to losses left a good exit exposed to an
  // immediate same-day buy-back whipsaw. Parks until `nextSessionOpen`
  // (market open), not a fixed 24h offset — a fixed offset's effective
  // length varied with what time of day the exit happened.
  //
  // Non-fatal (caught + logged): the position/pnl apply already succeeded,
  // so a missed cooldown only loosens a re-entry guard rather than
  // stranding the row in retry.
  if (
    side === 'SELL' &&
    env.SYMBOL_STATE &&
    (symbolApplied || portfolioApplied)
  ) {
    try {
      const market = inferTradingMarket(symbol)
      const cooldownUntil = nextSessionOpen(runNow, market).toISOString()
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

  // Same rule extended to the partner leg of a regime-enabled pair: exiting
  // either side, for any reason, cooldowns the other side too — otherwise a
  // same-day flip to the opposite leg is just the pair-level form of the
  // same whipsaw. Pairs with regime disabled are filtered out of
  // `pairRegimes` upstream. Non-fatal, same as above.
  if (
    side === 'SELL' &&
    env.SYMBOL_STATE &&
    pairRegimes !== undefined &&
    (symbolApplied || portfolioApplied)
  ) {
    try {
      const partner = findPairPartner(symbol, pairRegimes)
      if (partner !== null) {
        const market = inferTradingMarket(partner)
        const until = nextSessionOpen(runNow, market).toISOString()
        await new SymbolStateClient(env.SYMBOL_STATE).setCooldown(partner, until)
        console.warn(
          JSON.stringify({
            event: 'pair_exit_cooldown_applied',
            requestId,
            cooldown: {
              sourceSymbol: symbol.toUpperCase(),
              targetSymbol: partner,
              reason: 'pair_exit_cooldown',
              until,
            },
          }),
        )
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'pair_exit_cooldown_apply_error',
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
 * Releases the symbol's pending-order lock so pullbackScheduler can
 * re-enter. Guarded by clientOrderId: a late reconcile (back-catch-up /
 * cron pause) of an old terminal row must not clear a newer order's lock
 * on the same symbol.
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
 * Recovers an effective fill price when Webull's response has no aggregate
 * `filled_price`: average across positively-priced `items[]` entries, else
 * fall back to the signed `limit_price`, else `null`.
 */
function pickFilledPrice(detail: WebullOrderDetailDto): number | null {
  if (detail.items && detail.items.length > 0) {
    const prices = detail.items
      .map((item) => toNumberOrNull(item.filled_price))
      .filter((n): n is number => n !== null && n > 0)
    if (prices.length > 0) {
      const sum = prices.reduce((acc, n) => acc + n, 0)
      return sum / prices.length
    }
  }
  return toNumberOrNull(detail.limit_price)
}

// A fill more than 2x or under 0.5x the reference limit is treated as a
// stub/parse error and rejected rather than applied. The band is loose
// enough to admit real slippage (MARKET fills, gap-ups, halt reopens)
// while still catching an order-of-magnitude broker stub.
const FILLED_PRICE_RATIO_MIN = 0.5
const FILLED_PRICE_RATIO_MAX = 2

/**
 * Records a fill price only when there's a real fill and it passes the
 * ratio sanity check against a reference limit price. Reference
 * precedence: `context.referenceLimitPrice` (our signed pre_submit
 * intent — broker-stub-proof) over `detail.limit_price` (broker echo,
 * fallback for older callers); if neither is available the ratio check is
 * skipped rather than dropping a healthy fill.
 */
function resolveFilledPrice(
  filledQty: number | null,
  detail: WebullOrderDetailDto,
  context?: {
    requestId?: string
    clientOrderId?: string
    symbol?: string | null
    /**
     * Limit price we recorded at intent time (pre_submit row). Takes
     * precedence over `detail.limit_price` because it is broker-stub-proof.
     */
    referenceLimitPrice?: number | null
  },
): number | null {
  if (filledQty === null || filledQty <= 0) return null
  const candidate = pickFilledPrice(detail)
  if (candidate === null || !Number.isFinite(candidate) || candidate <= 0) return null

  const brokerLimit = toNumberOrNull(detail.limit_price)
  const preSubmitLimit =
    context?.referenceLimitPrice !== undefined && context.referenceLimitPrice !== null &&
    Number.isFinite(context.referenceLimitPrice) && context.referenceLimitPrice > 0
      ? context.referenceLimitPrice
      : null
  const limit = preSubmitLimit !== null ? preSubmitLimit : brokerLimit
  if (limit !== null && limit > 0) {
    const ratio = candidate / limit
    if (ratio < FILLED_PRICE_RATIO_MIN || ratio > FILLED_PRICE_RATIO_MAX) {
      console.warn(
        JSON.stringify({
          event: 'webull_filled_price_sanity_failed',
          requestId: context?.requestId,
          clientOrderId: context?.clientOrderId,
          symbol: context?.symbol,
          candidate,
          pre_submit_limit: preSubmitLimit,
          broker_limit: brokerLimit,
          limit_price: limit,
          ratio,
          detail_status: detail.status,
          detail_side: detail.side,
        }),
      )
      return null
    }
  }
  return candidate
}

/**
 * Falls back to the same JP-numeric heuristic the `/trade/*` route uses
 * (4-digit numeric symbol = JPY, else USD) when the preloaded
 * `symbol_config` map is missing or doesn't have the symbol — keeps
 * exposure tracking alive on a misconfigured environment instead of
 * silently misclassifying a US ETF as JPY.
 */
function resolveFillCurrency(
  symbol: string,
  symbolCurrency: Record<string, SymbolCurrency> | undefined,
): SymbolCurrency {
  const upper = symbol.toUpperCase()
  const mapped = symbolCurrency?.[upper]
  if (mapped === 'USD' || mapped === 'JPY') return mapped
  return /^\d{4}$/.test(upper) ? 'JPY' : 'USD'
}

/** The opposite leg of `symbol`'s regime-enabled pair, or null if it isn't in one. */
function findPairPartner(symbol: string, pairRegimes: PairRegimeEntry[]): string | null {
  const upper = symbol.toUpperCase()
  const pair = pairRegimes.find((p) => p.bullSymbol === upper || p.bearSymbol === upper)
  if (!pair) return null
  return pair.bullSymbol === upper ? pair.bearSymbol : pair.bullSymbol
}

// Exposed for tests.
export const _internal = {
  TERMINAL_STATUSES,
  pickFilledPrice,
  resolveFilledPrice,
  resolveFillCurrency,
  shouldRetryStateApply,
  findPairPartner,
}
