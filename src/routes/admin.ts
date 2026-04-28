import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { ValidationError } from '../shared/errors'
import { createWebullHttpClient } from '../infrastructure/webull/WebullHttpClient'
import { buildSignedHeaders } from '../infrastructure/webull/WebullAuth'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import { reconcileFills } from '../trading/reconciliation/reconcileFills'
import { syncHoldings } from '../trading/reconciliation/syncHoldings'
import { runStrategyCron } from '../trading/strategy/runStrategyCron'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { YahooBarClient } from '../infrastructure/quotes/YahooBarClient'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../infrastructure/db/schema'
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
import type { SymbolRule } from '../trading/strategy/strategies/PullbackUptrendStrategy'

/**
 * Operator-only endpoints. Basic-auth-protected by the same middleware as
 * `/trade/*` at mount time. Use sparingly — these mutate DO state out-of-band
 * and should only be called for initial seeding or reconciliation.
 */
export const admin = new Hono<AppBindings>()
  /**
   * Operator override for a corrupted `position`. Used when a past reconcile
   * race left DO state with a qty above broker truth (#215) — the regular
   * recordFill path can't undo it because there is no fill to apply, so the
   * operator must reset directly. POC blast radius: requires Basic Auth and
   * an explicit `reason` string for the audit log.
   *
   * Body: `{ qty: number, avgPrice: number, openedAt?: string | null, reason: string }`
   *   - `qty=0` → close the position (avgPrice / openedAt ignored)
   *   - `qty>0` → write `{ qty, avgPrice, openedAt: openedAt ?? now() }`
   *
   * Side effects: emits one structured `symbol_state_position_override`
   * audit log with before/after/reason/requestId. Does NOT touch
   * `pendingOrder` / `cooldownUntil` / `settledCash`.
   */
  .post('/symbol-state/:symbol/override-position', async (c) => {
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
    const state = await client.overridePosition(symbol, {
      qty: args.qty,
      avgPrice: args.avgPrice,
      openedAt: args.openedAt,
      reason: args.reason,
      requestId: c.get('requestId'),
    })
    return c.json({
      symbol,
      position: state.position,
      updatedAt: state.updatedAt,
    })
  })
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
   * 強制的に cooldownUntil を過去時刻 (UNIX epoch 0) にして取引停止状態を解除する。
   * 直前損切後の cooldown (reconcileFills が設定) を staging で即解除したい時に
   * 使う。PositionStore.setCooldown は string 必須なので `new Date(0).toISOString()`
   * を渡すことで「過去」扱いにして実質クリア。
   */
  .post('/symbols/:symbol/clear-cooldown', async (c) => {
    const symbol = c.req.param('symbol').trim().toUpperCase()
    if (symbol.length === 0) {
      throw new ValidationError('symbol must be a non-empty path param', { field: 'symbol' })
    }
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }
    const pastIso = new Date(0).toISOString()
    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const state = await client.setCooldown(symbol, pastIso)
    return c.json({
      symbol,
      cooldownUntil: state.cooldownUntil,
      note: 'cooldown を epoch に戻したため strategy の `> now` 判定で即失効',
      updatedAt: state.updatedAt,
    })
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
   * Offline backtest harness for PullbackUptrendStrategy (issue #198)。
   *
   * Yahoo Finance daily bars を取って `runBacktest` に流し込み、結果 JSON を
   * 返す。POC で `pullback_default_*` の妥当性を data-driven に評価するための
   * tool — 実発注は **しない** (純粋計算)。
   *
   * Query:
   *   - `symbol`         (required)  e.g. AAPL / 7203
   *   - `from`, `to`     (required)  ISO date "YYYY-MM-DD"
   *   - `initialCash`    (optional)  default 10000
   *   - `stopPct`, `takeProfitPct`, `timeStopDays`, `pullbackMax`,
   *     `pullbackMin`, `minReturn50d`, `kAtr` (optional)  global_config 既定
   *     を override
   *
   * 返り値は `BacktestResult` をそのまま JSON 化したもの。in-memory only、
   * D1 永続化は別 PR (issue #198 の `backtest_run` / `backtest_trade`)。
   */
  .get('/backtest', async (c) => {
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
      stopPct: readOptionalNumber(
        c.req.query('stopPct'),
        'stopPct',
        global.pullbackDefaultStopPct,
        {},
      ),
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

    const params: BacktestParams = {
      symbol,
      from,
      to,
      initialCash,
      rule,
    }
    const result = await runBacktest(sliced, params)
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
   * Optional `?retryStateApply=1` mode (issue #142): also sweep
   * `broker_status='FILLED' AND state_applied_at IS NULL` rows that have
   * aged out of the cron lookback window. Use to manually unstick legacy
   * split-brain rows after deploying the marker columns.
   */
  .post('/orders/reconcile', async (c) => {
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
   * rows — i.e. the split-brain backlog that issue #142 tracks. A non-zero
   * `pendingApply` is the operator's signal to invoke
   * `POST /admin/orders/reconcile?retryStateApply=1`.
   *
   * Cheap (single COUNT(*) query) so safe to scrape from a dashboard. Does
   * not mutate state.
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
   * Reconcile broker-side holdings into the per-symbol DO `position`.
   *
   * Pulls Webull `/openapi/account/positions` once and walks the symbol
   * universe (or `?symbol=SOXL` for a single ticker), comparing the DO
   * `position.qty` against broker `available_quantity`. When they disagree
   * the DO row is overwritten via the same `overridePosition` path used by
   * `/admin/symbol-state/:symbol/override-position` — one structured
   * `symbol_state_position_override` log per write plus an outer
   * `holdings_sync_applied` log keyed by `requestId`.
   *
   * Use this as the manual recovery tool for DO state that drifted before
   * PR #215 (idempotency) / PR #221 (SELL fallback) landed. Both fixes
   * prevent **future** corruption but neither rewrites existing rows.
   *
   * Query:
   *   - `symbol`  (optional)  restrict to one ticker (case-insensitive)
   *   - `dryRun`  (optional)  `1`/`true`/`yes` → diff-only, no DO writes
   *   - `force`   (optional)  `1`/`true`/`yes` → bypass the "broker empty +
   *                            DO has positions" safe-fail guard. Use only
   *                            when the operator has *confirmed* the broker
   *                            is genuinely empty (e.g. liquidation) and
   *                            the DO rows are stale ghosts to be cleared.
   *
   * Body: ignored (POST kept for "this mutates state" intent — `dryRun`
   *   path obviously doesn't, but the verb stays consistent).
   */
  .post('/orders/sync-holdings', async (c) => {
    if (!c.env.SYMBOL_STATE) {
      throw new ValidationError('SYMBOL_STATE binding is not configured', { field: 'env' })
    }
    const symbolRaw = c.req.query('symbol')?.trim()
    const dryRun = parseTruthyQuery(c.req.query('dryRun'))
    const force = parseTruthyQuery(c.req.query('force'))
    const symbol = symbolRaw && symbolRaw.length > 0 ? symbolRaw.toUpperCase() : undefined

    // Single-symbol mode skips the universe load: lets the operator sync a
    // ticker even if it's been removed from `symbol_config` (e.g. retired
    // strategy that still has a stale DO row). All-symbols mode needs D1;
    // reject early so the operator gets 400-with-field instead of a 500
    // from deeper in `loadSymbolUniverse`.
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

    const webull = createWebullHttpClient(c.env)
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
   * by our parsers** — used to verify whether sandbox failures (#240 alert:
   * status 403 across US_STOCK / US_ETF) come from the broker side or our
   * client-side handling.
   *
   * Probes (in parallel):
   *   1. `GET /openapi/market-data/stock/snapshot` (with `x-version: v2`
   *      header — same combo as `WebullQuoteClient`) for `?symbol=`
   *      (default SOXL) + `?category=` (default US_ETF).
   *   2. `GET /openapi/account/positions` for the configured JP cash account.
   *
   * Each probe returns the same uniform shape regardless of phase:
   * `{ phase: 'response' | 'auth' | 'fetch', status, ok, bodyTruncated,
   *   bodyLength, msTaken, error }` with `null` for unavailable values
   * (auth phase: status / ok / body fields / msTaken all null; fetch phase:
   * status / ok / body fields null but msTaken set; response phase: error
   * null). Body is truncated to 4 kB to avoid log blowup on HTML error pages.
   *
   * Pre-condition: `WEBULL_API_BASE` / `WEBULL_APP_KEY` / `WEBULL_APP_SECRET`
   * / `WEBULL_ACCOUNT_ID_JP_CASH` must all be set (non-whitespace). Missing
   * env returns `400 ValidationError` with the missing var names listed —
   * "I forgot to set X" should never silently look like "broker rejected".
   *
   * Read-only: no DO writes, no D1 writes. Safe to call from operator browser.
   */
  .get('/broker/probe', async (c) => {
    const symbol = (c.req.query('symbol') ?? 'SOXL').trim().toUpperCase()
    const category = (c.req.query('category') ?? 'US_ETF').trim().toUpperCase()
    // 全 env var を trim、whitespace-only も "未設定" 扱い。silent な phase:'auth'
    // 返却 (CodeRabbit #243 初版の auto-fix) は ambiguous (ユーザが「設定したつ
    // もり」になる) なので、設定漏れ / 半角空白だけのケースは ValidationError で
    // 400 を返す ("正規の設定" のときだけ probe を走らせる)。
    const baseUrl = (c.env.WEBULL_API_BASE ?? '').trim()
    const appKey = (c.env.WEBULL_APP_KEY ?? '').trim()
    const appSecret = (c.env.WEBULL_APP_SECRET ?? '').trim()
    const accountId = (c.env.WEBULL_ACCOUNT_ID_JP_CASH ?? '').trim()
    const missingEnv: string[] = []
    if (baseUrl.length === 0) missingEnv.push('WEBULL_API_BASE')
    if (appKey.length === 0) missingEnv.push('WEBULL_APP_KEY')
    if (appSecret.length === 0) missingEnv.push('WEBULL_APP_SECRET')
    if (accountId.length === 0) missingEnv.push('WEBULL_ACCOUNT_ID_JP_CASH')
    // baseUrl は length > 0 でも http(s):// で parse できないと probeOnce 内の
    // `new URL(args.path, ${baseUrl}/)` が同期的に TypeError を吐いて 500 で
    // 落ちる。明示的に validate して 400 で返す方が運用視点で扱いやすい。
    if (baseUrl.length > 0) {
      let parsed: URL | null = null
      try {
        parsed = new URL(baseUrl)
      } catch {
        parsed = null
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        missingEnv.push('WEBULL_API_BASE (invalid: must be absolute http/https URL)')
      }
    }
    if (missingEnv.length > 0) {
      throw new ValidationError(
        `Webull env var(s) missing or invalid: ${missingEnv.join(', ')}`,
        { field: 'env' },
      )
    }

    // 全 phase で同じキーを返す uniform shape (CodeRabbit #243)。jq / curl から
    // 結果を比較・集計するときに「auth phase だけキーが少ない」状況を避ける。
    // 値が無い場合は null を入れ、`error` は response phase では null にする。
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
    }): Promise<ProbeResult> {
      const url = new URL(args.path, `${baseUrl}/`)
      for (const [k, v] of Object.entries(args.query)) url.searchParams.set(k, v)

      let headers: Record<string, string>
      try {
        headers = await buildSignedHeaders({
          method: args.method,
          path: url.pathname,
          query: args.query,
          host: url.host,
          appKey,
          appSecret,
          version: args.version,
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
          headers: { Accept: 'application/json', ...headers },
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

    const [quoteResult, positionsResult] = await Promise.all([
      // path は WebullQuoteClient.DEFAULT_QUOTE_PATH と一致させる:
      // /openapi/market-data/stock/snapshot (× /openapi/quotes/v2/...)。
      // v2 は path ではなく x-version ヘッダ。最初に書いたとき paste ミスで
      // /quotes/v2/ を path に入れてしまい、実 cron と違うパスを叩いてた。
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
      // version='v1' は WebullHttpClient.request が account ルートで送ってる
      // 固定値 (line 180)。accountId は probe 入口の missingEnv チェックで
      // 既に空文字 reject 済 → ここに到達した時点で必ず非空。
      probeOnce({
        method: 'GET',
        path: '/openapi/account/positions',
        query: { account_id: accountId },
        version: 'v1',
      }),
    ])

    // 診断 payload は raw broker レスポンスを含むので browser / 中間 cache に
    // 残させない (CodeRabbit #243)。ヘッダは json() 前に c.header() で付ける。
    c.header('Cache-Control', 'no-store')
    return c.json({
      timestamp: new Date().toISOString(),
      sandbox: baseUrl,
      input: { symbol, category, accountIdConfigured: accountId.length > 0 },
      quote: quoteResult,
      positions: positionsResult,
    })
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
  /**
   * EOD-ish rollover: snapshot `dailyStartEquity + dailyRealizedPnl` as the
   * new day's opening equity and zero out `dailyRealizedPnl`. Intended as a
   * manual / cron-triggered "close the day" step so the drawdown-kill gate
   * re-anchors against today's session rather than cumulative lifetime PnL.
   *
   * Returns both the before / after snapshot so an operator (or the eventual
   * EOD cron) can log the exact dollar delta that was rolled.
   */
  .post('/portfolio/roll-daily', async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      throw new ValidationError('PORTFOLIO_STATE binding is not configured', { field: 'env' })
    }
    const client = new PortfolioStateClient(c.env.PORTFOLIO_STATE)
    const { before, after } = await client.rollDaily()
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
      lastRolledAt: state.lastRolledAt,
      updatedAt: state.updatedAt,
    })
  })
  /**
   * Bulk seed `earnings_calendar` rows (issue #196 1/3)。POC では外部 API 連携を
   * 持たず、operator が手動で curl 経由で seed する。重複 (symbol × earnings_date)
   * は `INSERT OR IGNORE` で skip し、件数を返す。
   *
   * Body: `[{ symbol: "AAPL", earnings_date: "2026-04-30", notes?: "Q2" }, ...]`
   */
  .post('/earnings/seed', async (c) => {
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
      // 桁違いの誤入力を弾く。1 cron 環境で扱う universe は十数銘柄 × 4 半期分
      // (せいぜい 100 行) を想定。
      throw new ValidationError('body cannot exceed 1000 entries per request', { field: 'body' })
    }
    const records: EarningsCalendarSeedInput[] = []
    body.forEach((raw, idx) => {
      records.push(parseEarningsSeedRow(raw, idx))
    })
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const result = await repo.bulkUpsert(records)
    return c.json({ inserted: result.inserted, skipped: result.skipped, total: records.length })
  })
  /**
   * Read `earnings_calendar` rows for a symbol (operator inspect)。`?symbol=AAPL`
   * 必須。NULL / 0 件でも 200 を返す (空配列)。
   */
  .get('/earnings', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const symbol = readRequiredParam(c.req.query('symbol'), 'symbol').toUpperCase()
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const rows = await repo.fetchBySymbol(symbol)
    return c.json({ symbol, rows })
  })
  /**
   * Delete a single earnings row by `id`。誤 seed の取り消し用。404 if not found。
   */
  .delete('/earnings/:id', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const idRaw = c.req.param('id').trim()
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError("'id' must be a positive integer path param", { field: 'id' })
    }
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const ok = await repo.deleteById(id)
    if (!ok) {
      return c.json({ error: 'earnings_row_not_found', id }, 404)
    }
    return c.json({ deleted: true, id })
  })
  /**
   * Bulk seed `macro_event_calendar` rows (issue #196 2/3)。POC では外部 API
   * 連携を持たず、operator が手動で curl 経由で seed する。重複 (event_type ×
   * event_date) は `INSERT OR IGNORE` で skip し、件数を返す。
   *
   * Body: `[{ event_type: "FOMC", event_date: "2026-06-17",
   *           event_time?: "14:00", notes?: "June FOMC" }, ...]`
   */
  .post('/macro-events/seed', async (c) => {
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
      // POC では年 50 件 (FOMC + CPI + NFP + ...) × 数年で十分上限。桁違いの
      // 誤入力を弾く目的。
      throw new ValidationError('body cannot exceed 1000 entries per request', { field: 'body' })
    }
    const records: MacroEventCalendarSeedInput[] = []
    body.forEach((raw, idx) => {
      records.push(parseMacroEventSeedRow(raw, idx))
    })
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const result = await repo.bulkUpsert(records)
    return c.json({ inserted: result.inserted, skipped: result.skipped, total: records.length })
  })
  /**
   * Read `macro_event_calendar` rows (operator inspect)。`?from`/`?to` は
   * いずれも YYYY-MM-DD で optional。`?type` で event_type filter (大文字化)。
   */
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
      // `?from=2026-07-10&to=2026-07-01` のような operator 入力ミスを 400 で
      // 弾く (空配列 200 だと「データなし」と区別がつかないため)。
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
  /**
   * Delete a single macro event row by `id`。誤 seed の取り消し用。
   */
  .delete('/macro-events/:id', async (c) => {
    if (!c.env.DB) {
      throw new ValidationError('DB binding is not configured', { field: 'env' })
    }
    const idRaw = c.req.param('id').trim()
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError("'id' must be a positive integer path param", { field: 'id' })
    }
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const ok = await repo.deleteById(id)
    if (!ok) {
      return c.json({ error: 'macro_event_row_not_found', id }, 404)
    }
    return c.json({ deleted: true, id })
  })

/**
 * Validate a single `/admin/macro-events/seed` body entry。
 *
 *   - `event_type`: 1〜32 chars, `[A-Z0-9_]` のみ (大文字化前提) — operator が
 *     'FOMC' / 'CPI' / 'NFP_REV' のような短い記号で seed する想定
 *   - `event_date`: ISO 'YYYY-MM-DD' で round-trip validation (`isYmd`)
 *   - `event_time` (optional): `HH:MM` (00:00〜23:59 のみ受理)。null / 省略 OK
 *   - `notes` (optional): 256 chars 上限
 */
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

/**
 * 'FOMC' / 'CPI' / 'NFP' 等の短い event_type 記号として受理可能か。
 * 1〜32 chars、`[A-Za-z0-9_]` のみ (大文字化は呼び出し側で行う)。
 */
function isMacroEventType(value: string): boolean {
  return /^[A-Za-z0-9_]{1,32}$/.test(value)
}

/**
 * 'HH:MM' (00:00〜23:59) として受理可能か。秒は持たない (POC では分単位で十分)。
 */
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

/**
 * Parse the `/admin/symbol-state/:symbol/override-position` body. Strict so
 * an operator typo in qty / avgPrice / reason gets a 400 instead of silently
 * writing a malformed position into the DO.
 *
 *   - `qty`: finite >= 0 (0 = close)
 *   - `avgPrice`: finite > 0 when `qty > 0`; ignored when `qty=0` but we
 *     still type-check to surface stray fields
 *   - `openedAt`: ISO 8601 timestamp string OR null OR omitted (→ null)
 *   - `reason`: required, 1..256 chars (mandatory audit context)
 */
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
    // qty=0 close: avgPrice irrelevant. Tolerate but still validate type so
    // a stray string doesn't get silently accepted.
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
 * `YYYY-MM-DD` の文法チェック + **実在しない日付の弾き**。`Date` の自動
 * normalize ('2026-02-30' → '2026-03-02') を逆手に取り、parse 後の Date を
 * 同じ形式で書き戻して入力と一致するか比較する。これで `2026-02-30` や
 * `2026-13-01` が DB に保存される事故を防ぐ (CodeRabbit #196 review)。
 */
function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  const roundTrip = new Date(ms).toISOString().slice(0, 10)
  return roundTrip === value
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