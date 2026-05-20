import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { Env } from '../../config/env'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../../infrastructure/db/schema'
import { createWebullReadClient } from '../../infrastructure/webull/WebullReadClient'
import type { WebullOrderDetailDto } from '../../infrastructure/webull/dto'
import { inferWebullMarket } from '../../infrastructure/webull/mapper'
import { inferTradingMarket, nextTradingDay } from '../domain/tradingCalendar'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'

// Terminal Webull order statuses — once we see one of these we can stop
// polling for this order. Anything else (NEW, PENDING, PARTIALLY_FILLED) is
// still in flight.
//
// Include both `CANCELLED` (British, expected from the SDK enum) and
// `CANCELED` (American, actually observed on the JP UAT tenant's
// orders/history response for a day-expired limit). Matching only one
// spelling left a 15-hour "stillPending" gap on a real SOXL order.
const TERMINAL_STATUSES = new Set<string>([
  'FILLED',
  'CANCELLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
])

export interface ReconcileSummary {
  inspected: number
  updated: Array<{ clientOrderId: string; status: string; realizedPnl?: number }>
  stillPending: Array<{ clientOrderId: string; status?: string }>
  notFound: string[]
  errors: Array<{ clientOrderId: string; message: string }>
  /**
   * Number of rows where the DO state apply succeeded on this run (whether
   * the row was first-seen-FILLED or a repair retry of a previously-failed
   * apply). Bumped after `state_applied_at` is stamped.
   */
  stateApplied: number
  /**
   * Number of rows where the DO state apply attempt threw on this run. The
   * journal row keeps `state_applied_at = NULL` and gets `state_apply_error`
   * recorded so the next reconcile / repair tick can retry.
   */
  stateApplyFailed: number
  /**
   * Of `stateApplied`, how many were repair-mode rows (already FILLED in the
   * journal but not previously applied). Useful to spot persistent split-brain
   * recovery activity in cron logs.
   */
  repaired: number
  /**
   * Number of rows that were force-stamped `state_applied_at` on this run
   * because they exceeded `MAX_REPAIR_ATTEMPTS` with a permanent sanity
   * failure. Bumps `state_apply_error` with an `auto_abandoned_after_*`
   * prefix so an operator can audit them later. Excluded from `errors`
   * (and from the per-row error count surfaced to the alert notifier) so a
   * stuck row stops re-firing the same alarm forever.
   */
  abandoned: number
}

/**
 * Hard cap on how many times the repair cohort retries a row whose
 * `state_apply_error` indicates a permanent sanity-style failure. Beyond
 * this we force-stamp `state_applied_at` to drop the row out of the cohort
 * (see `markAsAbandoned`). Picked at 5 to give a few cron ticks of grace
 * for transient DO blips without letting a structurally-broken row
 * (e.g. broker forever returns `filled_price=10` for a 3516 limit) keep
 * the alert siren going indefinitely.
 *
 * Tunable in code only — moving this to env / runtime config is out of
 * scope (separate PR if needed).
 */
const MAX_REPAIR_ATTEMPTS = 5

/**
 * `state_apply_error` substrings that we treat as "no further retry will
 * help" — repeated reconcile cycles will keep producing the same failure.
 * Distinct from transient errors (`broker_5xx`, `network`, `DO unavailable`,
 * etc.) which should keep retrying.
 *
 * Recognized substrings:
 *   - `sanity_failed` — `resolveFilledPrice()` rejected the broker's price
 *     via the ratio guard. Will keep failing as long as the broker echoes
 *     the same stub.
 *   - `repair_skipped_invalid_row` — repair branch detected a structurally
 *     invalid FILLED row (qty<=0, missing symbol/side, etc.). Cannot be
 *     fixed by retry — the journal row itself is malformed.
 */
function isPermanentSanityFailure(error: string | null | undefined): boolean {
  if (!error) return false
  return error.includes('sanity_failed') || error.includes('repair_skipped_invalid_row')
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
  /**
   * When true, the SELECT also picks up `broker_status='FILLED' AND
   * state_applied_at IS NULL` rows that fall **outside** the lookback window
   * — i.e. anything ever stuck in split-brain. Used by the
   * `/admin/orders/reconcile?retryStateApply=1` repair endpoint. Default
   * `false`: cron-triggered runs only retry rows still inside `lookbackMs`.
   */
  retryStateApply?: boolean
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
 * Idempotency / split-brain repair (issue #142):
 *   - The SELECT picks up `broker_status IS NULL` (first-seen) AND
 *     `broker_status='FILLED' AND state_applied_at IS NULL` (DO apply
 *     previously failed). The latter ensures a single failed DO call does
 *     not strand the row forever — the next cron tick retries.
 *   - After a successful DO apply, `state_applied_at` is stamped on the
 *     row, which removes it from future SELECT candidates. Already-applied
 *     rows are also defensively skipped at the loop level.
 *   - On apply failure the journal keeps `state_applied_at = NULL` and
 *     records `state_apply_error` + bumps `state_apply_attempts` so an
 *     operator can see how many retries it has taken.
 *
 * The previous implementation marked the row reconciled and trusted that
 * any DO failure would be repaired manually — split-brain (D1 = FILLED, DO
 * position = stale) was the result.
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
    stateApplied: 0,
    stateApplyFailed: 0,
    repaired: 0,
    abandoned: 0,
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
  // Two cohorts in one query:
  //   (a) `broker_status IS NULL` — never-reconciled, the original case.
  //   (b) `broker_status='FILLED' AND state_applied_at IS NULL` — D1 says
  //       FILLED but DO apply previously threw (or was never attempted on a
  //       row that was UPDATEd before this code shipped).
  //
  // For cohort (b), the `retryStateApply` flag controls whether the
  // `lookbackMs` bound applies. Cron-triggered runs leave it false and
  // only repair rows still inside the lookback window (match the original
  // 48h scope). The repair endpoint sets it true to sweep older split-brain
  // rows that have aged out of the window.
  const repairFilter = and(
    eq(tradeJournal.brokerStatus, 'FILLED'),
    isNull(tradeJournal.stateAppliedAt),
  )
  const preSubmit = alias(tradeJournal, 'pre_submit')
  const candidates = await db
    .select({
      id: tradeJournal.id,
      clientOrderId: tradeJournal.clientOrderId,
      symbol: tradeJournal.symbol,
      side: tradeJournal.side,
      preSubmitSide: preSubmit.side,
      // pre_submit の limit_price は intent 時に我々が signed した値で、
      // D1 内に確定している。broker が JP sandbox stub で
      // detail.limit_price=10 を返しても、こちらの値は影響を受けない。
      // PR #223 sanity check が broker の stub limit_price と stub
      // filled_price の両方が同値で ratio=1 になり pass してしまう穴を
      // 塞ぐため、reference 候補として優先利用する。
      preSubmitLimitPrice: preSubmit.limitPrice,
      brokerStatus: tradeJournal.brokerStatus,
      filledQty: tradeJournal.filledQty,
      filledPrice: tradeJournal.filledPrice,
      realizedPnl: tradeJournal.realizedPnl,
      stateAppliedAt: tradeJournal.stateAppliedAt,
      stateApplyAttempts: tradeJournal.stateApplyAttempts,
      // Required by the auto-abandon path so we can decide whether the
      // prior failure was a permanent sanity-class error (retry will not
      // help) vs a transient one. See `isPermanentSanityFailure`.
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
        eq(tradeJournal.submitted, true),
        // Lookback の適用は cohort 別に分かれる (#268):
        //   - fresh poll cohort (broker_status NULL): broker への問合せが必要
        //     なので、古い行を毎 tick 引っ張ると broker pressure になる
        //     (default 48h cap)。
        //   - repair cohort (broker_status='FILLED' AND state_applied_at NULL):
        //     broker poll 不要 (broker_status 確認済)、DO RPC のみで軽量。
        //     **lookback 無視で常に sweep** する。これにより長期保有 fill が
        //     48h 経過後 aged-out で permanent split-brain になる事故を防ぐ。
        //     行数爆発は SELECT LIMIT 50 で bounded、永続 fail 行は #228 の
        //     auto-abandon (MAX_REPAIR_ATTEMPTS=5) で cohort から自動的に外れる。
        //
        // `retryStateApply` フラグは残してあるが #268 以降は no-op
        // (互換性のため signature 維持、将来 admin 側で別 sweep モードに
        // 再定義する余地)。
        or(
          and(isNull(tradeJournal.brokerStatus), gte(tradeJournal.timestamp, since)),
          repairFilter,
        ),
      ),
    )
    .groupBy(tradeJournal.id)
    // ASC = 古い順 = chain 依存 (BUY → SELL) が natural 順で 1 tick 内解決
    // (#270)。DESC だと SELL を先に処理して DO 上ポジ無し→ "Cannot SELL
    // without an open position" の false-positive alert が出る。
    // 古い行を全部捌いてから新しい行に進むので、long-term 蓄積した repair
    // cohort も時系列どおり apply される。LIMIT 50 + 5min cron で「古い行
    // 優先で詰まって新しい行が遅延」状況は long-term 蓄積でしか起きない
    // (= 別問題、#228 auto-abandon と組み合わせれば自然に収束)。
    .orderBy(asc(tradeJournal.id))
    .limit(limit)

  const uniqueCandidates = dedupeCandidatesByRowId(candidates)
  if (uniqueCandidates.length === 0) return summary

  summary.inspected = uniqueCandidates.length
  const client = createWebullReadClient(options.env)

  for (const row of uniqueCandidates) {
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

    // Distinguish the two cohorts so we can:
    //   - skip the Webull poll for already-FILLED repair rows (we already
    //     have the canonical fill data on the journal row),
    //   - count the repair stat correctly for ops visibility.
    //
    // `broker_status='FILLED' AND state_applied_at IS NULL` is the repair
    // case: status is canonical, only the DO apply needs retry. Any other
    // shape (NULL broker_status) means we still need a fresh status from
    // the broker.
    const isRepair = row.brokerStatus === 'FILLED' && row.stateAppliedAt === null

    if (isRepair) {
      // Auto-abandon: a row that has tripped a permanent sanity-class
      // error MAX_REPAIR_ATTEMPTS times in a row is not going to recover
      // on the next tick. Force-stamp `state_applied_at` so:
      //   - it falls out of the repair cohort SELECT,
      //   - subsequent reconcile cycles do not include it in
      //     `summary.errors` and so the `reconcile_fills_partial`
      //     alarm stops re-firing for the same stuck row.
      //
      // The prior error is preserved (prefixed with
      // `auto_abandoned_after_<n>_attempts:`) for operator audit. We
      // emit a `reconcile_auto_abandon` audit log so dashboards / alert
      // pipelines can pick up the event separately from the noisy
      // partial-error alarm.
      //
      // Transient errors (broker_5xx, DO unavailable, network) are
      // intentionally NOT auto-abandoned — those can clear on their own
      // and should keep retrying past 5 attempts. See
      // `isPermanentSanityFailure` for the included substrings.
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
          // The auto-abandon UPDATE itself failed (e.g. D1 throttled, transient
          // bind error). Do not let a single row kill the whole batch — log,
          // record the failure on the run summary, and move on to the next
          // row. The cohort SELECT will pick this row up again next tick and
          // retry the abandon.
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

      // Use the canonical fill data already on the row. We must not
      // re-poll Webull — orders/history can rotate the row off the first
      // page after a few days, and re-polling would also waste a quota.
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
        // The row was stamped FILLED earlier but is missing one of the
        // fields required to apply the fill (impossibility under the
        // current code path, but defensive). Mark the apply as
        // permanently-skipped via an error so an operator can investigate.
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

    // P0 raw response capture for JP tenant. We've observed the JP UAT
    // returning `items[].filled_price=10` as a stub on orders that should
    // have filled near 2683 (issue: 6971 ping-pong loop). The official doc
    // does not pin down the unit, so emit the raw response (response body
    // only — never the request body / signature / auth headers) so the
    // parser can be confirmed against real data. Limited to JP and one log
    // per row per reconcile cycle (cron is 5min, so this is not noisy).
    // Once the unit is confirmed, this log can be removed or guarded by a
    // debug flag.
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
      // 我々が intent で signed した limit。broker stub に依存しない。
      referenceLimitPrice: row.preSubmitLimitPrice ?? null,
    })

    // Compute realized P&L for SELL fills BEFORE we touch any state. Needs
    // the symbol's current avg cost from SymbolStateDO, which is only
    // meaningful after we've been recording BUY fills. Early trades with no
    // prior position yield realized=null (can't compute).
    const journalSide = resolveJournalSide(row.side, row.preSubmitSide)
    const resolvedSide = resolveJournalSide(detail.side, journalSide)
    const symbol = row.symbol ?? detail.symbol ?? null
    let realizedPnl: number | null = null
    if (
      status === 'FILLED' &&
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
      // layer. Failure here records `state_apply_error` and leaves
      // `state_applied_at = NULL` so the next reconcile tick will retry.
      if (
        status === 'FILLED' &&
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
      } else if (status === 'FILLED') {
        // FILLED but missing one of the apply prerequisites. Two sub-cases:
        //
        //   (a) Genuine no-op — e.g. filledQty=0 (CANCELLED-then-FILLED edge,
        //       or REJECTED-then-FILLED) or symbol/side missing on the row.
        //       Nothing to apply now and nothing the next tick will recover,
        //       so stamp `state_applied_at` to prevent forever-retry.
        //
        //   (b) Transient sanity failure — `filledQty > 0` but
        //       `filledPrice === null` because `resolveFilledPrice()`
        //       rejected the candidate (e.g. JP `items[].filled_price=10`
        //       stub vs limit ~2683 → ratio 0.0037 → null). The next
        //       reconcile tick may get a realistic price from the broker;
        //       leave `state_applied_at` NULL so the row stays in the
        //       repair cohort.
        //
        // `shouldRetryStateApply` distinguishes (b). For it we still record
        // the reason via `state_apply_error` for operator visibility, but
        // do NOT stamp the marker.
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
 * Apply a terminal FILLED order into SymbolStateDO + PortfolioStateDO and,
 * on success, stamp `state_applied_at` on the journal row. On failure the
 * row keeps `state_applied_at = NULL` and gets `state_apply_error` recorded
 * so the next reconcile tick (or `?retryStateApply=1` repair sweep) can
 * pick it back up.
 *
 * Returns `true` on success (marker stamped), `false` on failure.
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

  // Apply succeeded. Stamp the marker so the row is excluded from future
  // SELECT candidates.
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
    // Marker UPDATE failed *after* DO apply succeeded — log loudly. The DO
    // is now ahead of the journal; the row will be re-selected next tick
    // and the apply will run a second time. SymbolStateDO.recordFill is
    // not idempotent on its own, so this is a real risk and operator
    // intervention may be needed.
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
 * True when a FILLED row has a positive filledQty but `filledPrice` came back
 * null from `resolveFilledPrice` — i.e. the broker reported a fill but the
 * sanity guardrail rejected the price as a stub. We deliberately keep
 * `state_applied_at = NULL` for these rows so the repair cohort
 * (broker_status='FILLED' AND state_applied_at IS NULL) re-selects them on
 * the next reconcile tick. If the broker eventually returns a realistic
 * price, the apply runs normally; if it never does, we never poison DO state.
 *
 * Genuine no-ops (filledQty=0, missing symbol/side, etc.) fall through to the
 * marker stamp so they don't retry forever.
 */
function shouldRetryStateApply(
  filledQty: number | null,
  filledPrice: number | null,
  brokerStatus: string | null,
): boolean {
  return (
    brokerStatus === 'FILLED' &&
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
    // Defensive fallback for malformed append-only journals. If a duplicate
    // join row has the only usable pre_submit side, keep that one while still
    // processing the post_submit row at most once.
    if (resolveJournalSide(existing.side, existing.preSubmitSide) === null &&
      resolveJournalSide(row.side, row.preSubmitSide) !== null) {
      byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

/**
 * Force-stamp `state_applied_at` on a permanently-stuck repair row. Used
 * by the auto-abandon path: after MAX_REPAIR_ATTEMPTS retries on a
 * sanity-class failure we accept that the next tick will not help and
 * drop the row out of the repair cohort.
 *
 * The prior error is preserved verbatim, prefixed with
 * `auto_abandoned_after_<attempts>_attempts:` so an operator running a
 * journal query can tell at a glance which rows were force-closed vs
 * applied normally.
 *
 * NOT a best-effort path: if this UPDATE fails the row stays in the
 * cohort and the same alert keeps firing — surface the failure to the
 * caller so the run summary reflects reality. Caller wraps it in a
 * try/catch so a single row's failure does not kill the whole batch.
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
 * Apply a terminal FILLED order into SymbolStateDO (position tracking) and,
 * for SELL legs, PortfolioStateDO (realized PnL aggregation).
 *
 * Throws on any underlying DO call failure — caller (`tryApplyAndStamp`)
 * catches and records the error so the row stays repair-able.
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
  let symbolApplied = false
  let portfolioApplied = false

  if (env.SYMBOL_STATE) {
    // Throws on DO failure — caller records `state_apply_error` and will
    // retry on the next reconcile tick.
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

  // Stop-out cooldown: a losing exit parks the symbol until the next trading
  // day so a whipsaw re-entry cannot compound the loss. Ported from the
  // removed TradeEventHandler — pullbackScheduler reads `state.cooldownUntil`
  // for its signal decision, so without this write the strategy never
  // backs off after a losing sell.
  //
  // Cooldown failures are intentionally NON-fatal (caught + logged) because
  // the position itself has already been correctly recorded, and a missed
  // cooldown only loosens a re-entry guard rather than producing
  // double-counted state. We don't want a transient cooldown failure to
  // strand the row in retry forever after position+pnl have already
  // applied.
  if (
    side === 'SELL' &&
    realizedPnl !== null &&
    realizedPnl < 0 &&
    env.SYMBOL_STATE &&
    (symbolApplied || portfolioApplied)
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
      .map((item) => toNumberOrNull(item.filled_price))
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
 * Sanity guardrail: a fill price more than 2x or less than 0.5x the
 * signed limit price is treated as a stub / parse error and rejected. The
 * trigger was JP UAT returning `items[].filled_price=10` on a 6971 order
 * with limit ~2683 (~268x deviation), which then propagated as
 * `avgPrice=10` into SymbolStateDO and produced a +26730% pnl in
 * pullbackScheduler — kicking off a TP→SELL→re-fill ping-pong loop.
 *
 * Returning `null` here causes the reconcile loop to leave
 * `state_applied_at` NULL and skip the DO apply path, so the bogus price
 * never lands in DO state. The next reconcile tick retries; if the
 * broker eventually returns a realistic price we apply normally, and if
 * not we never poison the DO.
 *
 * The threshold is intentionally loose (2x band) because:
 *   - MARKET orders can fill outside the limit on a fast-moving symbol,
 *   - intraday gap-ups / haltreopens also produce >1x moves.
 *   2x catches order-of-magnitude stubs without flagging realistic vol.
 */
const FILLED_PRICE_RATIO_MIN = 0.5
const FILLED_PRICE_RATIO_MAX = 2

/**
 * Only record a fill price when there's actually a fill, and only if it
 * passes the "finite and > 0" guideline. For CANCELLED / REJECTED rows
 * (filledQty=0) this returns null so we don't misrepresent the row as if
 * it had transacted at the signed limit price.
 *
 * Also rejects fills whose price is wildly inconsistent with the signed
 * limit (`<0.5x` or `>2x`) — see `FILLED_PRICE_RATIO_*` for the rationale.
 *
 * Reference limit price selection (issue: 9697 ping-pong loop):
 *   1. `context.referenceLimitPrice` (= our intent, persisted on the
 *      `pre_submit` trade_journal row at signing time). Preferred because
 *      it does not depend on broker behaviour — JP sandbox has been
 *      observed to echo a stub `detail.limit_price` that matches its stub
 *      `filled_price` (e.g. both 10) so the ratio collapses to 1 and the
 *      sanity guard passes a wildly wrong fill.
 *   2. `detail.limit_price` (broker response) as fallback for paths that
 *      can't surface the pre_submit reference (e.g. older callers).
 *   3. Neither available → ratio check is skipped (defensive: better to
 *      keep the fill than to drop a healthy MARKET-style order).
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
  // Prefer pre_submit (our signed intent) over broker echo. Falls back to
  // broker for legacy callers that don't pass referenceLimitPrice.
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
          // Both reference candidates included so the diff between our
          // intent and the broker echo is easy to inspect during ops.
          pre_submit_limit: preSubmitLimit,
          broker_limit: brokerLimit,
          // Effective reference used for the ratio check.
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

// Exposed for tests.
export const _internal = {
  TERMINAL_STATUSES,
  pickFilledPrice,
  resolveFilledPrice,
  shouldRetryStateApply,
}
