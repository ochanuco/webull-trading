import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../app'
import { rateLimit } from '../middleware/rateLimit'
import { ValidationError } from '../shared/errors'
import { createWebullReadClient } from '../infrastructure/webull/WebullReadClient'
import { refreshWebullToken } from '../infrastructure/webull/refreshWebullToken'
import { refreshTradableAllowlist } from '../infrastructure/webull/refreshTradableAllowlist'
import {
  getTradableAllowlistStatus,
  getTradableStatusForSymbol,
} from '../infrastructure/db/tradableInstrumentsRepo'
import {
  resolveAccessToken,
  resolveAccessTokenWithSource,
} from '../infrastructure/webull/resolveAccessToken'
import { WebullAuth } from '../infrastructure/webull/WebullAuth'
import { lookupInstrument } from '../infrastructure/webull/instrumentLookup'
import {
  buildPreviewOrderVariants,
  checkTradability,
} from '../infrastructure/webull/tradabilityCheck'
import { WebullTokenClient } from '../infrastructure/webull/WebullTokenClient'
import { WebullTokenStateClient } from '../trading/state/WebullTokenStateClient'
import { buildSignedHeaders } from '../infrastructure/webull/WebullAuth'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import { reconcileFills } from '../trading/reconciliation/reconcileFills'
import { syncHoldings } from '../trading/reconciliation/syncHoldings'
import { runStrategyCron } from '../trading/strategy/runStrategyCron'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { selectBarClient } from '../infrastructure/quotes/BarClient'
import { loadUsdJpyRate } from '../infrastructure/quotes/fxRate'
import {
  buildCashRebalancePlan,
  computeConditionalAllocation,
  type EntrySnapshot,
} from '../trading/strategy/conditionalAllocation'
import { deriveEntryStatusFromIndicators } from '../trading/strategy/entryStatus'
import { computePullbackIndicators, type DailyBar } from '../trading/strategy/indicators'
import { buildSymbolRules } from '../trading/strategy/symbolRuleResolution'
import { YahooBarClient, toYahooSymbol } from '../infrastructure/quotes/YahooBarClient'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { earningsCalendar, macroEventCalendar, tradeJournal } from '../infrastructure/db/schema'
import { extractActor, recordChange } from '../infrastructure/db/configAuditLog'
import { recordPortfolioEquitySnapshot } from '../infrastructure/db/portfolioEquitySnapshotRepo'
import {
  createSymbolPair,
  type CounterpartMeta,
  deleteInversePairsForSymbol,
  findSymbolConfig,
  insertSymbolConfig,
  hardDeleteSymbol,
  loadInversePairs,
  toggleSymbolActive,
  updateBudgetAllocPct,
  updateCashFallback,
  MAX_CASH_FALLBACKS,
  parseCashFallbacksJson,
  updateSymbolConfig,
  isSymbolRole,
  SYMBOL_ROLES,
  type SymbolConfigWriteInput,
  type SymbolRole,
} from '../infrastructure/db/symbolConfigRepo'
import type { SymbolConfigRow } from '../infrastructure/db/schema'
import {
  applyTradingToggle,
  createTradingToggleDb,
} from '../infrastructure/db/tradingToggleRepo'
import { resolveTradingEnabled } from '../trading/runtime/killSwitch'
import { collectProductionReadiness } from '../trading/runtime/productionReadiness'
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
  type EarningsCalendarSeedInput,
} from '../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
  type MacroEventCalendarSeedInput,
} from '../infrastructure/calendar/macroEventCalendarRepo'
import { runBacktest, type BacktestParams } from '../trading/backtest/runBacktest'
import {
  runLifecycleBacktest,
  type EntryPolicy,
  type ExitPolicy,
  type LifecycleBacktestParams,
  type ReentryPolicy,
} from '../trading/backtest/runLifecycleBacktest'
import type { SymbolRule } from '../trading/strategy/strategies/PullbackUptrendStrategy'

/**
 * Operator-only endpoints. Basic-auth-protected by the same middleware as
 * `/trade/*` at mount time. Use sparingly — these mutate DO state out-of-band
 * and should only be called for initial seeding or reconciliation.
 */
export const admin = new Hono<AppBindings>()
  /**
   * Read-only preflight: aggregates D1/DO/env state for fail-closed
   * verification before live enablement. Broker communication lives in
   * `/admin/broker/probe`, not here, to keep this endpoint side-effect free.
   */
  .get('/production-readiness', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await collectProductionReadiness(c.env, c.get('requestId')))
  })
  /**
   * Operator override for a corrupted `position`, e.g. after a reconcile
   * race leaves DO state ahead of broker truth — recordFill can't undo that
   * (there's no fill to apply), so this resets the position directly.
   *
   * Body: `{ qty: number, avgPrice: number, openedAt?: string | null, reason: string }`
   *   - `qty=0` closes the position (avgPrice / openedAt ignored)
   *   - `qty>0` writes `{ qty, avgPrice, openedAt: openedAt ?? now() }`
   *
   * Leaves `pendingOrder` / `cooldownUntil` / `settledCash` untouched.
   */
  .post('/symbol-state/:symbol/override-position', rateLimit('ADMIN_WRITE'), async (c) => {
    const symbol = c.req.param('symbol').trim().toUpperCase()
    if (symbol.length === 0) {
      throw new ValidationError('symbol must be a non-empty path param', { field: 'symbol' })
    }
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }

    const body = (await c.req.json().catch(() => null)) as unknown
    const args = readOverridePositionBody(body)

    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const before = await safeGetSymbolState(client, symbol)
    const state = await client.overridePosition(symbol, {
      qty: args.qty,
      avgPrice: args.avgPrice,
      openedAt: args.openedAt,
      reason: args.reason,
      requestId: c.get('requestId'),
    })
    await writeAuditLog(
      c,
      '/admin/symbol-state/:symbol/override-position',
      `symbol=${symbol}`,
      { position: before?.position ?? null },
      { position: state.position, reason: args.reason },
    )
    return c.json({
      symbol,
      position: state.position,
      updatedAt: state.updatedAt,
    })
  })
  .post('/symbols/:symbol/seed-cash', rateLimit('ADMIN_WRITE'), async (c) => {
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
    const before = await safeGetSymbolState(client, symbol)
    const state = await client.seedSettledCash(symbol, amount)
    await writeAuditLog(
      c,
      '/admin/symbols/:symbol/seed-cash',
      `symbol=${symbol}`,
      { settledCash: before?.settledCash ?? null },
      { settledCash: state.settledCash },
    )
    return c.json({ symbol, settledCash: state.settledCash, updatedAt: state.updatedAt })
  })
  // Sets cooldownUntil to epoch (not null) since PositionStore.setCooldown requires a string;
  // strategy's `> now` check then treats it as already expired.
  .post('/symbols/:symbol/clear-cooldown', rateLimit('ADMIN_WRITE'), async (c) => {
    const symbol = c.req.param('symbol').trim().toUpperCase()
    if (symbol.length === 0) {
      throw new ValidationError('symbol must be a non-empty path param', { field: 'symbol' })
    }
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }
    const pastIso = new Date(0).toISOString()
    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const before = await safeGetSymbolState(client, symbol)
    const state = await client.setCooldown(symbol, pastIso)
    await writeAuditLog(
      c,
      '/admin/symbols/:symbol/clear-cooldown',
      `symbol=${symbol}`,
      { cooldownUntil: before?.cooldownUntil ?? null },
      { cooldownUntil: state.cooldownUntil },
    )
    return c.json({
      symbol,
      cooldownUntil: state.cooldownUntil,
      note: 'cooldown を epoch に戻したため strategy の `> now` 判定で即失効',
      updatedAt: state.updatedAt,
    })
  })
  // Manual trigger for `runStrategyCron`, for debugging skip reasons without
  // waiting for the hourly schedule. Does not bypass `global_config.dry_run`.
  .post('/strategy/run', rateLimit('ADMIN_WRITE'), async (c) => {
    const result = await runStrategyCron(c.env)
    return c.json(result)
  })
  /**
   * Flips `global_config.trading_enabled` and appends to
   * `trading_toggle_history`. Branches on Content-Type: form body from the
   * dashboard (redirects back to `/dashboard`), JSON from CLI callers.
   *
   * Body: `{ enabled: boolean, reason: string }`
   *
   * Response `effective` is the value after env override is applied, so an
   * operator writing DB `true` under `TRADING_ENABLED=false` still sees
   * `effective=false` instead of believing the toggle took effect.
   */
  .post('/trading/toggle', rateLimit('STATE_CHANGE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const contentType = c.req.header('content-type') ?? ''
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    const body = isForm
      ? Object.fromEntries((await c.req.formData()).entries())
      : ((await c.req.json().catch(() => null)) as unknown)
    const { enabled, reason } = readToggleBody(body)

    const db = createTradingToggleDb(c.env.DB)
    const actor = extractActor(c.get('actor'))
    const result = await applyTradingToggle(db, {
      enabled,
      actor,
      reason,
      requestId: c.get('requestId') ?? null,
    })
    console.log(
      JSON.stringify({
        event: 'trading_toggle_applied',
        requestId: c.get('requestId'),
        actor,
        before: result.before,
        after: result.after,
        reason,
      }),
    )
    if (isForm) {
      return c.redirect('/dashboard', 303)
    }
    const effective = resolveTradingEnabled(result.after, c.env.TRADING_ENABLED)
    return c.json({
      before: result.before,
      after: result.after,
      effective,
      envOverrideActive: effective !== result.after,
      historyId: result.historyId,
    })
  })
  /**
   * Offline backtest harness for PullbackUptrendStrategy. Feeds Yahoo
   * Finance daily bars through `runBacktest`; pure calculation, never
   * places an order.
   *
   * Query:
   *   - `symbol`         (required)  e.g. AAPL / 7203
   *   - `from`, `to`     (required)  ISO date "YYYY-MM-DD"
   *   - `initialCash`    (optional)  default 10000
   *   - `stopPct`, `takeProfitPct`, `timeStopDays`, `pullbackMax`,
   *     `pullbackMin`, `minReturn50d`, `kAtr` (optional)  override global_config
   *
   * Returns `BacktestResult` as-is, in-memory only (no D1 persistence).
   */
  .get('/backtest', async (c) => {
    const setup = await buildBacktestSetup(c)
    const params: BacktestParams = {
      symbol: setup.symbol,
      from: setup.from,
      to: setup.to,
      initialCash: setup.initialCash,
      rule: setup.rule,
      atrBaselineMode: setup.atrBaselineMode,
    }
    const result = await runBacktest(setup.sliced, params)
    return c.json(result)
  })
  /**
   * Runs multiple `EntryPolicy` x `ExitPolicy` x `ReentryPolicy` variants
   * through `runLifecycleBacktest` on the same bars/rule/cost basis as
   * `/backtest`, and returns them side by side. Never places an order.
   *
   * Query:
   *   - `symbol`, `from`, `to`, `initialCash`, rule overrides: same as `/backtest`
   *   - `variants` (optional) comma-separated, format `<entry>[+<exit>][+reentry:<spec>]`
   *     (`+<exit>` defaults to `preset`, `+reentry:<spec>` defaults to `none`):
   *       - `<entry>` = `full` | `staged:<probe>/<confirm>/<full>` (integer %, sums to 100)
   *       - `<exit>`  = `preset` | `trail:<tpFraction%>/<trailKAtr>/<extDays>`
   *         (e.g. `trail:50/2/5` = take half profit at TP, trail the rest at 2 ATR sigma,
   *         extend the time-stop 5 sessions while the trend holds)
   *       - `<reentry spec>` = `reentry:none` | `reentry:guard` | `reentry:aware:<slWaitDays>`
   *         (`guard` mirrors the live re-entry price guard; `aware:<slWaitDays>` varies by exit
   *         reason — see `evaluateReentry` in `runLifecycleBacktest.ts`)
   *     A literal `+` in the query string form-decodes to a space, so callers outside an HTML
   *     form must percent-encode it as `%2B`.
   *   - `confirmDays` (optional, default 3) confirm-streak days shared by staged variants
   *   - `feePctOfNotional`, `feeFixedPerOrder` (optional) default to global_config
   */
  .get('/backtest/compare', async (c) => {
    const setup = await buildBacktestSetup(c)
    const confirmDays = readOptionalNumber(c.req.query('confirmDays'), 'confirmDays', 3, {
      mustBePositive: true,
    })
    // Integer only: a fractional confirmDays satisfies `probeStreak >= 0.5` on day one, erasing the confirm leg.
    if (!Number.isInteger(confirmDays)) {
      throw new ValidationError("'confirmDays' must be a positive integer", { field: 'confirmDays' })
    }
    const feePctOfNotional = readOptionalNumber(
      c.req.query('feePctOfNotional'),
      'feePctOfNotional',
      setup.global.feePctOfNotional,
      {},
    )
    const feeFixedPerOrder = readOptionalNumber(
      c.req.query('feeFixedPerOrder'),
      'feeFixedPerOrder',
      setup.global.feeFixedPerOrder,
      {},
    )
    // A negative fee would make estimateOrderCost negative, booking cost as profit.
    for (const [field, v] of [
      ['feePctOfNotional', feePctOfNotional],
      ['feeFixedPerOrder', feeFixedPerOrder],
    ] as const) {
      if (v < 0) throw new ValidationError(`'${field}' must be >= 0`, { field })
    }
    const variantsQuery = c.req.query('variants')
    const specs = (
      variantsQuery && variantsQuery.trim().length > 0
        ? variantsQuery.split(',')
        : DEFAULT_COMPARE_VARIANTS
    )
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const variants = specs.map((spec) => parseVariantSpec(spec, confirmDays))

    const results = await Promise.all(
      variants.map(async (variant) => {
        const params: LifecycleBacktestParams = {
          symbol: setup.symbol,
          from: setup.from,
          to: setup.to,
          initialCash: setup.initialCash,
          rule: setup.rule,
          atrBaselineMode: setup.atrBaselineMode,
          entryPolicy: variant.entryPolicy,
          exitPolicy: variant.exitPolicy,
          reentryPolicy: variant.reentryPolicy,
          feePctOfNotional,
          feeFixedPerOrder,
        }
        const result = await runLifecycleBacktest(setup.sliced, params)
        const { trades, ...metrics } = result
        return {
          name: variant.name,
          entryPolicy: variant.entryPolicy,
          exitPolicy: variant.exitPolicy,
          reentryPolicy: variant.reentryPolicy,
          ...metrics,
          tradeCount: trades.length,
          trades: trades.slice(0, 20),
        }
      }),
    )

    return c.json({
      params: {
        symbol: setup.symbol,
        from: setup.from,
        to: setup.to,
        initialCash: setup.initialCash,
        confirmDays,
        feePctOfNotional,
        feeFixedPerOrder,
      },
      barCount: setup.sliced.length,
      variants: results,
    })
  })
  /**
   * Polls Webull for every locally-submitted order without a terminal
   * `broker_status` in trade_journal, and patches the row with
   * `filled_qty / filled_price / broker_status`. Idempotent — safe to call
   * on demand.
   *
   * `?retryStateApply=1` also sweeps `broker_status='FILLED' AND
   * state_applied_at IS NULL` rows that aged out of the cron lookback
   * window, to unstick legacy split-brain rows manually.
   */
  .post('/orders/reconcile', rateLimit('ADMIN_WRITE'), async (c) => {
    const retryStateApply = parseTruthyQuery(c.req.query('retryStateApply'))
    const summary = await reconcileFills({
      env: c.env,
      requestId: c.get('requestId'),
      retryStateApply,
    })
    return c.json(summary)
  })
  /**
   * Read-only count of `broker_status='FILLED' AND state_applied_at IS NULL`
   * rows (the split-brain backlog). A non-zero `pendingApply` is the signal
   * to invoke `POST /admin/orders/reconcile?retryStateApply=1`. Single
   * COUNT(*), safe to poll from a dashboard.
   */
  .get('/orders/repair-status', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const db = createDb(c.env.DB)
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(tradeJournal)
      .where(
        and(
          eq(tradeJournal.tradeEventType, 'post_submit'),
          eq(tradeJournal.brokerStatus, 'FILLED'),
          isNull(tradeJournal.stateAppliedAt),
        ),
      )
    const pendingApply = Number(rows[0]?.count ?? 0)
    return c.json({ pendingApply })
  })
  /**
   * Manual recovery tool: reconciles broker-side holdings into the
   * per-symbol DO `position`. Pulls Webull `/openapi/account/positions`
   * once and walks the symbol universe (or `?symbol=SOXL`), overwriting a
   * disagreeing DO row via the same `overridePosition` path as
   * `/admin/symbol-state/:symbol/override-position`. Does not rewrite rows
   * that already match.
   *
   * Query:
   *   - `symbol`  (optional)  restrict to one ticker (case-insensitive)
   *   - `dryRun`  (optional)  `1`/`true`/`yes` → diff-only, no DO writes
   *   - `force`   (optional)  `1`/`true`/`yes` → bypass the "broker empty +
   *                            DO has positions" safe-fail guard; only for a
   *                            confirmed-empty broker (e.g. liquidation)
   *                            with stale DO ghost rows to clear
   *
   * Body is ignored — POST rather than GET keeps the verb consistent with
   * the route's non-dryRun mutating behavior.
   */
  .post('/orders/sync-holdings', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }
    const symbolRaw = c.req.query('symbol')?.trim()
    const dryRun = parseTruthyQuery(c.req.query('dryRun'))
    const force = parseTruthyQuery(c.req.query('force'))
    const symbol = symbolRaw && symbolRaw.length > 0 ? symbolRaw.toUpperCase() : undefined

    // Single-symbol mode skips the universe/D1 load, so an operator can sync
    // a ticker even after it's been removed from `symbol_config`.
    let allowedSymbols: string[]
    if (symbol !== undefined) {
      allowedSymbols = [symbol]
    } else {
      if (!c.env.DB) {
        throw new ValidationError('DB binding is not configured', { field: 'env' })
      }
      const universe = await loadSymbolUniverse(c.env)
      allowedSymbols = universe.allowedSymbols
    }

    const webull = createWebullReadClient(c.env, {
      accessToken: await resolveAccessToken(c.env),
    })
    const positionStore = new SymbolStateClient(c.env.SYMBOL_STATE)
    const result = await syncHoldings(
      {
        ...(symbol !== undefined ? { symbol } : {}),
        dryRun,
        force,
        requestId: c.get('requestId') ?? null,
      },
      {
        allowedSymbols,
        fetchPositions: () => webull.getPositions(),
        positionStore,
      },
    )
    return c.json(result)
  })
  /**
   * Read-only diagnostic: directly hit Webull broker endpoints with bare fetch
   * and return the raw HTTP status / body / timing. Bypasses
   * `WebullHttpClient` / `WebullQuoteClient` so the response is **not normalized
   * by our parsers** — used to tell whether a broker-side failure is really
   * on the broker side or is our client-side handling.
   *
   * Probes (in parallel), each old-path/new-path pair kept to compare them:
   *   1. `GET /openapi/market-data/stock/snapshot` (`x-version: v2`)
   *      for `?symbol=` (default SOXL) + `?category=` (default US_ETF).
   *   2. positions (v1): `GET /openapi/account/positions`
   *   3. positions (v2): `GET /openapi/assets/positions`
   *   4. order history (v1): `GET /openapi/account/orders/history`
   *   5. order history (v2): `GET /openapi/trade/order/history`
   *
   * Each probe returns the same uniform shape regardless of phase:
   * `{ phase: 'response' | 'auth' | 'fetch', status, ok, bodyTruncated,
   *   bodyLength, msTaken, error }`, with `null` for whatever a given phase
   * didn't reach. Body truncated to 4 kB to avoid log blowup on HTML error
   * pages.
   *
   * Pre-condition: `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` /
   * `WEBULL_ACCOUNT_ID_JP_CASH` must be set (non-whitespace), else `400
   * ValidationError` — a missing var should never look like a broker
   * rejection. `WEBULL_TRADE_API_BASE` / `WEBULL_QUOTES_API_BASE` default to
   * the JP prod hosts when unset; set them explicitly to probe UAT instead.
   *
   * Read-only: no DO writes, no D1 writes.
   */
  .get('/broker/probe', async (c) => {
    const symbol = (c.req.query('symbol') ?? 'SOXL').trim().toUpperCase()
    const category = (c.req.query('category') ?? 'US_ETF').trim().toUpperCase()
    // Also probes the opposite category, so a UI ticker misclassified as ETF/STOCK still gets a usable result.
    const altCategory = category.endsWith('_ETF')
      ? category.replace(/_ETF$/, '_STOCK')
      : category.replace(/_STOCK$/, '_ETF')
    // Whitespace-only counts as unset. A silent phase:'auth' result on a missing
    // var would look like "configured but broker rejected"; reject with 400 instead.
    // Host vars fall back to the JP prod default when unset, so they're exempt from this check.
    const tradeBaseExplicit = (c.env.WEBULL_TRADE_API_BASE ?? '').trim()
    const quotesBaseExplicit = (c.env.WEBULL_QUOTES_API_BASE ?? '').trim()
    const baseUrl = tradeBaseExplicit || 'https://api.webull.co.jp'
    const quotesBaseUrl = quotesBaseExplicit || 'https://data-api.webull.co.jp'
    const appKey = (c.env.WEBULL_APP_KEY ?? '').trim()
    const appSecret = (c.env.WEBULL_APP_SECRET ?? '').trim()
    const accountId = (c.env.WEBULL_ACCOUNT_ID_JP_CASH ?? '').trim()
    const missingEnv: string[] = []
    if (appKey.length === 0) missingEnv.push('WEBULL_APP_KEY')
    if (appSecret.length === 0) missingEnv.push('WEBULL_APP_SECRET')
    if (accountId.length === 0) missingEnv.push('WEBULL_ACCOUNT_ID_JP_CASH')
    // An unparseable base URL would throw synchronously inside probeOnce's `new URL(...)` (500);
    // validate explicit-only values up front and return 400 instead (defaults are format-guaranteed).
    const validateAbsoluteHttpUrl = (value: string, varName: string): void => {
      if (value.length === 0) return
      let parsed: URL | null = null
      try {
        parsed = new URL(value)
      } catch {
        parsed = null
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        missingEnv.push(`${varName} (invalid: must be absolute http/https URL)`)
      }
    }
    validateAbsoluteHttpUrl(tradeBaseExplicit, 'WEBULL_TRADE_API_BASE')
    validateAbsoluteHttpUrl(quotesBaseExplicit, 'WEBULL_QUOTES_API_BASE')
    if (missingEnv.length > 0) {
      throw new ValidationError(
        `Webull env var(s) missing or invalid: ${missingEnv.join(', ')}`,
        { field: 'env' },
      )
    }

    // Resolves the DO/env-sourced token directly (rather than via a client factory) and
    // surfaces its source/length in the response, to distinguish "token sent but broker
    // rejected it" from "no token was ever attached".
    const tokenResolved = await resolveAccessTokenWithSource(c.env)
    const accessToken = tokenResolved.token

    // Every phase returns the same key set (null where unreached), so jq/curl consumers
    // don't have to special-case a shorter shape for the auth phase.
    interface ProbeResult {
      phase: 'response' | 'auth' | 'fetch'
      status: number | null
      ok: boolean | null
      bodyTruncated: string | null
      bodyLength: number | null
      msTaken: number | null
      error: string | null
    }

    async function probeOnce(args: {
      method: 'GET' | 'POST'
      path: string
      query: Record<string, string>
      version?: string
      /** JSON string, included in the signed request (place/preview probes). */
      body?: string
      /** Defaults to the trade host; snapshot probes pass the quotes host explicitly. */
      host?: string
    }): Promise<ProbeResult> {
      const url = new URL(args.path, `${args.host ?? baseUrl}/`)
      for (const [k, v] of Object.entries(args.query)) url.searchParams.set(k, v)

      let headers: Record<string, string>
      try {
        headers = await buildSignedHeaders({
          method: args.method,
          path: url.pathname,
          query: args.query,
          body: args.body,
          host: url.host,
          appKey,
          appSecret,
          version: args.version,
          accessToken,
        })
      } catch (e) {
        return {
          phase: 'auth',
          status: null,
          ok: null,
          bodyTruncated: null,
          bodyLength: null,
          msTaken: null,
          error: e instanceof Error ? e.message : String(e),
        }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10_000)

      const t0 = Date.now()
      try {
        const response = await fetch(url.href, {
          method: args.method,
          headers: {
            Accept: 'application/json',
            ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(args.body !== undefined ? { body: args.body } : {}),
          signal: controller.signal,
        })
        const body = await response.text()
        clearTimeout(timeoutId)
        return {
          phase: 'response',
          status: response.status,
          ok: response.ok,
          bodyTruncated: body.slice(0, 4000),
          bodyLength: body.length,
          msTaken: Date.now() - t0,
          error: null,
        }
      } catch (e) {
        clearTimeout(timeoutId)
        return {
          phase: 'fetch',
          status: null,
          ok: null,
          bodyTruncated: null,
          bodyLength: null,
          msTaken: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }

    // Returns the same uniform shape as probeOnce, but calls fetch directly since Yahoo needs no auth/signing.
    async function probeYahooSnapshot(symbolForProbe: string): Promise<ProbeResult> {
      // Delegates JP-suffix detection to toYahooSymbol so this can't drift from YahooBarClient/YahooQuoteClient.
      const yahooSymbol = toYahooSymbol(symbolForProbe)
      const url = new URL(
        `/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
        'https://query1.finance.yahoo.com',
      )
      url.searchParams.set('interval', '1m')
      url.searchParams.set('range', '1d')

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10_000)
      const t0 = Date.now()
      try {
        const response = await fetch(url.href, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            // Yahoo 429s anonymous requests without a browser-like UA.
            'User-Agent': 'Mozilla/5.0',
          },
          signal: controller.signal,
        })
        const body = await response.text()
        clearTimeout(timeoutId)
        return {
          phase: 'response',
          status: response.status,
          ok: response.ok,
          bodyTruncated: body.slice(0, 4000),
          bodyLength: body.length,
          msTaken: Date.now() - t0,
          error: null,
        }
      } catch (e) {
        clearTimeout(timeoutId)
        return {
          phase: 'fetch',
          status: null,
          ok: null,
          bodyTruncated: null,
          bodyLength: null,
          msTaken: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }

    // Old (v1) and new (v2) paths run in parallel for drift comparison. The dashboard UI
    // still renders from the old `positions` result, so that field name stays put; the
    // new-path results are additive.
    const [
      quoteResult,
      quoteYahooResult,
      positionsOld,
      positionsNew,
      orderHistoryOld,
      orderHistoryNew,
      balanceAccountV1,
      balanceAssetsV2,
      balanceAssetsAccountV2,
      instrumentStockTrade,
      instrumentStockTradeAlt,
      instrumentStockQuotes,
      instrumentStockQuotesAlt,
      instrumentQuotesHost,
      instrumentTradeHost,
      snapshotTradeV2,
      instrumentStockTradeV2,
    ] = await Promise.all([
      // Path matches WebullQuoteClient.DEFAULT_QUOTE_PATH; v2 is an x-version header, not a path change.
      probeOnce({
        method: 'GET',
        path: '/openapi/market-data/stock/snapshot',
        query: {
          symbols: symbol,
          category,
          extend_hour_required: 'false',
          overnight_required: 'false',
        },
        version: 'v2',
        // JP production splits trade/quotes across hosts; UAT (ALB) points both at the same URL, so this is a no-op there.
        host: quotesBaseUrl,
      }),
      // Yahoo as the quote backup source: it's also the strategy cron's current default path
      // until Webull JP market-data is live. No auth/signing needed, so this skips probeOnce.
      probeYahooSnapshot(symbol),
      probeOnce({
        method: 'GET',
        path: '/openapi/account/positions',
        query: { account_id: accountId },
        version: 'v1',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/assets/positions',
        query: { account_id: accountId },
        version: 'v2',
      }),
      // page_size accepts only 10-100 broker-side; 5 returns 417 OAUTH_OPENAPI_PARAM_ERR.
      probeOnce({
        method: 'GET',
        path: '/openapi/account/orders/history',
        query: { account_id: accountId, page_size: '10' },
        version: 'v1',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/trade/order/history',
        query: { account_id: accountId, page_size: '10' },
        version: 'v2',
      }),
      // Account Balance endpoint candidates: positions already drifted from account/*(v1) to
      // assets/*(v2), so these run in parallel to find which one returns 200 with a buying-power field.
      probeOnce({
        method: 'GET',
        path: '/openapi/account/balance',
        query: { account_id: accountId },
        version: 'v1',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/assets/balance',
        query: { account_id: accountId },
        version: 'v2',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/assets/account-balance',
        query: { account_id: accountId },
        version: 'v2',
      }),
      // Instrument lookup (is this symbol registered with Webull). JP's correct path is
      // `/openapi/instrument/stock/list` (JP docs, not the generic SDK's `/instrument/list`,
      // and HK-only `/trade/security` doesn't exist in JP). Host isn't documented, so both are
      // probed, each with both categories in case the caller misclassified ETF/STOCK.
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/stock/list',
        query: { symbols: symbol, category },
        version: 'v1',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/stock/list',
        query: { symbols: symbol, category: altCategory },
        version: 'v1',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/stock/list',
        query: { symbols: symbol, category },
        version: 'v1',
        host: quotesBaseUrl,
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/stock/list',
        query: { symbols: symbol, category: altCategory },
        version: 'v1',
        host: quotesBaseUrl,
      }),
      // Generic SDK path kept for comparison, in case JP eventually adopts it once data-api is live.
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/list',
        query: { symbols: symbol, category },
        version: 'v1',
        host: quotesBaseUrl,
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/list',
        query: { symbols: symbol, category },
        version: 'v1',
      }),
      // Market Data API's production host is the trade host (api.webull.co.jp) at x-version v2,
      // not the separate data-api host assumed by the other probes above — validated here.
      probeOnce({
        method: 'GET',
        path: '/openapi/market-data/stock/snapshot',
        query: {
          symbols: symbol,
          category,
          extend_hour_required: 'false',
          overnight_required: 'false',
        },
        version: 'v2',
      }),
      probeOnce({
        method: 'GET',
        path: '/openapi/instrument/stock/list',
        query: { symbols: symbol, category },
        version: 'v2',
      }),
    ])

    // POST /openapi/account/orders/preview is the only documented API that exercises the
    // order pipeline (including a TICKER_IS_DENY check) without creating an order, so it's
    // gated behind an explicit `?preview=1` rather than run on every probe call.
    let previewVariants: Array<{ label: string; result: ProbeResult }> | null = null
    if (c.req.query('preview') === '1') {
      const priceRaw = Number(c.req.query('price'))
      const previewPrice = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : 100
      if (!/^(US|JP)_(STOCK|ETF)$/.test(category)) {
        throw new ValidationError(`unsupported category for preview: ${category}`, {
          field: 'category',
        })
      }
      const market = (category.startsWith('JP_') ? 'JP' : 'US') as 'US' | 'JP'
      const variants = buildPreviewOrderVariants(symbol, market, previewPrice, accountId)
      const results = await Promise.all(
        variants.map((v) =>
          probeOnce({
            method: 'POST',
            path: '/openapi/account/orders/preview',
            query: { account_id: accountId },
            version: 'v1',
            body: JSON.stringify(v.body),
          }),
        ),
      )
      previewVariants = variants.map((v, i) => ({ label: v.label, result: results[i]! }))
    }

    // Per-symbol tradability probe (`?tradecheck=1`): checks whether a per-symbol lookup
    // (/trade/instrument, /trade/security) returns tradePolicy directly, as a read-only
    // alternative to sweeping the whole tradable/list.
    let tradeInstrumentProbe:
      | { instrumentId: string | null; variants: Array<{ label: string; result: ProbeResult }> }
      | null = null
    if (c.req.query('tradecheck') === '1') {
      let instrumentId: string | null = null
      if (
        instrumentStockTradeV2.phase === 'response' &&
        instrumentStockTradeV2.status === 200 &&
        instrumentStockTradeV2.bodyTruncated
      ) {
        try {
          const arr = JSON.parse(instrumentStockTradeV2.bodyTruncated)
          const row = Array.isArray(arr)
            ? arr.find((x: { symbol?: string }) => x?.symbol === symbol)
            : null
          const idRaw = (row as { instrument_id?: unknown } | null)?.instrument_id
          if (idRaw != null) instrumentId = String(idRaw).replace(/\..*$/, '')
        } catch {
          // Leaves instrumentId null; the instrumentId-dependent variants below are skipped, not failed.
        }
      }
      const market = category.startsWith('JP_') ? 'JP' : 'US'
      const variants: Array<{ label: string; result: ProbeResult }> = []
      for (const v of ['v2', 'v1']) {
        if (instrumentId) {
          variants.push({
            label: `trade/instrument [${v}]`,
            result: await probeOnce({
              method: 'GET',
              path: '/openapi/trade/instrument',
              query: { account_id: accountId, instrument_id: instrumentId },
              version: v,
            }),
          })
          variants.push({
            label: `trade/instrument no-prefix [${v}]`,
            result: await probeOnce({
              method: 'GET',
              path: '/trade/instrument',
              query: { account_id: accountId, instrument_id: instrumentId },
              version: v,
            }),
          })
        }
        variants.push({
          label: `trade/security [${v}]`,
          result: await probeOnce({
            method: 'GET',
            path: '/openapi/trade/security',
            query: { account_id: accountId, symbol, market, instrument_super_type: 'EQUITY' },
            version: v,
          }),
        })
        variants.push({
          label: `trade/security no-prefix [${v}]`,
          result: await probeOnce({
            method: 'GET',
            path: '/trade/security',
            query: { account_id: accountId, symbol, market, instrument_super_type: 'EQUITY' },
            version: v,
          }),
        })
      }
      tradeInstrumentProbe = { instrumentId, variants }
    }

    // Diagnostic payload includes raw broker responses, so it must not linger in browser/intermediary caches.
    c.header('Cache-Control', 'no-store')
    return c.json({
      timestamp: new Date().toISOString(),
      sandbox: { trade: baseUrl, quotes: quotesBaseUrl },
      input: { symbol, category, accountIdConfigured: accountId.length > 0 },
      // `source: 'do_normal'` is the healthy path; `'env'` is the Phase A fallback; `'none'`
      // means the broker will return INVALID_TOKEN. Only length is exposed, never the token itself.
      accessToken: {
        source: tokenResolved.source,
        length: accessToken?.length ?? 0,
        doStatus: tokenResolved.doStatus ?? null,
      },
      // First 6 hex chars, safe to expose, let an operator confirm staging/production's
      // WEBULL_APP_KEY matches their local value without seeing the full secret.
      appKey: {
        length: appKey.length,
        head: appKey.slice(0, 6),
      },
      quote: quoteResult,
      positions: positionsOld,
      positionsNew,
      orderHistoryOld,
      orderHistoryNew,
      balanceAccountV1,
      balanceAssetsV2,
      balanceAssetsAccountV2,
      quoteYahoo: quoteYahooResult,
      instrumentStockTrade,
      instrumentStockTradeAlt,
      instrumentStockQuotes,
      instrumentStockQuotesAlt,
      instrumentQuotesHost,
      instrumentTradeHost,
      snapshotTradeV2,
      instrumentStockTradeV2,
      previewVariants,
      tradeInstrumentProbe,
      readiness: {
        tokenOk: tokenResolved.source === 'do_normal',
        tradeEndpointsOk:
          positionsOld.phase === 'response' &&
          positionsOld.status === 200 &&
          orderHistoryOld.phase === 'response' &&
          orderHistoryOld.status === 200,
        newTradeEndpointsOk:
          positionsNew.phase === 'response' &&
          positionsNew.status === 200 &&
          orderHistoryNew.phase === 'response' &&
          orderHistoryNew.status === 200,
        yahooQuoteOk: quoteYahooResult.phase === 'response' && quoteYahooResult.status === 200,
      },
    })
  })
  // Lightweight buying-power JSON for client-side dashboard fetches. A missing token or
  // broker error fails safe to `status:'unavailable'` rather than breaking page render;
  // per-currency buying_power is returned as-is, with no FX conversion.
  .get('/buying-power', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const accessToken = await resolveAccessToken(c.env)
      const balance = await createWebullReadClient(c.env, { accessToken }).getAccountBalance()
      const assets = Array.isArray(balance.account_currency_assets) ? balance.account_currency_assets : []
      const byCurrency = assets.map((a) => ({
        currency: (a.currency ?? '?').toUpperCase(),
        buyingPower: Number(a.buying_power),
        cash: Number(a.cash_balance),
      }))
      return c.json({
        status: 'ok' as const,
        asOf: new Date().toISOString(),
        baseCurrency: balance.total_asset_currency ?? null,
        totalCash: Number(balance.total_cash_balance),
        byCurrency,
      })
    } catch (e) {
      return c.json({
        status: 'unavailable' as const,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  })
  /**
   * `WebullTokenStateDO` operator endpoints:
   * - GET /webull-token         current state metadata (never the token plaintext)
   * - POST /webull-token/seed   install a NORMAL token from `pnpm run issue-token`
   * - POST /webull-token/refresh manual refresh, without waiting for cron
   */
  .get('/webull-token', async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      throw new ValidationError('WEBULL_TOKEN_STATE binding is not configured', { field: 'env' })
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    const state = await store.getState()
    // Never returns the token plaintext (audit log / cache / screenshot exposure); a
    // head/tail hint is enough for an operator to identify which token is active.
    c.header('Cache-Control', 'no-store')
    if (!state) {
      return c.json({ seeded: false, state: null })
    }
    const tokenHint = state.token.length > 10
      ? `${state.token.slice(0, 6)}...${state.token.slice(-4)}`
      : '<redacted>'
    return c.json({
      seeded: true,
      state: {
        tokenHint,
        expires: state.expires,
        status: state.status,
        fetchedAt: state.fetchedAt,
        lastAttemptAt: state.lastAttemptAt,
        lastSuccessAt: state.lastSuccessAt,
      },
    })
  })
  .post('/webull-token/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      throw new ValidationError('WEBULL_TOKEN_STATE binding is not configured', { field: 'env' })
    }
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null
    const rawToken = typeof body?.token === 'string' ? body.token.trim() : ''
    if (rawToken.length === 0) {
      throw new ValidationError('body.token must be a non-empty string', { field: 'token' })
    }
    if (!c.env.WEBULL_APP_KEY || !c.env.WEBULL_APP_SECRET) {
      throw new ValidationError(
        'WEBULL_APP_KEY / WEBULL_APP_SECRET must be set to verify the seeded token',
        { field: 'env' },
      )
    }
    // Re-verifies NORMAL status with the broker before storing, closing the
    // time-of-check/time-of-use gap since the token was issued.
    const tokenClient = new WebullTokenClient({
      auth: new WebullAuth({
        appKey: c.env.WEBULL_APP_KEY,
        appSecret: c.env.WEBULL_APP_SECRET,
      }),
      baseUrl: c.env.WEBULL_TRADE_API_BASE?.trim() || 'https://api.webull.co.jp',
    })
    const dto = await tokenClient.checkToken(rawToken)
    if (dto.status !== 'NORMAL') {
      return c.json(
        { error: 'token_not_normal', status: dto.status },
        409,
      )
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    const before = await store.getState()
    const seeded = await store.seedToken({
      token: dto.token,
      expires: dto.expires,
      status: dto.status,
    })
    await writeAuditLog(
      c,
      '/admin/webull-token/seed',
      'webull-token=singleton',
      before
        ? {
            status: before.status,
            expires: before.expires,
            fetchedAt: before.fetchedAt,
          }
        : null,
      {
        status: seeded.status,
        expires: seeded.expires,
        fetchedAt: seeded.fetchedAt,
      },
    )
    return c.json({
      seeded: true,
      state: {
        expires: seeded.expires,
        status: seeded.status,
        fetchedAt: seeded.fetchedAt,
      },
    })
  })
  .post('/webull-token/refresh', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      throw new ValidationError('WEBULL_TOKEN_STATE binding is not configured', { field: 'env' })
    }
    // force=true bypasses the "still has time before expiry" skip.
    const summary = await refreshWebullToken(c.env, { force: true })
    await writeAuditLog(
      c,
      '/admin/webull-token/refresh',
      'webull-token=singleton',
      summary.before
        ? {
            status: summary.before.status,
            expires: summary.before.expires,
            fetchedAt: summary.before.fetchedAt,
          }
        : null,
      summary.after
        ? {
            status: summary.after.status,
            expires: summary.after.expires,
            fetchedAt: summary.after.fetchedAt,
            refreshed: summary.refreshed,
            skippedReason: summary.skippedReason ?? null,
            failureReason: summary.failureReason ?? null,
          }
        : { refreshed: summary.refreshed, skippedReason: summary.skippedReason ?? null },
    )
    return c.json({
      refreshed: summary.refreshed,
      skippedReason: summary.skippedReason ?? null,
      failureReason: summary.failureReason ?? null,
      after: summary.after
        ? {
            expires: summary.after.expires,
            status: summary.after.status,
            fetchedAt: summary.after.fetchedAt,
            lastAttemptAt: summary.after.lastAttemptAt,
            lastSuccessAt: summary.after.lastSuccessAt,
          }
        : null,
    })
  })
  /**
   * Manual, chunked refresh of the tradable-symbol allowlist: a full sweep
   * (~50 pages) doesn't fit one request's execution budget, so each call
   * processes at most ~15 pages and returns progress. While `done=false`,
   * the UI resumes by POSTing the returned `nextCursor` and `watermark`
   * until done. The server mints `watermark` on the first call (no cursor)
   * as the mark-and-sweep basis for the whole run; the client echoes it back.
   */
  .post('/tradable-allowlist/refresh', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const cursorRaw = (c.req.query('cursor') ?? '').trim()
    const watermarkRaw = (c.req.query('watermark') ?? '').trim()
    const watermark = watermarkRaw.length > 0 ? watermarkRaw : new Date().toISOString()
    const summary = await refreshTradableAllowlist(c.env, watermark, {
      ...(cursorRaw.length > 0 ? { startCursor: cursorRaw } : {}),
      maxPages: 15,
    })
    console.log(JSON.stringify({ event: 'tradable_allowlist_refresh_manual', ...summary }))
    if (summary.done) {
      await writeAuditLog(c, '/admin/tradable-allowlist/refresh', 'tradable-allowlist', null, {
        ok: summary.ok,
        upserted: summary.upserted,
        disappeared: summary.disappeared,
        disappearedSymbols: summary.disappearedSymbols,
        error: summary.error ?? null,
      }).catch(() => undefined)
    }
    const status = await getTradableAllowlistStatus(createDb(c.env.DB)).catch(() => null)
    return c.json({ ...summary, watermark, total: status?.total ?? null })
  })
  // Current allowlist summary for UI polling: row count and last-fetched time.
  .get('/tradable-allowlist/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const status = await getTradableAllowlistStatus(createDb(c.env.DB))
    return c.json(status)
  })
  /**
   * Looks up the Webull-side status of an order by client_order_id. The JP
   * UAT tenant 404s on `/openapi/account/orders/detail`, so this instead
   * fetches the first page of `/openapi/account/orders/history` and filters
   * client-side; an order outside that page returns
   * `order_not_found_in_recent_history`.
   */
  .get('/orders/:clientOrderId', async (c) => {
    const clientOrderId = c.req.param('clientOrderId').trim()
    if (clientOrderId.length === 0) {
      throw new ValidationError('clientOrderId must be non-empty', { field: 'clientOrderId' })
    }
    // `maxPages` is capped at 20 (20 * 50 = 1000 rows) so a typo or abuse can't fan out into a huge broker batch.
    const maxPages = parsePositiveIntQuery(c.req.query('maxPages'), { max: 20 })
    // Webull /openapi/account/orders/history accepts page_size 10–100 only.
    const pageSize = parsePositiveIntQuery(c.req.query('pageSize'), { max: 100 })
    const client = createWebullReadClient(c.env, {
      accessToken: await resolveAccessToken(c.env),
    })
    const detail = await client.findOrderByClientId(clientOrderId, {
      ...(maxPages !== undefined ? { maxPages } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    })
    if (!detail) {
      return c.json(
        {
          error: 'order_not_found_in_recent_history',
          clientOrderId,
          maxPagesScanned: maxPages ?? 1,
        },
        404,
      )
    }
    return c.json(detail)
  })
  /**
   * EOD-ish rollover: snapshot `dailyStartEquity + dailyRealizedPnl` as the
   * new day's opening equity and zero out `dailyRealizedPnl`. Intended as a
   * manual / cron-triggered "close the day" step so the drawdown-kill gate
   * re-anchors against today's session rather than cumulative lifetime PnL.
   *
   * Returns both the before / after snapshot so an operator (or the eventual
   * EOD cron) can log the exact dollar delta that was rolled.
   */
  .post('/portfolio/roll-daily', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      throw new ValidationError('PORTFOLIO_STATE binding is not configured', { field: 'env' })
    }
    const client = new PortfolioStateClient(c.env.PORTFOLIO_STATE)
    const { before, after } = await client.rollDaily()
    await writeAuditLog(
      c,
      '/admin/portfolio/roll-daily',
      'portfolio=daily',
      {
        dailyStartEquity: before.dailyStartEquity,
        dailyRealizedPnl: before.dailyRealizedPnl,
      },
      {
        dailyStartEquity: after.dailyStartEquity,
        dailyRealizedPnl: after.dailyRealizedPnl,
      },
    )
    // PortfolioStateDO holds one currency-agnostic value (USD by convention), so this writes
    // the USD column only and leaves JPY null until per-currency split exists. A write failure
    // here doesn't fail the handler — the DO state change above already succeeded.
    if (c.env.DB) {
      const drawdownPct =
        before.dailyStartEquity > 0
          ? before.dailyRealizedPnl / before.dailyStartEquity
          : null
      try {
        await recordPortfolioEquitySnapshot(c.env.DB, {
          snapshotAt: after.updatedAt,
          dailyStartEquityUsd: before.dailyStartEquity,
          dailyStartEquityJpy: null,
          dailyRealizedPnlUsd: before.dailyRealizedPnl,
          dailyRealizedPnlJpy: null,
          drawdownPct,
          requestId: c.get('requestId') ?? null,
        })
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'portfolio_equity_snapshot_write_failed',
            endpoint: '/admin/portfolio/roll-daily',
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    return c.json({
      rolledAt: after.updatedAt,
      rolledDelta: before.dailyRealizedPnl,
      lastRolledAt: after.lastRolledAt,
      before: {
        dailyStartEquity: before.dailyStartEquity,
        dailyRealizedPnl: before.dailyRealizedPnl,
      },
      after: {
        dailyStartEquity: after.dailyStartEquity,
        dailyRealizedPnl: after.dailyRealizedPnl,
      },
    })
  })
  .post('/portfolio/seed-equity', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      throw new ValidationError('PORTFOLIO_STATE binding is not configured', { field: 'env' })
    }

    const body = (await c.req.json().catch(() => null)) as unknown
    const amount = readAmount(body)

    const client = new PortfolioStateClient(c.env.PORTFOLIO_STATE)
    const before = await safeGetPortfolioState(client)
    const state = await client.seedDailyStartEquity(amount)
    await writeAuditLog(
      c,
      '/admin/portfolio/seed-equity',
      'portfolio=daily',
      { dailyStartEquity: before?.dailyStartEquity ?? null },
      { dailyStartEquity: state.dailyStartEquity },
    )
    return c.json({
      dailyStartEquity: state.dailyStartEquity,
      dailyRealizedPnl: state.dailyRealizedPnl,
      tradingDisabledUntil: state.tradingDisabledUntil,
      lastRolledAt: state.lastRolledAt,
      updatedAt: state.updatedAt,
    })
  })
  /**
   * Bulk seed `earnings_calendar` rows; there's no external API integration,
   * so an operator seeds manually via curl. Duplicates (symbol x
   * earnings_date) are skipped via `INSERT OR IGNORE`.
   *
   * Body: `[{ symbol: "AAPL", earnings_date: "2026-04-30", notes?: "Q2" }, ...]`
   */
  .post('/earnings/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const body = (await c.req.json().catch(() => null)) as unknown
    if (!Array.isArray(body)) {
      throw new ValidationError('body must be an array of { symbol, earnings_date, notes? }', { field: 'body' })
    }
    if (body.length === 0) {
      throw new ValidationError('body must contain at least one entry', { field: 'body' })
    }
    if (body.length > 1000) {
      throw new ValidationError('body cannot exceed 1000 entries per request', { field: 'body' })
    }
    const records: EarningsCalendarSeedInput[] = []
    body.forEach((raw, idx) => {
      records.push(parseEarningsSeedRow(raw, idx))
    })
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const result = await repo.bulkUpsert(records)
    if (result.inserted > 0) {
      await writeAuditLog(
        c,
        '/admin/earnings/seed',
        `inserted=${result.inserted}`,
        null,
        { inserted: result.inserted, skipped: result.skipped, records },
      )
    }
    return c.json({ inserted: result.inserted, skipped: result.skipped, total: records.length })
  })
  // `?symbol=AAPL` required; returns 200 with an empty array when there are no rows.
  .get('/earnings', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbol = readRequiredParam(c.req.query('symbol'), 'symbol').toUpperCase()
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const rows = await repo.fetchBySymbol(symbol)
    return c.json({ symbol, rows })
  })
  .delete('/earnings/:id', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const idRaw = c.req.param('id').trim()
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError("'id' must be a positive integer path param", { field: 'id' })
    }
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const beforeRow = await createDb(c.env.DB)
      .select()
      .from(earningsCalendar)
      .where(eq(earningsCalendar.id, id))
      .then((rows) => rows[0] ?? null)
      .catch(() => null)
    const ok = await repo.deleteById(id)
    if (!ok) {
      return c.json({ error: 'earnings_row_not_found', id }, 404)
    }
    await writeAuditLog(c, '/admin/earnings/:id', `earnings_id=${id}`, beforeRow, null)
    return c.json({ deleted: true, id })
  })
  /**
   * Bulk seed `macro_event_calendar` rows; operator-seeded via curl, no
   * external API integration. Duplicates (event_type x event_date) are
   * skipped via `INSERT OR IGNORE`.
   *
   * Body: `[{ event_type: "FOMC", event_date: "2026-06-17",
   *           event_time?: "14:00", notes?: "June FOMC" }, ...]`
   */
  .post('/macro-events/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const body = (await c.req.json().catch(() => null)) as unknown
    if (!Array.isArray(body)) {
      throw new ValidationError(
        'body must be an array of { event_type, event_date, event_time?, notes? }',
        { field: 'body' },
      )
    }
    if (body.length === 0) {
      throw new ValidationError('body must contain at least one entry', { field: 'body' })
    }
    if (body.length > 1000) {
      throw new ValidationError('body cannot exceed 1000 entries per request', { field: 'body' })
    }
    const records: MacroEventCalendarSeedInput[] = []
    body.forEach((raw, idx) => {
      records.push(parseMacroEventSeedRow(raw, idx))
    })
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const result = await repo.bulkUpsert(records)
    if (result.inserted > 0) {
      await writeAuditLog(
        c,
        '/admin/macro-events/seed',
        `inserted=${result.inserted}`,
        null,
        { inserted: result.inserted, skipped: result.skipped, records },
      )
    }
    return c.json({ inserted: result.inserted, skipped: result.skipped, total: records.length })
  })
  // `?from`/`?to` (both optional, YYYY-MM-DD) and `?type` (event_type, upper-cased) filter the rows.
  .get('/macro-events', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const fromRaw = c.req.query('from')?.trim()
    const toRaw = c.req.query('to')?.trim()
    const typeRaw = c.req.query('type')?.trim()
    if (fromRaw !== undefined && fromRaw !== '' && !isYmd(fromRaw)) {
      throw new ValidationError("'from' must be ISO 'YYYY-MM-DD'", { field: 'from' })
    }
    if (toRaw !== undefined && toRaw !== '' && !isYmd(toRaw)) {
      throw new ValidationError("'to' must be ISO 'YYYY-MM-DD'", { field: 'to' })
    }
    if (
      fromRaw !== undefined &&
      fromRaw !== '' &&
      toRaw !== undefined &&
      toRaw !== '' &&
      fromRaw > toRaw
    ) {
      // Rejected explicitly rather than returning an empty-array 200, which would be
      // indistinguishable from "no data in range".
      throw new ValidationError("'from' must be <= 'to'", { field: 'from' })
    }
    if (typeRaw !== undefined && typeRaw !== '' && !isMacroEventType(typeRaw)) {
      throw new ValidationError("'type' must be 1-32 chars [A-Z0-9_]", { field: 'type' })
    }
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const rows = await repo.fetchAll({
      ...(fromRaw && fromRaw !== '' ? { fromYmd: fromRaw } : {}),
      ...(toRaw && toRaw !== '' ? { toYmd: toRaw } : {}),
      ...(typeRaw && typeRaw !== '' ? { eventType: typeRaw.toUpperCase() } : {}),
    })
    return c.json({
      filter: {
        from: fromRaw ?? null,
        to: toRaw ?? null,
        type: typeRaw ? typeRaw.toUpperCase() : null,
      },
      rows,
    })
  })
  .delete('/macro-events/:id', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const idRaw = c.req.param('id').trim()
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError("'id' must be a positive integer path param", { field: 'id' })
    }
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const beforeRow = await createDb(c.env.DB)
      .select()
      .from(macroEventCalendar)
      .where(eq(macroEventCalendar.id, id))
      .then((rows) => rows[0] ?? null)
      .catch(() => null)
    const ok = await repo.deleteById(id)
    if (!ok) {
      return c.json({ error: 'macro_event_row_not_found', id }, 404)
    }
    await writeAuditLog(c, '/admin/macro-events/:id', `macro_event_id=${id}`, beforeRow, null)
    return c.json({ deleted: true, id })
  })
  /**
   * `symbol_config` CRUD, driven by dashboard form POSTs
   * (application/x-www-form-urlencoded, redirecting 303 back to
   * `/dashboard/symbols` on success — PRG) or an equivalent JSON body
   * (returns 200 JSON instead). All routes go through
   * `rateLimit('ADMIN_WRITE')` + `writeAuditLog`.
   *
   * `/admin/symbol-config`                       INSERT (409 on duplicate symbol)
   * `/admin/symbol-config/:symbol/update`         full-row UPDATE
   * `/admin/symbol-config/:symbol/toggle-active`  flips `active`
   * `/admin/symbol-config/:symbol/delete`         hard DELETE; requires the
   *                                                row already inactive
   *                                                (toggle-active first)
   */
  .post('/symbol-config', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const isForm = isFormContentType(c.req.header('content-type'))
    const body = await readFormOrJsonBody(c)
    const input = parseSymbolConfigBody(body)
    const db = createDb(c.env.DB)
    const now = new Date().toISOString()

    // A supplied inverse_symbol registers the bull/bear pair together.
    const inverseSymbol = parseInverseSymbolField(body)
    if (inverseSymbol !== null) {
      if (inverseSymbol === input.symbol) {
        if (isForm) {
          return c.redirect(
            `/dashboard/symbols?error=inverse_self&symbol=${encodeURIComponent(input.symbol)}`,
            303,
          )
        }
        return c.json({ error: 'inverse_self', symbol: input.symbol }, 400)
      }
      const pair = await createSymbolPair(db, input, inverseSymbol, now, parseCounterpartMeta(body))
      if (pair.primary === 'duplicate') {
        if (isForm) {
          return c.redirect(
            `/dashboard/symbols?error=duplicate&symbol=${encodeURIComponent(input.symbol)}`,
            303,
          )
        }
        return c.json({ error: 'symbol_already_exists', symbol: input.symbol }, 409)
      }
      const primaryRow = await findSymbolConfig(db, input.symbol)
      await writeAuditLog(
        c,
        '/admin/symbol-config',
        `symbol=${input.symbol} inverse=${inverseSymbol} counterpartCreated=${pair.counterpartCreated}`,
        null,
        primaryRow ? symbolConfigSnapshot(primaryRow) : { symbol: input.symbol, inverse: inverseSymbol },
      )
      if (isForm) return c.redirect('/dashboard/symbols', 303)
      return c.json({
        symbol: input.symbol,
        inverse: inverseSymbol,
        counterpartCreated: pair.counterpartCreated,
        row: primaryRow ? symbolConfigSnapshot(primaryRow) : null,
      })
    }

    const inserted = await insertSymbolConfig(db, input, now)
    if (inserted === null) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=duplicate&symbol=${encodeURIComponent(input.symbol)}`,
          303,
        )
      }
      return c.json({ error: 'symbol_already_exists', symbol: input.symbol }, 409)
    }
    await writeAuditLog(
      c,
      '/admin/symbol-config',
      `symbol=${input.symbol}`,
      null,
      symbolConfigSnapshot(inserted),
    )
    if (isForm) return c.redirect('/dashboard/symbols', 303)
    return c.json({ symbol: inserted.symbol, row: symbolConfigSnapshot(inserted) })
  })
  .post('/symbol-config/:symbol/update', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbolPath = normalizeSymbolPathParam(c.req.param('symbol'))
    const isForm = isFormContentType(c.req.header('content-type'))
    const body = await readFormOrJsonBody(c)
    // The path param wins over any `symbol` in the body — the path is the source of truth.
    const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const input: SymbolConfigWriteInput = {
      ...parseSymbolConfigBody({ ...bodyObj, symbol: symbolPath }),
      symbol: symbolPath,
    }
    const db = createDb(c.env.DB)
    const before = await findSymbolConfig(db, symbolPath)
    if (before === null) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=not_found&symbol=${encodeURIComponent(symbolPath)}`,
          303,
        )
      }
      return c.json({ error: 'symbol_not_found', symbol: symbolPath }, 404)
    }
    const after = await updateSymbolConfig(db, input, new Date().toISOString())
    if (after === null) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=not_found&symbol=${encodeURIComponent(symbolPath)}`,
          303,
        )
      }
      return c.json({ error: 'symbol_not_found', symbol: symbolPath }, 404)
    }
    await writeAuditLog(
      c,
      '/admin/symbol-config/:symbol/update',
      `symbol=${symbolPath}`,
      symbolConfigSnapshot(before),
      symbolConfigSnapshot(after),
    )
    if (isForm) return c.redirect('/dashboard/symbols', 303)
    return c.json({ symbol: after.symbol, row: symbolConfigSnapshot(after) })
  })
  .post('/symbol-config/:symbol/toggle-active', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbolPath = normalizeSymbolPathParam(c.req.param('symbol'))
    const isForm = isFormContentType(c.req.header('content-type'))
    const db = createDb(c.env.DB)
    const result = await toggleSymbolActive(db, symbolPath, new Date().toISOString())
    if (result === null) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=not_found&symbol=${encodeURIComponent(symbolPath)}`,
          303,
        )
      }
      return c.json({ error: 'symbol_not_found', symbol: symbolPath }, 404)
    }
    await writeAuditLog(
      c,
      '/admin/symbol-config/:symbol/toggle-active',
      `symbol=${symbolPath}`,
      { active: result.before.active },
      { active: result.after.active },
    )
    if (isForm) return c.redirect('/dashboard/symbols', 303)
    return c.json({ symbol: symbolPath, row: symbolConfigSnapshot(result.after) })
  })
  .post('/symbol-config/:symbol/delete', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbolPath = normalizeSymbolPathParam(c.req.param('symbol'))
    const isForm = isFormContentType(c.req.header('content-type'))
    const db = createDb(c.env.DB)
    const result = await hardDeleteSymbol(db, symbolPath)
    if (result === null) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=not_found&symbol=${encodeURIComponent(symbolPath)}`,
          303,
        )
      }
      return c.json({ error: 'symbol_not_found', symbol: symbolPath }, 404)
    }
    if ('rejected' in result) {
      if (isForm) {
        return c.redirect(
          `/dashboard/symbols?error=still_active&symbol=${encodeURIComponent(symbolPath)}`,
          303,
        )
      }
      return c.json({ error: 'still_active', symbol: symbolPath }, 400)
    }
    // Cascades the inverse_pairs link too, so no half-pair is left behind (the counterpart's symbol_config row stays).
    await deleteInversePairsForSymbol(db, symbolPath)
    await writeAuditLog(
      c,
      '/admin/symbol-config/:symbol/delete',
      `symbol=${symbolPath} (inverse links cascaded)`,
      symbolConfigSnapshot(result.before),
      null,
    )
    if (isForm) return c.redirect('/dashboard/symbols', 303)
    return c.json({ symbol: symbolPath, deleted: true })
  })
  /**
   * Feeds the current config (plus any draft override) and the latest
   * indicators/DO holdings through the same pure functions the cron uses
   * (`computeConditionalAllocation` / `buildCashRebalancePlan`), to preview
   * how allocation would flow on the next cron run. Read-only: it never
   * builds an execution, so it works even with `trading_enabled` off.
   *
   * body (optional): { pcts?: Record<sym, number|null (%)>, fallbacks?: Record<sym, string|null> }
   * to try a draft edit before applying it. Setting a fallback implies `entry_required` ON.
   */
  .post('/allocation/simulate', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const bodyRaw = (await c.req.json().catch(() => ({}))) as unknown
    const body =
      bodyRaw !== null && typeof bodyRaw === 'object' && !Array.isArray(bodyRaw)
        ? (bodyRaw as { pcts?: Record<string, unknown>; fallbacks?: Record<string, unknown> })
        : {}
    const universe = await loadSymbolUniverse(c.env)
    const global = await loadGlobalConfigFrom(c.env, c.get('requestId'))
    const notes: string[] = []

    const targetWeights: Record<string, number> = { ...universe.symbolBudgetAllocPct }
    for (const [symRaw, v] of Object.entries(body.pcts ?? {})) {
      const sym = normalizeSymbol(symRaw)
      if (v === null) {
        delete targetWeights[sym]
        continue
      }
      const pct = Number(v)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new ValidationError(`pcts.${sym} must be 0..100 or null`, { field: 'pcts' })
      }
      if (pct <= 0) delete targetWeights[sym]
      else targetWeights[sym] = pct / 100
    }
    const cashFallback: Record<string, string[]> = { ...universe.symbolCashFallback }
    const entryRequired = new Set(Object.keys(universe.symbolEntryRequired))
    for (const [symRaw, v] of Object.entries(body.fallbacks ?? {})) {
      const sym = normalizeSymbol(symRaw)
      if (v === null) {
        delete cashFallback[sym]
        continue
      }
      const list = Array.isArray(v) ? v : [v]
      const out: string[] = []
      for (const item of list) {
        if (typeof item !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(item.trim())) {
          throw new ValidationError(`fallbacks.${sym} must be tickers or null`, { field: 'fallbacks' })
        }
        const t = normalizeSymbol(item)
        if (!out.includes(t)) out.push(t)
      }
      if (out.length === 0) {
        delete cashFallback[sym]
        continue
      }
      cashFallback[sym] = out
      // Setting a fallback implies entry_required ON, same as the canvas editor.
      entryRequired.add(sym)
    }

    // Same bars -> indicators -> entry status pipeline as the cron (lookback 60).
    const defaultRule: SymbolRule = {
      stopPct: global.pullbackDefaultStopPct,
      takeProfitPct: global.pullbackDefaultTakeProfitPct,
      timeStopDays: global.pullbackDefaultTimeStopDays,
      pullbackMax: global.pullbackDefaultPullbackMax,
      pullbackMin: global.pullbackDefaultPullbackMin,
      minReturn50d: global.pullbackDefaultMinReturn50d,
      requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
      kAtr: global.pullbackDefaultKAtr,
      maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
      maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
      maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
      // Matches runStrategyCron's hardcoded default (not yet a global_config column).
      reentryMinAtrBelowLastExit: 1.0,
      reentryGuardBusinessDays: 3,
    }
    const rules = buildSymbolRules(defaultRule, universe)
    const barClient = await selectBarClient(c.env)
    const stateClient = c.env.SYMBOL_STATE ? new SymbolStateClient(c.env.SYMBOL_STATE) : null
    const symbols = [...new Set([...Object.keys(targetWeights), ...entryRequired])]
    const entryStatuses: Record<string, ReturnType<typeof deriveEntryStatusFromIndicators>['status']> = {}
    const snapshots: Record<string, EntrySnapshot> = {}
    const heldSymbols = new Set<string>()
    await Promise.all(
      symbols.map(async (sym) => {
        const state = stateClient ? await stateClient.getState(sym).catch(() => null) : null
        const heldQty = state?.position && state.position.qty > 0 ? state.position.qty : 0
        if (heldQty > 0) heldSymbols.add(sym)
        try {
          const bars = await barClient.getDailyBars(sym, 60)
          const indicators = computePullbackIndicators(bars, null)
          if (!indicators) {
            entryStatuses[sym] = 'NG'
            notes.push(`${sym}: bar 不足で指標を計算できず NG 扱い`)
            snapshots[sym] = { status: 'NG', price: 0, heldQty }
            return
          }
          const status = deriveEntryStatusFromIndicators(indicators, rules[sym] ?? defaultRule).status
          entryStatuses[sym] = status
          snapshots[sym] = { status, price: indicators.price, heldQty }
        } catch (err) {
          entryStatuses[sym] = 'NG'
          notes.push(`${sym}: bar 取得失敗 (${err instanceof Error ? err.message : String(err)}) → NG 扱い (fail-closed)`)
          snapshots[sym] = { status: 'NG', price: 0, heldQty }
        }
      }),
    )

    const allocation = computeConditionalAllocation({
      targetWeights,
      policy: {
        entryRequired,
        alwaysActive: new Set(Object.keys(universe.symbolAlwaysActive)),
        cashFallback,
      },
      entryStatuses,
      heldSymbols,
      symbolCurrency: universe.symbolCurrency,
      inversePairs: universe.inversePairs,
    })

    // No total_capital_jpy means notional can't be computed; stays null (fail-closed), noted in the response.
    let plan: ReturnType<typeof buildCashRebalancePlan> | null = null
    if (global.totalCapitalJpy != null && Number.isFinite(global.totalCapitalJpy) && global.totalCapitalJpy > 0) {
      const usdJpy = await loadUsdJpyRate({ requestId: c.get('requestId') })
      plan = buildCashRebalancePlan({
        allocation,
        snapshots,
        budgetBasisJpy: global.totalCapitalJpy,
        fxJpyPerCcy: (currency) => (currency === 'JPY' ? 1 : (usdJpy ?? undefined)),
        symbolCurrency: universe.symbolCurrency,
        symbolLotSize: universe.symbolLotSize,
        symbolMaxNotional: universe.symbolMaxNotional,
        maxOrderNotional: { USD: global.maxOrderNotionalUsd, JPY: global.maxOrderNotionalJpy },
      })
    } else {
      notes.push('total_capital_jpy 未設定のため金額換算 (予定注文) は省略 — cron 側も同条件で発注見送りになる')
    }

    return c.json({
      simulatedAt: new Date().toISOString(),
      draftApplied: Object.keys(body.pcts ?? {}).length > 0 || Object.keys(body.fallbacks ?? {}).length > 0,
      entryStatuses,
      heldSymbols: [...heldSymbols],
      allocations: allocation.bySymbol,
      plan,
      ordersEnabledFlag: global.cashFallbackOrdersEnabled,
      notes,
    })
  })
  /**
   * Sets or clears cash-fallback targets. `{ targets: ['SGOV','USMV'] }` sets
   * them (also turning `entry_required` ON; multiple targets split evenly in
   * allocation), `{ targets: null }` clears. Legacy `{ target }` also
   * accepted. Validates: all symbols registered, same currency, no self
   * reference, at most `MAX_CASH_FALLBACKS`.
   */
  .post('/symbol-config/:symbol/cash-fallback', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbol = normalizeSymbol(c.req.param('symbol'))
    const body = (await c.req.json().catch(() => null)) as unknown
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('targets' in body || 'target' in body)) {
      throw new ValidationError("body must be JSON { targets: string[] | null }", { field: 'targets' })
    }
    const payload = body as { targets?: unknown; target?: unknown }
    const rawTargets = 'targets' in payload ? payload.targets : payload.target
    let targets: string[] | null = null
    if (rawTargets !== null) {
      const list = Array.isArray(rawTargets) ? rawTargets : [rawTargets]
      const out: string[] = []
      for (const item of list) {
        if (typeof item !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(item.trim())) {
          throw new ValidationError('targets must be tickers or null', { field: 'targets' })
        }
        const sym = normalizeSymbol(item)
        if (sym === symbol) {
          throw new ValidationError('targets must differ from the symbol itself', { field: 'targets' })
        }
        if (!out.includes(sym)) out.push(sym)
      }
      if (out.length > MAX_CASH_FALLBACKS) {
        throw new ValidationError(`targets must have at most ${MAX_CASH_FALLBACKS} symbols`, { field: 'targets' })
      }
      targets = out.length > 0 ? out : null
    }
    const db = createDb(c.env.DB)
    const source = await findSymbolConfig(db, symbol)
    if (source === null) return c.json({ error: 'symbol not found' }, 404)
    for (const target of targets ?? []) {
      const targetRow = await findSymbolConfig(db, target)
      if (targetRow === null) {
        throw new ValidationError(`target ${target} is not a registered symbol`, { field: 'targets' })
      }
      // Rejected at input time rather than left to silently skip in the allocation calc.
      if (targetRow.currency !== source.currency) {
        throw new ValidationError(
          `target ${target} currency ${targetRow.currency} must match ${source.currency}`,
          { field: 'targets' },
        )
      }
    }
    const result = await updateCashFallback(db, symbol, targets, new Date().toISOString())
    if (result === null) return c.json({ error: 'symbol not found' }, 404)
    await writeAuditLog(
      c,
      '/admin/symbol-config/cash-fallback',
      `symbol=${symbol}`,
      { cashFallbackSymbols: result.before.cashFallbackSymbols, entryRequired: result.before.entryRequired },
      { cashFallbackSymbols: result.after.cashFallbackSymbols, entryRequired: result.after.entryRequired },
    )
    return c.json({
      symbol,
      cashFallbackSymbols: result.after.cashFallbackSymbols,
      entryRequired: result.after.entryRequired,
    })
  })
  /**
   * Bulk-updates budget allocation %. Each `pct_<SYMBOL>` form field is a
   * percentage (0-100); empty or 0 clears it to NULL (risk-% sizing takes
   * over). The server re-syncs an inverse pair to the same value even if
   * only one side was submitted, so it isn't dependent on client JS.
   */
  .post('/symbol-config/budget-alloc', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const isForm = isFormContentType(c.req.header('content-type'))
    const db = createDb(c.env.DB)
    const now = new Date().toISOString()
    const form = await c.req.formData()
    const inverse = await loadInversePairs(db)
    const desired = new Map<string, number | null>()
    for (const [key, raw] of form.entries()) {
      if (!key.startsWith('pct_')) continue
      const sym = normalizeSymbol(key.slice(4))
      const s = String(raw).trim()
      if (s === '') {
        desired.set(sym, null)
        continue
      }
      const pctNum = Number(s)
      if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
        throw new ValidationError(`budget_alloc_pct for ${sym} must be 0..100`, { field: 'budget_alloc_pct' })
      }
      desired.set(sym, pctNum <= 0 ? null : pctNum / 100)
    }
    // If only one side of an inverse pair was submitted, mirror its value onto the other side.
    for (const [sym, pct] of [...desired.entries()]) {
      const inv = inverse[sym]
      if (inv && !desired.has(inv)) desired.set(inv, pct)
    }
    let updated = 0
    for (const [sym, pct] of desired.entries()) {
      const res = await updateBudgetAllocPct(db, sym, pct, now)
      if (res === null) continue
      const beforeFrac = res.before.budgetAllocPct ?? null
      if (beforeFrac !== pct) {
        updated += 1
        await writeAuditLog(
          c,
          '/admin/symbol-config/budget-alloc',
          `symbol=${sym}`,
          { budgetAllocPct: beforeFrac },
          { budgetAllocPct: pct },
        )
      }
    }
    if (isForm) return c.redirect('/dashboard/symbols', 303)
    return c.json({ updated })
  })
  /**
   * Webull JP tradability check, called by the registration form when a
   * symbol is chosen. Uses Preview Order (order validation without placing
   * one) to surface TICKER_IS_DENY before registration. Only `'denied'`
   * blocks registration — `'error'` / `'unavailable'` let it through, since
   * failing the whole registration whenever the check itself is unavailable
   * would be over-aggressive fail-closed; a post-registration guard still
   * catches a bad symbol before it can trade.
   */
  .get('/symbol-config/tradability-check', rateLimit('ADMIN_WRITE'), async (c) => {
    c.header('Cache-Control', 'no-store')
    const symbolRaw = (c.req.query('symbol') ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9]{1,10}$/.test(symbolRaw)) {
      return c.json({ error: 'invalid symbol' }, 400)
    }
    const marketRaw = (c.req.query('market') ?? '').trim().toUpperCase()
    if (marketRaw !== 'US' && marketRaw !== 'JP') {
      return c.json({ error: 'market must be US or JP' }, 400)
    }
    const market = marketRaw
    // A `TICKER_IS_DENY` note recorded by a prior guard/manual fix is a known-bad symbol;
    // no need to ask the broker again. Preview doesn't check the allowlist, so this is the
    // only pre-registration signal for that case.
    if (c.env.DB) {
      const row = await findSymbolConfig(createDb(c.env.DB), symbolRaw).catch(() => null)
      if (row?.notes?.includes('TICKER_IS_DENY')) {
        return c.json({
          verdict: 'denied',
          reason: 'known_deny',
          detail: '過去に Webull が実発注を拒否した実績あり (symbol_config.notes に記録)',
          variants: [],
          instrument: null,
        })
      }
    }
    const priceRaw = Number(c.req.query('price'))
    // Instrument lookup only applies to US (the API is US_STOCK/US_ETF only); US_STOCK also
    // returns ETF rows in practice (verified with USMV), so category can stay fixed.
    const instrumentPromise =
      market === 'US'
        ? lookupInstrument(c.env, { symbol: symbolRaw, category: 'US_STOCK' })
        : undefined
    // The OpenAPI allowlist status distinguishes a deny that instrument status (OC) alone can't.
    const allowlistStatus = c.env.DB
      ? await getTradableStatusForSymbol(createDb(c.env.DB), symbolRaw).catch(() => 'unknown' as const)
      : ('unknown' as const)
    const result = await checkTradability(c.env, {
      symbol: symbolRaw,
      market,
      ...(Number.isFinite(priceRaw) && priceRaw > 0 ? { price: priceRaw } : {}),
      ...(instrumentPromise !== undefined ? { instrument: instrumentPromise } : {}),
    })
    return c.json({ ...result, allowlist: allowlistStatus })
  })
  /**
   * Proxies Yahoo Finance's public search endpoint for the registration
   * form's autocomplete. JP detection (4-digit numeric -> `.T` suffix) is
   * resolved server-side. Falls back to `matches: []` (client switches to
   * manual entry) on a Yahoo failure rather than erroring.
   */
  .get('/symbol-config/lookup', rateLimit('ADMIN_WRITE'), async (c) => {
    const queryRaw = c.req.query('q') ?? c.req.query('symbol') ?? ''
    const query = queryRaw.trim().toUpperCase()
    if (query.length < 2 || !/^[A-Z0-9.]+$/.test(query)) {
      return c.json({ matches: [] })
    }
    const isJpExact = /^\d{4}$/.test(query)
    const yahooQuery = isJpExact ? `${query}.T` : query
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooQuery)}&quotesCount=10&newsCount=0`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; webull-trading-symbol-lookup/1.0)' },
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) {
        return c.json({ matches: [], error: `yahoo_${res.status}` })
      }
      const data = (await res.json()) as {
        quotes?: Array<{
          symbol?: string
          shortname?: string
          longname?: string
          quoteType?: string
          exchange?: string
        }>
      }
      const quotes = data.quotes ?? []
      const matches = quotes
        .filter((q) => q.symbol && (q.quoteType === 'EQUITY' || q.quoteType === 'ETF'))
        .slice(0, 10)
        .map((q) => {
          const ySym = q.symbol!
          // `.T` suffix means JP, everything else US (other Yahoo exchanges are unhandled for now)
          const isJp = ySym.endsWith('.T')
          const cleanSym = isJp ? ySym.replace(/\.T$/, '') : ySym
          return {
            symbol: cleanSym,
            name: q.longname || q.shortname || null,
            market: isJp ? 'JP' : 'US',
            currency: isJp ? 'JPY' : 'USD',
            exchange: q.exchange ?? null,
            quoteType: q.quoteType ?? null,
          }
        })
      return c.json({ matches })
    } catch (err) {
      return c.json({
        matches: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  /**
   * Operator-supplied baseline for the portfolio exposure gate's
   * `openExposure{Usd,Jpy}`. Use after a holdings rebuild (e.g.
   * `/admin/orders/sync-holdings`) when the on-DO counter has drifted from
   * broker truth, or to zero things out on a fresh tenant.
   *
   * Body: `{ usd?: number, jpy?: number }`. Either side may be omitted to
   * leave that currency's counter untouched. Numbers must be finite >= 0.
   * At least one of the two must be present.
   */
  .post('/portfolio/seed-exposure', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      throw new ValidationError('PORTFOLIO_STATE binding is not configured', { field: 'env' })
    }
    const body = (await c.req.json().catch(() => null)) as unknown
    const args = readSeedExposureBody(body)
    const client = new PortfolioStateClient(c.env.PORTFOLIO_STATE)
    const before = await safeGetPortfolioState(client)
    const state = await client.seedOpenExposure(args)
    await writeAuditLog(
      c,
      '/admin/portfolio/seed-exposure',
      'portfolio=daily',
      {
        openExposureUsd: before?.openExposureUsd ?? null,
        openExposureJpy: before?.openExposureJpy ?? null,
      },
      {
        openExposureUsd: state.openExposureUsd,
        openExposureJpy: state.openExposureJpy,
      },
    )
    return c.json({
      openExposureUsd: state.openExposureUsd,
      openExposureJpy: state.openExposureJpy,
      updatedAt: state.updatedAt,
    })
  })

/**
 * Parse `/admin/portfolio/seed-exposure` body. At least one of `usd` / `jpy`
 * must be a finite number >= 0; the other can be omitted (= leave that
 * currency untouched). Reject negatives and NaN.
 */
function readSeedExposureBody(body: unknown): { usd?: number; jpy?: number } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object with { usd?, jpy? }', { field: 'body' })
  }
  const raw = body as { usd?: unknown; jpy?: unknown }
  const out: { usd?: number; jpy?: number } = {}
  if (raw.usd !== undefined && raw.usd !== null) {
    if (typeof raw.usd !== 'number' || !Number.isFinite(raw.usd) || raw.usd < 0) {
      throw new ValidationError('usd must be a finite number >= 0', { field: 'usd' })
    }
    out.usd = raw.usd
  }
  if (raw.jpy !== undefined && raw.jpy !== null) {
    if (typeof raw.jpy !== 'number' || !Number.isFinite(raw.jpy) || raw.jpy < 0) {
      throw new ValidationError('jpy must be a finite number >= 0', { field: 'jpy' })
    }
    out.jpy = raw.jpy
  }
  if (out.usd === undefined && out.jpy === undefined) {
    throw new ValidationError('at least one of usd / jpy must be provided', { field: 'body' })
  }
  return out
}

function parseMacroEventSeedRow(raw: unknown, idx: number): MacroEventCalendarSeedInput {
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError(`entry [${idx}]: must be an object`, { field: `body[${idx}]` })
  }
  const obj = raw as {
    event_type?: unknown
    event_date?: unknown
    event_time?: unknown
    notes?: unknown
  }
  const eventTypeRaw = typeof obj.event_type === 'string' ? obj.event_type.trim() : ''
  if (!isMacroEventType(eventTypeRaw)) {
    throw new ValidationError(
      `entry [${idx}]: 'event_type' must be 1-32 chars [A-Z0-9_]`,
      { field: `body[${idx}].event_type` },
    )
  }
  const eventDate = typeof obj.event_date === 'string' ? obj.event_date.trim() : ''
  if (!isYmd(eventDate)) {
    throw new ValidationError(
      `entry [${idx}]: 'event_date' must be ISO 'YYYY-MM-DD'`,
      { field: `body[${idx}].event_date` },
    )
  }
  let eventTime: string | null = null
  if (obj.event_time !== undefined && obj.event_time !== null) {
    if (typeof obj.event_time !== 'string') {
      throw new ValidationError(
        `entry [${idx}]: 'event_time' must be string when present`,
        { field: `body[${idx}].event_time` },
      )
    }
    const trimmed = obj.event_time.trim()
    if (trimmed === '') {
      eventTime = null
    } else if (!isHourMinute(trimmed)) {
      throw new ValidationError(
        `entry [${idx}]: 'event_time' must be 'HH:MM' (24h)`,
        { field: `body[${idx}].event_time` },
      )
    } else {
      eventTime = trimmed
    }
  }
  let notes: string | null = null
  if (obj.notes !== undefined && obj.notes !== null) {
    if (typeof obj.notes !== 'string') {
      throw new ValidationError(`entry [${idx}]: 'notes' must be string when present`, {
        field: `body[${idx}].notes`,
      })
    }
    if (obj.notes.length > 256) {
      throw new ValidationError(`entry [${idx}]: 'notes' must be <= 256 chars`, {
        field: `body[${idx}].notes`,
      })
    }
    notes = obj.notes
  }
  return {
    eventType: eventTypeRaw.toUpperCase(),
    eventDate,
    eventTime,
    notes,
  }
}

function isMacroEventType(value: string): boolean {
  return /^[A-Za-z0-9_]{1,32}$/.test(value)
}

function isHourMinute(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false
  const [hh, mm] = value.split(':') as [string, string]
  const h = Number(hh)
  const m = Number(mm)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return false
  if (h < 0 || h > 23) return false
  if (m < 0 || m > 59) return false
  return true
}

function parseEarningsSeedRow(raw: unknown, idx: number): EarningsCalendarSeedInput {
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError(`entry [${idx}]: must be an object`, { field: `body[${idx}]` })
  }
  const obj = raw as { symbol?: unknown; earnings_date?: unknown; notes?: unknown }
  const symbol = typeof obj.symbol === 'string' ? obj.symbol.trim() : ''
  if (symbol.length === 0 || symbol.length > 16) {
    throw new ValidationError(`entry [${idx}]: 'symbol' must be a non-empty string <= 16 chars`, {
      field: `body[${idx}].symbol`,
    })
  }
  const earningsDate = typeof obj.earnings_date === 'string' ? obj.earnings_date.trim() : ''
  if (!isYmd(earningsDate)) {
    throw new ValidationError(
      `entry [${idx}]: 'earnings_date' must be ISO 'YYYY-MM-DD'`,
      { field: `body[${idx}].earnings_date` },
    )
  }
  let notes: string | null = null
  if (obj.notes !== undefined && obj.notes !== null) {
    if (typeof obj.notes !== 'string') {
      throw new ValidationError(`entry [${idx}]: 'notes' must be string when present`, {
        field: `body[${idx}].notes`,
      })
    }
    if (obj.notes.length > 256) {
      throw new ValidationError(`entry [${idx}]: 'notes' must be <= 256 chars`, {
        field: `body[${idx}].notes`,
      })
    }
    notes = obj.notes
  }
  return { symbol: symbol.toUpperCase(), earningsDate, notes }
}

// Strict validation so an operator typo gets a 400 instead of silently writing a malformed position into the DO.
function readOverridePositionBody(body: unknown): {
  qty: number
  avgPrice: number
  openedAt: string | null
  reason: string
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object', { field: 'body' })
  }
  const raw = body as {
    qty?: unknown
    avgPrice?: unknown
    openedAt?: unknown
    reason?: unknown
  }
  const qty = raw.qty
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0) {
    throw new ValidationError('qty must be a finite number >= 0', { field: 'qty' })
  }
  const avgPriceRaw = raw.avgPrice
  let avgPrice = 0
  if (qty > 0) {
    if (typeof avgPriceRaw !== 'number' || !Number.isFinite(avgPriceRaw) || avgPriceRaw <= 0) {
      throw new ValidationError('avgPrice must be a finite number > 0 when qty>0', {
        field: 'avgPrice',
      })
    }
    avgPrice = avgPriceRaw
  } else if (avgPriceRaw !== undefined && avgPriceRaw !== null) {
    // avgPrice is unused when closing (qty=0), but still type-checked so a stray value isn't silently accepted.
    if (typeof avgPriceRaw !== 'number' || !Number.isFinite(avgPriceRaw) || avgPriceRaw < 0) {
      throw new ValidationError('avgPrice must be a finite number >= 0 when present', {
        field: 'avgPrice',
      })
    }
  }
  let openedAt: string | null = null
  if (raw.openedAt !== undefined && raw.openedAt !== null) {
    if (typeof raw.openedAt !== 'string') {
      throw new ValidationError('openedAt must be an ISO 8601 string or null', {
        field: 'openedAt',
      })
    }
    const t = new Date(raw.openedAt).getTime()
    if (!Number.isFinite(t)) {
      throw new ValidationError('openedAt must be a valid ISO 8601 timestamp', {
        field: 'openedAt',
      })
    }
    openedAt = raw.openedAt
  }
  const reason = raw.reason
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ValidationError('reason must be a non-empty string', { field: 'reason' })
  }
  if (reason.length > 256) {
    throw new ValidationError('reason must be <= 256 chars', { field: 'reason' })
  }
  return { qty, avgPrice, openedAt, reason }
}

function readToggleBody(body: unknown): { enabled: boolean; reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object or form-encoded', { field: 'body' })
  }
  const raw = body as { enabled?: unknown; reason?: unknown }
  const enabledRaw = raw.enabled
  let enabled: boolean
  if (typeof enabledRaw === 'boolean') {
    enabled = enabledRaw
  } else if (typeof enabledRaw === 'string') {
    // Also accepts HTML checkbox-style 'on'/'off' alongside the dashboard form's 'true'/'false'.
    const norm = enabledRaw.trim().toLowerCase()
    if (norm === 'true' || norm === '1' || norm === 'on') enabled = true
    else if (norm === 'false' || norm === '0' || norm === 'off') enabled = false
    else
      throw new ValidationError("enabled must be boolean ('true'/'false')", { field: 'enabled' })
  } else {
    throw new ValidationError('enabled must be a boolean', { field: 'enabled' })
  }
  const reasonRaw = raw.reason
  if (typeof reasonRaw !== 'string' || reasonRaw.trim().length === 0) {
    throw new ValidationError('reason must be a non-empty string', { field: 'reason' })
  }
  if (reasonRaw.length > 256) {
    throw new ValidationError('reason must be <= 256 chars', { field: 'reason' })
  }
  return { enabled, reason: reasonRaw }
}

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

function readRequiredParam(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`'${field}' query param is required`, { field })
  }
  return value.trim()
}

function readOptionalNumber(
  value: string | undefined,
  field: string,
  defaultValue: number,
  opts: { mustBePositive?: boolean },
): number {
  if (value === undefined || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`'${field}' must be a finite number`, { field })
  }
  if (opts.mustBePositive && parsed <= 0) {
    throw new ValidationError(`'${field}' must be > 0`, { field })
  }
  return parsed
}

/**
 * Treat `1` / `true` / `yes` (case-insensitive) as truthy. Anything else —
 * including missing — is false. Kept narrow so an operator typo on a flag
 * fails closed (the safer default for a "do extra work" toggle).
 */
function parseTruthyQuery(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * Parse a positive integer query param with an upper bound. Returns
 * `undefined` for absent / unparseable / out-of-range values so the caller
 * falls back to its built-in default (= zero broker pressure from a typo).
 */
function parsePositiveIntQuery(
  value: string | undefined,
  { max }: { max: number },
): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return undefined
  if (n > max) return undefined
  return n
}

// A missing/unreachable D1 skips the log rather than failing the request — the handler's state
// change already succeeded, and a missing audit entry shouldn't turn that into a 500.
async function writeAuditLog(
  c: Context<AppBindings>,
  endpoint: string,
  targetKey: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (!c.env.DB) return
  try {
    const actor = extractActor(c.get('actor'))
    await recordChange(c.env.DB, {
      actor,
      endpoint,
      targetKey,
      before,
      after,
      requestId: c.get('requestId') ?? null,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'config_audit_log_write_failed',
        endpoint,
        targetKey,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

// Swallows a throw (e.g. a legacy fake stub without getState) so a missing before-snapshot
// for the audit log doesn't block the handler's actual state change.
async function safeGetSymbolState(
  client: SymbolStateClient,
  symbol: string,
): Promise<Awaited<ReturnType<SymbolStateClient['getState']>> | null> {
  try {
    return await client.getState(symbol)
  } catch {
    return null
  }
}

async function safeGetPortfolioState(
  client: PortfolioStateClient,
): Promise<Awaited<ReturnType<PortfolioStateClient['getPortfolio']>> | null> {
  try {
    return await client.getPortfolio()
  } catch {
    return null
  }
}

// Rejects calendar-invalid dates like '2026-02-30' by re-formatting the parsed Date and
// comparing it back to the input — `Date` would otherwise silently normalize it to '2026-03-02'.
function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  const roundTrip = new Date(ms).toISOString().slice(0, 10)
  return roundTrip === value
}

// Shared parser for the symbol_config CRUD UI: dashboard sends
// application/x-www-form-urlencoded, CLI sends JSON. `currency` is
// constrained to 'USD' | 'JPY' to match the DB CHECK constraint.
function parseSymbolConfigBody(body: unknown): SymbolConfigWriteInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be an object or form-encoded', { field: 'body' })
  }
  const raw = body as {
    symbol?: unknown
    name?: unknown
    market?: unknown
    currency?: unknown
    active?: unknown
    max_notional?: unknown
    maxNotional?: unknown
    notes?: unknown
    time_stop_days_override?: unknown
    timeStopDaysOverride?: unknown
    k_atr_override?: unknown
    kAtrOverride?: unknown
    budget_alloc_pct?: unknown
    budgetAllocPct?: unknown
    lot_size?: unknown
    lotSize?: unknown
    stop_pct_override?: unknown
    stopPctOverride?: unknown
    take_profit_pct_override?: unknown
    takeProfitPctOverride?: unknown
    intraday_only?: unknown
    intradayOnly?: unknown
    role?: unknown
    pullback_max_override?: unknown
    pullbackMaxOverride?: unknown
    pullback_min_override?: unknown
    pullbackMinOverride?: unknown
    min_return_50d_override?: unknown
    minReturn50dOverride?: unknown
    max_atr_ratio_override?: unknown
    maxAtrRatioOverride?: unknown
    max_sma50_deviation_pct_override?: unknown
    maxSma50DeviationPctOverride?: unknown
    require_above_sma50_override?: unknown
    requireAboveSma50Override?: unknown
    entry_required?: unknown
    entryRequired?: unknown
    always_active?: unknown
    alwaysActive?: unknown
    cash_fallback_symbol?: unknown
    cashFallbackSymbol?: unknown
  }
  const symbol = normalizeSymbol(raw.symbol)
  const market = parseMarket(raw.market)
  const currency = parseCurrency(raw.currency)
  // An unsent checkbox key (undefined) is treated as false (disabled), the safer default.
  const active = parseFormBool(raw.active, false)
  const maxNotionalRaw = raw.max_notional ?? raw.maxNotional
  const maxNotional = parseOptionalPositiveNumber(maxNotionalRaw, 'maxNotional')
  const name = parseOptionalString(raw.name, 'name')
  const notes = parseOptionalString(raw.notes, 'notes')
  const timeStopDaysOverride = parseOptionalIntegerInRange(
    raw.time_stop_days_override ?? raw.timeStopDaysOverride,
    'timeStopDaysOverride',
    1,
    365,
  )
  const kAtrOverride = parseOptionalNumberInRange(
    raw.k_atr_override ?? raw.kAtrOverride,
    'kAtrOverride',
    0.5,
    5.0,
  )
  // Form sends a percent (0.1-100), stored as a fraction. The 0.1 floor matches the UI's
  // display rounding, so a sub-0.1% value can't get silently truncated to zero on save.
  const budgetAllocPctRaw = parseOptionalNumberInRange(
    raw.budget_alloc_pct ?? raw.budgetAllocPct,
    'budgetAllocPct',
    0.1,
    100,
  )
  const budgetAllocPct = budgetAllocPctRaw === null ? null : budgetAllocPctRaw / 100
  // Lot size has no fallback: a missing/blank value is rejected rather than defaulted.
  const lotSize = parseRequiredIntegerInRange(raw.lot_size ?? raw.lotSize, 'lotSize', 1, 100_000)
  const stopPctRaw = parseOptionalNumberInRange(
    raw.stop_pct_override ?? raw.stopPctOverride,
    'stopPctOverride',
    -99,
    -0.1,
  )
  const stopPctOverride = stopPctRaw === null ? null : stopPctRaw / 100
  const takeProfitPctRaw = parseOptionalNumberInRange(
    raw.take_profit_pct_override ?? raw.takeProfitPctOverride,
    'takeProfitPctOverride',
    0.1,
    100,
  )
  const takeProfitPctOverride = takeProfitPctRaw === null ? null : takeProfitPctRaw / 100
  const intradayOnly = parseFormBool(raw.intraday_only ?? raw.intradayOnly, false)
  // Rejects an unrecognized role with 400 rather than silently falling back to legacy behavior.
  const role = parseSymbolRole(raw.role)
  const pullbackMaxRaw = parseOptionalNumberInRange(
    raw.pullback_max_override ?? raw.pullbackMaxOverride,
    'pullbackMaxOverride',
    -100,
    0,
  )
  const pullbackMaxOverride = pullbackMaxRaw === null ? null : pullbackMaxRaw / 100
  const pullbackMinRaw = parseOptionalNumberInRange(
    raw.pullback_min_override ?? raw.pullbackMinOverride,
    'pullbackMinOverride',
    -100,
    0,
  )
  const pullbackMinOverride = pullbackMinRaw === null ? null : pullbackMinRaw / 100
  // A max shallower than min would make entry permanently unreachable; caught here as a typo guard.
  // A single-sided override isn't checked, since it combines with the global/preset value for the other side.
  if (
    pullbackMaxOverride !== null &&
    pullbackMinOverride !== null &&
    pullbackMaxOverride < pullbackMinOverride
  ) {
    throw new ValidationError(
      'pullbackMaxOverride (0 側) must be >= pullbackMinOverride (深い側)',
      { field: 'pullbackMaxOverride' },
    )
  }
  const minReturn50dRaw = parseOptionalNumberInRange(
    raw.min_return_50d_override ?? raw.minReturn50dOverride,
    'minReturn50dOverride',
    -100,
    1000,
  )
  const minReturn50dOverride = minReturn50dRaw === null ? null : minReturn50dRaw / 100
  const maxAtrRatioOverride = parseOptionalNumberInRange(
    raw.max_atr_ratio_override ?? raw.maxAtrRatioOverride,
    'maxAtrRatioOverride',
    0.1,
    10,
  )
  const maxSma50DeviationPctRaw = parseOptionalNumberInRange(
    raw.max_sma50_deviation_pct_override ?? raw.maxSma50DeviationPctOverride,
    'maxSma50DeviationPctOverride',
    0.1,
    1000,
  )
  const maxSma50DeviationPctOverride =
    maxSma50DeviationPctRaw === null ? null : maxSma50DeviationPctRaw / 100
  const requireAboveSma50Override = parseOptionalTriStateBool(
    raw.require_above_sma50_override ?? raw.requireAboveSma50Override,
    'requireAboveSma50Override',
  )
  const entryRequired = parseFormBool(raw.entry_required ?? raw.entryRequired, false)
  const alwaysActive = parseFormBool(raw.always_active ?? raw.alwaysActive, false)
  const cashFallbackSymbols = parseCashFallbackSymbols(
    raw.cash_fallback_symbol ?? raw.cashFallbackSymbol,
    symbol,
  )
  return {
    symbol,
    name,
    market,
    currency,
    active,
    maxNotional,
    notes,
    timeStopDaysOverride,
    kAtrOverride,
    budgetAllocPct,
    lotSize,
    stopPctOverride,
    takeProfitPctOverride,
    intradayOnly,
    role,
    pullbackMaxOverride,
    pullbackMinOverride,
    minReturn50dOverride,
    maxAtrRatioOverride,
    maxSma50DeviationPctOverride,
    requireAboveSma50Override,
    entryRequired,
    alwaysActive,
    cashFallbackSymbols,
  }
}

function parseCashFallbackSymbols(value: unknown, selfSymbol: string): string[] | null {
  if (value === undefined || value === null) return null
  let tokens: string[]
  if (Array.isArray(value)) {
    tokens = value.map((v) => {
      if (typeof v !== 'string') {
        throw new ValidationError('cashFallbackSymbols must be symbols', { field: 'cashFallbackSymbols' })
      }
      return v
    })
  } else if (typeof value === 'string') {
    tokens = value.split(/[\s,]+/)
  } else {
    throw new ValidationError('cashFallbackSymbols must be a string or array', {
      field: 'cashFallbackSymbols',
    })
  }
  const out: string[] = []
  for (const token of tokens) {
    const sym = token.trim().toUpperCase()
    if (sym === '') continue
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) {
      throw new ValidationError(`cashFallbackSymbols contains an invalid symbol: ${sym}`, {
        field: 'cashFallbackSymbols',
      })
    }
    if (sym === selfSymbol.toUpperCase()) {
      throw new ValidationError('cashFallbackSymbols cannot reference itself', {
        field: 'cashFallbackSymbols',
      })
    }
    if (!out.includes(sym)) out.push(sym)
  }
  if (out.length > MAX_CASH_FALLBACKS) {
    throw new ValidationError(`cashFallbackSymbols must have at most ${MAX_CASH_FALLBACKS} symbols`, {
      field: 'cashFallbackSymbols',
    })
  }
  return out.length > 0 ? out : null
}

function parseSymbolRole(value: unknown): SymbolRole | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ValidationError(`role must be one of: ${SYMBOL_ROLES.join(', ')}`, { field: 'role' })
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!isSymbolRole(trimmed)) {
    throw new ValidationError(`role must be one of: ${SYMBOL_ROLES.join(', ')}`, { field: 'role' })
  }
  return trimmed
}

function parseOptionalTriStateBool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === '') return null
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
  }
  throw new ValidationError(`${field} must be '', 'true' or 'false'`, { field })
}

function parseRequiredIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const invalid = () => {
    throw new ValidationError(`${field} is required and must be an integer between ${min} and ${max}`, {
      field,
    })
  }
  if (value === undefined || value === null) invalid()
  let parsed: number
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') invalid()
    parsed = Number(trimmed)
  } else if (typeof value === 'number') {
    parsed = value
  } else {
    invalid()
    return 0 // unreachable (invalid throws), satisfies type checker
  }
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid()
  }
  return parsed
}

function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('symbol must be a 1-10 char alphanumeric string', { field: 'symbol' })
  }
  const trimmed = value.trim().toUpperCase()
  if (trimmed.length === 0 || trimmed.length > 10) {
    throw new ValidationError('symbol must be 1-10 chars', { field: 'symbol' })
  }
  if (!/^[A-Z0-9]+$/.test(trimmed)) {
    throw new ValidationError('symbol must be alphanumeric only', { field: 'symbol' })
  }
  return trimmed
}

function normalizeSymbolPathParam(value: string): string {
  return normalizeSymbol(value)
}

function parseInverseSymbolField(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = (body as { inverse_symbol?: unknown; inverseSymbol?: unknown })
  const value = raw.inverse_symbol ?? raw.inverseSymbol
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return normalizeSymbol(value)
}

// An invalid market/currency resolves to undefined here rather than throwing,
// so createSymbolPair falls back to inheriting the primary symbol's values.
function parseCounterpartMeta(body: unknown): CounterpartMeta {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  const raw = body as { inverse_name?: unknown; inverse_market?: unknown; inverse_currency?: unknown }
  const name =
    typeof raw.inverse_name === 'string' && raw.inverse_name.trim().length > 0
      ? raw.inverse_name.trim().slice(0, 256)
      : null
  const market = raw.inverse_market === 'US' || raw.inverse_market === 'JP' ? raw.inverse_market : undefined
  const currency =
    raw.inverse_currency === 'USD' || raw.inverse_currency === 'JPY' ? raw.inverse_currency : undefined
  return { name, market, currency }
}

function parseMarket(value: unknown): 'US' | 'JP' {
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase()
    if (trimmed === 'US' || trimmed === 'JP') return trimmed
  }
  throw new ValidationError("market must be 'US' or 'JP'", { field: 'market' })
}

function parseCurrency(value: unknown): 'USD' | 'JPY' {
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase()
    if (trimmed === 'USD' || trimmed === 'JPY') return trimmed
  }
  throw new ValidationError("currency must be 'USD' or 'JPY'", { field: 'currency' })
}

function parseFormBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase()
    if (norm === 'true' || norm === '1' || norm === 'on') return true
    if (norm === 'false' || norm === '0' || norm === 'off' || norm === '') return false
  }
  throw new ValidationError("active must be boolean ('true'/'false')", { field: 'active' })
}

function parseOptionalPositiveNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ValidationError(`${field} must be a positive number or empty`, { field })
    }
    return parsed
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError(`${field} must be a positive number or empty`, { field })
    }
    return value
  }
  throw new ValidationError(`${field} must be a positive number or empty`, { field })
}

function parseOptionalIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new ValidationError(
        `${field} must be an integer between ${min} and ${max}, or empty`,
        { field },
      )
    }
    return parsed
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      throw new ValidationError(
        `${field} must be an integer between ${min} and ${max}, or empty`,
        { field },
      )
    }
    return value
  }
  throw new ValidationError(
    `${field} must be an integer between ${min} and ${max}, or empty`,
    { field },
  )
}

function parseOptionalNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new ValidationError(
        `${field} must be a number between ${min} and ${max}, or empty`,
        { field },
      )
    }
    return parsed
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ValidationError(
        `${field} must be a number between ${min} and ${max}, or empty`,
        { field },
      )
    }
    return value
  }
  throw new ValidationError(
    `${field} must be a number between ${min} and ${max}, or empty`,
    { field },
  )
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > 256) {
    throw new ValidationError(`${field} must be <= 256 chars`, { field })
  }
  return trimmed
}

function symbolConfigSnapshot(row: SymbolConfigRow): Record<string, unknown> {
  return {
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    currency: row.currency,
    active: row.active,
    maxNotional: row.maxNotional,
    notes: row.notes,
    timeStopDaysOverride: row.timeStopDaysOverride,
    kAtrOverride: row.kAtrOverride,
    budgetAllocPct: row.budgetAllocPct,
    // Every settings column is included so an audit diff can't silently miss a change.
    lotSize: row.lotSize,
    stopPctOverride: row.stopPctOverride,
    takeProfitPctOverride: row.takeProfitPctOverride,
    intradayOnly: row.intradayOnly,
    role: row.role,
    pullbackMaxOverride: row.pullbackMaxOverride,
    pullbackMinOverride: row.pullbackMinOverride,
    minReturn50dOverride: row.minReturn50dOverride,
    maxAtrRatioOverride: row.maxAtrRatioOverride,
    maxSma50DeviationPctOverride: row.maxSma50DeviationPctOverride,
    requireAboveSma50Override: row.requireAboveSma50Override,
    updatedAt: row.updatedAt,
  }
}

function isFormContentType(contentType: string | undefined): boolean {
  const ct = contentType ?? ''
  return (
    ct.includes('application/x-www-form-urlencoded') ||
    ct.includes('multipart/form-data')
  )
}

async function readFormOrJsonBody(c: Context<AppBindings>): Promise<unknown> {
  if (isFormContentType(c.req.header('content-type'))) {
    const fd = await c.req.formData()
    const obj: Record<string, unknown> = {}
    for (const [k, v] of fd.entries()) obj[k] = typeof v === 'string' ? v : ''
    return obj
  }
  return (await c.req.json().catch(() => null)) as unknown
}

/**
 * Yahoo `getDailyBars` takes a bar count (lookback). Translate the requested
 * date range into a generous bar count covering 60 warmup bars + (to-from)
 * trading days plus a 50% holiday/weekend fudge factor. Capped at the largest
 * Yahoo bucket (5y / ~1300 bars).
 */
function estimateLookbackDays(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00.000Z`)
  const b = Date.parse(`${toYmd}T00:00:00.000Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 200
  const calendarDays = Math.max(1, Math.round((b - a) / 86_400_000) + 1)
  // Trading days ≈ calendar * 5/7. Add 60 warmup + 20 buffer.
  const tradingDays = Math.ceil(calendarDays * (5 / 7)) + 60 + 20
  return Math.min(1300, Math.max(80, tradingDays))
}

interface BacktestSetup {
  symbol: string
  from: string
  to: string
  initialCash: number
  rule: SymbolRule
  atrBaselineMode: 'overlap' | 'exclude-recent' | 'percentile'
  sliced: DailyBar[]
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>
}

// Shared by `/backtest` and `/backtest/compare` so both see identical bars/rule and their
// results stay comparable.
async function buildBacktestSetup(c: Context<AppBindings>): Promise<BacktestSetup> {
  const symbol = readRequiredParam(c.req.query('symbol'), 'symbol').toUpperCase()
  const from = readRequiredParam(c.req.query('from'), 'from')
  const to = readRequiredParam(c.req.query('to'), 'to')
  if (!isYmd(from)) throw new ValidationError("'from' must be YYYY-MM-DD", { field: 'from' })
  if (!isYmd(to)) throw new ValidationError("'to' must be YYYY-MM-DD", { field: 'to' })
  if (from > to) {
    throw new ValidationError("'from' must be <= 'to'", { field: 'from' })
  }
  const initialCash = readOptionalNumber(c.req.query('initialCash'), 'initialCash', 10_000, {
    mustBePositive: true,
  })

  const global = await loadGlobalConfigFrom(c.env, c.get('requestId'))
  const rule: SymbolRule = {
    stopPct: readOptionalNumber(c.req.query('stopPct'), 'stopPct', global.pullbackDefaultStopPct, {}),
    takeProfitPct: readOptionalNumber(
      c.req.query('takeProfitPct'),
      'takeProfitPct',
      global.pullbackDefaultTakeProfitPct,
      {},
    ),
    timeStopDays: readOptionalNumber(
      c.req.query('timeStopDays'),
      'timeStopDays',
      global.pullbackDefaultTimeStopDays,
      { mustBePositive: true },
    ),
    pullbackMax: readOptionalNumber(
      c.req.query('pullbackMax'),
      'pullbackMax',
      global.pullbackDefaultPullbackMax,
      {},
    ),
    pullbackMin: readOptionalNumber(
      c.req.query('pullbackMin'),
      'pullbackMin',
      global.pullbackDefaultPullbackMin,
      {},
    ),
    minReturn50d: readOptionalNumber(
      c.req.query('minReturn50d'),
      'minReturn50d',
      global.pullbackDefaultMinReturn50d,
      {},
    ),
    requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
    kAtr: readOptionalNumber(c.req.query('kAtr'), 'kAtr', global.pullbackDefaultKAtr, {
      mustBePositive: true,
    }),
    maxSma50DeviationPct: readOptionalNumber(
      c.req.query('maxSma50DeviationPct'),
      'maxSma50DeviationPct',
      global.pullbackDefaultMaxSma50DeviationPct,
      { mustBePositive: true },
    ),
    maxAtrRatio: readOptionalNumber(
      c.req.query('maxAtrRatio'),
      'maxAtrRatio',
      global.pullbackDefaultMaxAtrRatio,
      { mustBePositive: true },
    ),
    maxStopToTpRatio: readOptionalNumber(
      c.req.query('maxStopToTpRatio'),
      'maxStopToTpRatio',
      global.pullbackDefaultMaxStopToTpRatio,
      {},
    ),
    // Unused by `/backtest` (runBacktest has no entry-policy axis); `/backtest/compare`'s
    // `reentry:guard`/`reentry:aware:<n>` variants use it via runLifecycleBacktest's `lastExit`
    // tracking. No query override yet — always the hardcoded default below.
    reentryMinAtrBelowLastExit: 1.0,
    reentryGuardBusinessDays: 3,
  }

  // Need at least 50 warmup bars before `from` for SMA50; estimate generous
  // lookback in calendar days then trim with `from`/`to`. ~1.6× fudge to
  // cover holidays.
  const lookbackDays = estimateLookbackDays(from, to)
  const barClient = new YahooBarClient()
  const allBars = await barClient.getDailyBars(symbol, lookbackDays)
  const bars = allBars.filter((b) => b.date <= to)
  // Keep at least the first 60 bars before `from` as warmup; if available
  // we slice to (from - warmup_buffer)..to. Yahoo already returned them
  // oldest-first.
  const liveStartIdx = bars.findIndex((b) => b.date >= from)
  if (liveStartIdx === -1) {
    // No bars within [from, to]: Yahoo had no daily data for the requested
    // window (e.g. `from` is in the future, or symbol delisted before
    // `from`). Reject with 400 instead of silently running on the entire
    // pre-`from` history (which would compute against an unrelated window
    // and return a misleading 200).
    throw new ValidationError('no bars found in requested range', { field: 'from' })
  }
  const warmupKeep = 60
  const sliced = bars.slice(Math.max(0, liveStartIdx - warmupKeep))

  // `?atrBaselineMode=overlap|exclude-recent|percentile` overrides how the baseline is built,
  // for comparing against the global_config default (= production behavior).
  const atrBaselineModeQuery = c.req.query('atrBaselineMode')
  const atrBaselineMode: BacktestSetup['atrBaselineMode'] =
    atrBaselineModeQuery === 'overlap' ||
    atrBaselineModeQuery === 'exclude-recent' ||
    atrBaselineModeQuery === 'percentile'
      ? atrBaselineModeQuery
      : global.atrBaselineMode

  return { symbol, from, to, initialCash, rule, atrBaselineMode, sliced, global }
}

// Each variant beyond `full` isolates one axis (entry, exit, or re-entry) against the
// one-shot-entry/preset-exit baseline, so comparisons across axes aren't confounded.
const DEFAULT_COMPARE_VARIANTS = [
  'full',
  'staged:25/25/50',
  'full+trail:50/2/0',
  'full+trail:50/2/5',
  'full+preset+reentry:guard',
  'full+preset+reentry:aware:5',
]

/**
 * Parse one `/backtest/compare` `variants` entry (`<entry>`, `<entry>+<exit>`, or
 * `<entry>+<exit>+reentry:<spec>` — the `reentry:` segment may also follow a bare `<entry>` with
 * `<exit>` omitted) into an `EntryPolicy` + `ExitPolicy` + `ReentryPolicy` triple. Omitting
 * `+<exit>` is `+preset` and omitting `+reentry:<spec>` is `+reentry:none` — this keeps every
 * pre-Phase-5 spec string (`full`, `staged:25/25/50`, `full+trail:...`) parsing to the exact same
 * `EntryPolicy`/`ExitPolicy` it always did, with `reentryPolicy: {kind:'none'}` alongside it.
 */
function parseVariantSpec(
  spec: string,
  confirmDays: number,
): { name: string; entryPolicy: EntryPolicy; exitPolicy: ExitPolicy; reentryPolicy: ReentryPolicy } {
  const segments = spec.split('+')
  if (segments.length > 3 || segments.length < 1 || segments.some((s) => s.length === 0)) {
    throw new ValidationError(
      `'variants' entry '${spec}' must be '<entry>', '<entry>+<exit>', or '<entry>[+<exit>]+reentry:<spec>'`,
      { field: 'variants' },
    )
  }
  const [entrySpec, ...rest] = segments as [string, ...string[]]
  // Segments after the entry are order-sensitive: a `reentry:`-prefixed one is always reentry, a
  // bare one is always exit, and exit (if present) must come before reentry — mirrors the
  // documented `<entry>[+<exit>][+reentry:<spec>]` grammar instead of accepting either order.
  let exitSpec: string | undefined
  let reentrySpec: string | undefined
  for (const seg of rest) {
    if (seg.startsWith('reentry:')) {
      if (reentrySpec !== undefined) {
        throw new ValidationError(
          `'variants' entry '${spec}' must have at most one 'reentry:' segment`,
          { field: 'variants' },
        )
      }
      reentrySpec = seg.slice('reentry:'.length)
    } else {
      if (exitSpec !== undefined || reentrySpec !== undefined) {
        throw new ValidationError(
          `'variants' entry '${spec}': exit segment '${seg}' must come before 'reentry:...' and appear at most once`,
          { field: 'variants' },
        )
      }
      exitSpec = seg
    }
  }
  return {
    name: spec,
    entryPolicy: parseEntrySpec(entrySpec, spec, confirmDays),
    exitPolicy: parseExitSpec(exitSpec ?? 'preset', spec),
    reentryPolicy: parseReentrySpec(reentrySpec ?? 'none', spec),
  }
}

/** `full` = current one-shot entry. `staged:<probe>/<confirm>/<full>` = 3 integer percentages
 * (must sum to 100) mapped to fractions of `initialCash`. */
function parseEntrySpec(entrySpec: string, fullSpec: string, confirmDays: number): EntryPolicy {
  if (entrySpec === 'full') return { kind: 'full' }
  const match = /^staged:(\d{1,3})\/(\d{1,3})\/(\d{1,3})$/.exec(entrySpec)
  if (!match) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': entry segment '${entrySpec}' must be 'full' or 'staged:<probe>/<confirm>/<full>' (integer %)`,
      { field: 'variants' },
    )
  }
  const probe = Number(match[1])
  const confirm = Number(match[2])
  const full = Number(match[3])
  if (probe + confirm + full !== 100) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': probe+confirm+full must sum to 100 (got ${probe + confirm + full})`,
      { field: 'variants' },
    )
  }
  return {
    kind: 'staged',
    fractions: { probe: probe / 100, confirm: confirm / 100, full: full / 100 },
    confirmDays,
  }
}

/** `preset` = all-quantity TP/stop/time-stop.
 * `trail:<tpFraction%>/<trailKAtr>/<extDays>` = partial-exit + ATR trailing. */
function parseExitSpec(exitSpec: string, fullSpec: string): ExitPolicy {
  if (exitSpec === 'preset') return { kind: 'preset' }
  const match = /^trail:(\d{1,3})\/(\d+(?:\.\d+)?)\/(\d+)$/.exec(exitSpec)
  if (!match) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': exit segment '${exitSpec}' must be 'preset' or 'trail:<tpFraction%>/<trailKAtr>/<extDays>'`,
      { field: 'variants' },
    )
  }
  const tpFractionPct = Number(match[1])
  const trailKAtr = Number(match[2])
  const timeStopExtensionDays = Number(match[3])
  if (tpFractionPct <= 0 || tpFractionPct > 100) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': tpFraction% must be in (0, 100] (got ${tpFractionPct})`,
      { field: 'variants' },
    )
  }
  if (!(trailKAtr > 0)) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': trailKAtr must be > 0 (got ${trailKAtr})`,
      { field: 'variants' },
    )
  }
  return {
    kind: 'partial-trailing',
    tpFraction: tpFractionPct / 100,
    trailKAtr,
    timeStopExtensionDays,
  }
}

/** `none` = no re-entry gate. `guard` = replica of the live `PullbackUptrendStrategy` re-entry
 * price ceiling. `aware:<slWaitDays>` = exit-reason-aware re-entry — see `evaluateReentry` in
 * `runLifecycleBacktest.ts` for the exact per-reason rules. */
function parseReentrySpec(reentrySpec: string, fullSpec: string): ReentryPolicy {
  if (reentrySpec === 'none') return { kind: 'none' }
  if (reentrySpec === 'guard') return { kind: 'price-guard' }
  const match = /^aware:(\d+)$/.exec(reentrySpec)
  if (!match) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': reentry segment 'reentry:${reentrySpec}' must be 'reentry:none', 'reentry:guard', or 'reentry:aware:<slWaitDays>'`,
      { field: 'variants' },
    )
  }
  const slWaitDays = Number(match[1])
  if (!(slWaitDays >= 0)) {
    throw new ValidationError(
      `'variants' entry '${fullSpec}': reentry slWaitDays must be >= 0 (got ${slWaitDays})`,
      { field: 'variants' },
    )
  }
  return { kind: 'reason-aware', slWaitDays }
}
