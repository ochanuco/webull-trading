import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../app'
import { rateLimit } from '../middleware/rateLimit'
import { ValidationError } from '../shared/errors'
import { createWebullReadClient } from '../infrastructure/webull/WebullReadClient'
import { refreshWebullToken } from '../infrastructure/webull/refreshWebullToken'
import {
  resolveAccessToken,
  resolveAccessTokenWithSource,
} from '../infrastructure/webull/resolveAccessToken'
import { WebullAuth } from '../infrastructure/webull/WebullAuth'
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
  updateSymbolConfig,
  isSymbolRole,
  MAX_ALTERNATIVES,
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
import type { SymbolRule } from '../trading/strategy/strategies/PullbackUptrendStrategy'

/**
 * Operator-only endpoints. Basic-auth-protected by the same middleware as
 * `/trade/*` at mount time. Use sparingly — these mutate DO state out-of-band
 * and should only be called for initial seeding or reconciliation.
 */
export const admin = new Hono<AppBindings>()
  /**
   * Production readiness preflight (#375-#380)。Read-only: D1 / DO / env の
   * 現在状態を集約し、live enablement 前に fail-closed で確認できるようにする。
   * Broker 実通信は `/admin/broker/probe` に分離し、ここでは発注経路に触れない。
   */
  .get('/production-readiness', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await collectProductionReadiness(c.env, c.get('requestId')))
  })
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
  /**
   * 強制的に cooldownUntil を過去時刻 (UNIX epoch 0) にして取引停止状態を解除する。
   * 直前損切後の cooldown (reconcileFills が設定) を staging で即解除したい時に
   * 使う。PositionStore.setCooldown は string 必須なので `new Date(0).toISOString()`
   * を渡すことで「過去」扱いにして実質クリア。
   */
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
  /**
   * Manual trigger for `runStrategyCron`. Returns the same `StrategyCronResult`
   * the hourly scheduled handler would console.log. Useful for debugging bar
   * fetch failures / skip reasons without waiting for :15 of the hour.
   *
   * Honours `global_config.dry_run` via runStrategyCron itself — does NOT
   * bypass. Protected by the same basic-auth as the rest of /admin/*.
   */
  .post('/strategy/run', rateLimit('ADMIN_WRITE'), async (c) => {
    const result = await runStrategyCron(c.env)
    return c.json(result)
  })
  /**
   * Runtime kill-switch toggle (issue #276)。`global_config.trading_enabled` を
   * 切替えて `trading_toggle_history` に append。dashboard 経由は
   * `application/x-www-form-urlencoded`、CLI 経由は JSON で受ける (Content-Type
   * で分岐)。dashboard form 後の挙動を素直にするため、form post には HTML 302
   * で `/dashboard` に戻す。
   *
   * Body (JSON or form): `{ enabled: boolean, reason: string }`
   *
   * `effective` フィールドで env override 適用後の値を返す: env=false なら DB
   * を true に書いても `effective=false` で運用者に「env override 効いてる」
   * を視認させる (saw-tooth な切替えで混乱する事故防止)。
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
      // Form 経由は dashboard に戻して銀行のような one-click 操作にする。
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
  .post('/orders/sync-holdings', rateLimit('ADMIN_WRITE'), async (c) => {
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
   * by our parsers** — used to verify whether sandbox failures (#240 alert:
   * status 403 across US_STOCK / US_ETF) come from the broker side or our
   * client-side handling.
   *
   * Probes (in parallel, #251 / #254 で旧/新 path 比較):
   *   1. `GET /openapi/market-data/stock/snapshot` (`x-version: v2`)
   *      for `?symbol=` (default SOXL) + `?category=` (default US_ETF).
   *   2. positions (旧): `GET /openapi/account/positions` (`x-version: v1`)
   *   3. positions (新): `GET /openapi/assets/positions` (`x-version: v2`)
   *   4. order history (旧): `GET /openapi/account/orders/history` (`v1`)
   *   5. order history (新): `GET /openapi/trade/order/history` (`v2`)
   *
   * Each probe returns the same uniform shape regardless of phase:
   * `{ phase: 'response' | 'auth' | 'fetch', status, ok, bodyTruncated,
   *   bodyLength, msTaken, error }` with `null` for unavailable values
   * (auth phase: status / ok / body fields / msTaken all null; fetch phase:
   * status / ok / body fields null but msTaken set; response phase: error
   * null). Body is truncated to 4 kB to avoid log blowup on HTML error pages.
   *
   * Pre-condition: `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID_JP_CASH`
   * must be set (non-whitespace). Missing returns `400 ValidationError` —
   * "I forgot to set X" should never silently look like "broker rejected".
   * `WEBULL_TRADE_API_BASE` / `WEBULL_QUOTES_API_BASE` は env 未設定なら JP
   * prod default (`api.webull.co.jp` / `data-api.webull.co.jp`) を使う (#21)。
   * UAT で叩く場合は env を explicit に投入する (ALB hostname を override)。
   *
   * Read-only: no DO writes, no D1 writes. Safe to call from operator browser.
   */
  .get('/broker/probe', async (c) => {
    const symbol = (c.req.query('symbol') ?? 'SOXL').trim().toUpperCase()
    const category = (c.req.query('category') ?? 'US_ETF').trim().toUpperCase()
    // instrument 照会用の反対側 category (CodeRabbit #462)。UI のティッカー推定が
    // ETF/STOCK を取り違えても判定が壊れないよう、両方を probe する。
    const altCategory = category.endsWith('_ETF')
      ? category.replace(/_ETF$/, '_STOCK')
      : category.replace(/_STOCK$/, '_ETF')
    // 全 env var を trim、whitespace-only も "未設定" 扱い。silent な phase:'auth'
    // 返却 (CodeRabbit #243 初版の auto-fix) は ambiguous (ユーザが「設定したつ
    // もり」になる) なので、設定漏れ / 半角空白だけのケースは ValidationError で
    // 400 を返す ("正規の設定" のときだけ probe を走らせる)。
    //
    // host 系 (WEBULL_TRADE_API_BASE / WEBULL_QUOTES_API_BASE) は env 未設定なら
    // JP prod default (#21) を使うので missing チェック対象外。env が explicit に
    // セットされてる時のみ URL format を validate する。
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
    // base URL は length > 0 でも http(s):// で parse できないと probeOnce 内の
    // `new URL(args.path, ${baseUrl}/)` が同期的に TypeError を吐いて 500 で
    // 落ちる。明示的に validate して 400 で返す方が運用視点で扱いやすい。
    // env が explicit にセットされてる値だけチェック (default 値は format 保証済)。
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

    // #21 Phase B: DO or env 由来の `x-access-token` を resolve。NORMAL token が
    // あれば全 probe call に乗せる (none なら省略、broker が 401 で発覚する)。
    // この probe は client factory を経由せず buildSignedHeaders を直接呼んでた
    // ため Phase B 直後は seed しても 401 が消えないバグだった (PR #329)。
    // 診断ラベル (source / length) を probe response に乗せて「token が乗ったが
    // broker が reject」と「そもそも token が未配信」を切り分け可能にする。
    const tokenResolved = await resolveAccessTokenWithSource(c.env)
    const accessToken = tokenResolved.token

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
      /** POST body (JSON 文字列)。署名対象に含める (place/preview 系)。 */
      body?: string
      /**
       * 既定は trade host (`WEBULL_TRADE_API_BASE`)。snapshot probe は quotes host
       * (`WEBULL_QUOTES_API_BASE`) を明示的に渡す — JP 本番では data-api 系に
       * 分離されてるため。
       */
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

    /**
     * Yahoo Finance 経由の同 symbol snapshot probe (#21 follow-up)。`probeOnce`
     * と同じ uniform shape を返すが auth/signing 不要なので fetch を直接叩く。
     * Yahoo は JP 銘柄に `.T` suffix を付ける convention (YahooBarClient/QuoteClient と同じ)。
     */
    async function probeYahooSnapshot(symbolForProbe: string): Promise<ProbeResult> {
      // JP 判定は `toYahooSymbol` に一本化 (CodeRabbit #334)。re-implement すると
      // YahooBarClient / YahooQuoteClient の convention 変更時にズレる。
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
            // Yahoo は anonymous request を 429 で返すので browser-like UA を付ける。
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

    // #251 / #254: drift 検証のため旧 path (v1) と 新 path (v2) を **並列** で
    // 叩いて比較する。各セクションを result 配列の object として返却:
    //   - quote (path 共通、v2 ヘッダ): 既存
    //   - positions: old=/openapi/account/positions+v1 vs new=/openapi/assets/positions+v2
    //   - orderHistory: old=/openapi/account/orders/history+v1 vs new=/openapi/trade/order/history+v2
    // dashboard UI は 旧 (= positions) を保有銘柄リスト描画に使うので shape は
    // 後方互換維持 (`positions` field 名据え置き)、新 path 結果は追加 field。
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
    ] = await Promise.all([
      // path は WebullQuoteClient.DEFAULT_QUOTE_PATH と一致:
      // /openapi/market-data/stock/snapshot (× /openapi/quotes/v2/...)。
      // v2 は path ではなく x-version ヘッダ。
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
        // JP 本番は trade と quotes が別ホスト (`data-api.webull.co.jp`)。
        // JP UAT (ALB) では同じ URL が入るので no-op。
        host: quotesBaseUrl,
      }),
      // Yahoo Finance を quote 用 backup source として probe (#21 follow-up)。
      // 現状 strategy cron の default 経路でもあり、Webull JP の market-data API
      // が稼働開始する前まで主軸を担う。auth/signing は不要なので probeOnce ではなく
      // 直接 fetch する小 helper を呼ぶ。
      probeYahooSnapshot(symbol),
      // OLD: WebullHttpClient.getPositions (現行 cron が叩く path + v1)
      probeOnce({
        method: 'GET',
        path: '/openapi/account/positions',
        query: { account_id: accountId },
        version: 'v1',
      }),
      // NEW: 新 OpenAPI docs の path + v2 (x-access-token 必須化の可能性は
      // 別 issue #258 で評価、本 probe は signing 周りは現行と同じ buildSignedHeaders)
      probeOnce({
        method: 'GET',
        path: '/openapi/assets/positions',
        query: { account_id: accountId },
        version: 'v2',
      }),
      // OLD: 現行 findOrderByClientId が叩く path + v1。
      // page_size は broker 側の制約で 10-100 のみ受理 (`5` だと 417
      // OAUTH_OPENAPI_PARAM_ERR、see #251 follow-up)。
      probeOnce({
        method: 'GET',
        path: '/openapi/account/orders/history',
        query: { account_id: accountId, page_size: '10' },
        version: 'v1',
      }),
      // NEW: 新 OpenAPI docs の trade/order/history + v2
      probeOnce({
        method: 'GET',
        path: '/openapi/trade/order/history',
        query: { account_id: accountId, page_size: '10' },
        version: 'v2',
      }),
      // #415 buying-power: Account Balance endpoint の path/version/レスポンス項目を
      // 確定するための probe (doc: /api-doc/trade/account/account-balance)。positions が
      // account/*(v1)→assets/*(v2) で drift した実績を踏まえ候補を並列で叩く。どれが
      // 200 + buying-power フィールドを返すかで本実装の path/version/DTO を決める。
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
      // #461: instrument 照会 (銘柄が Webull に登録されているか)。
      // **JP の正しい path は `/openapi/instrument/stock/list`** (JP docs
      // Trading API > Get Stock Instrument)。汎用 SDK の `/instrument/list` とは
      // drift しており (#251 と同パターン)、HK 専用の `/trade/security` は JP に
      // 存在しない。host (trade / quotes) は docs に明記が無いので両方 probe。
      // category は UI のティッカー推定が ETF/STOCK を取り違え得るため
      // (CodeRabbit #462) 反対側 category も probe する。
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
      // 汎用 SDK path (`/instrument/list`) も比較用に残す — data-api が将来
      // 稼働したときに JP がどちらの path を採るかの drift 検証 (#251 方式)。
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
    ])

    // #461 follow-up: **Preview Order = 発注しない注文検証** (JP docs 正式記載:
    // POST /openapi/account/orders/preview)。発注パイプラインの検証 (取扱外
    // 銘柄の TICKER_IS_DENY を含む) を、注文を作らずに引ける唯一の documented
    // API。POST なので通常 probe では叩かず、UI の明示ボタン (query preview=1)
    // でのみ実行する。body は production の place order と同じ mapper を使い
    // (qty=1 の BUY、limit cap は Yahoo 価格 or 100)、**path は place ではなく
    // preview に固定** — 注文は作成されない。
    let previewVariants: Array<{ label: string; result: ProbeResult }> | null = null
    if (c.req.query('preview') === '1') {
      const priceRaw = Number(c.req.query('price'))
      const previewPrice = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : 100
      // category の typo を US に黙って丸めない (CodeRabbit #466) — preview は
      // 表示と保存可否に直結するので許容値以外は 400。
      if (!/^(US|JP)_(STOCK|ETF)$/.test(category)) {
        throw new ValidationError(`unsupported category for preview: ${category}`, {
          field: 'category',
        })
      }
      const market = (category.startsWith('JP_') ? 'JP' : 'US') as 'US' | 'JP'
      // body shape 候補は form チェック (#461 tradabilityCheck) と共有。
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

    // 診断 payload は raw broker レスポンスを含むので browser / 中間 cache に
    // 残させない (CodeRabbit #243)。ヘッダは json() 前に c.header() で付ける。
    c.header('Cache-Control', 'no-store')
    return c.json({
      timestamp: new Date().toISOString(),
      sandbox: { trade: baseUrl, quotes: quotesBaseUrl },
      input: { symbol, category, accountIdConfigured: accountId.length > 0 },
      // #21 token diagnostic: source ('do_normal' なら DO 由来 NORMAL token を
      // 使った正常 path / 'env' は Phase A fallback / 'none' は token なし
      // = broker は INVALID_TOKEN を返す)。length は値の長さだけで plaintext は
      // 出さない (browser cache / log 経由の漏洩防止)。
      accessToken: {
        source: tokenResolved.source,
        length: accessToken?.length ?? 0,
        doStatus: tokenResolved.doStatus ?? null,
      },
      // #21 app_key diagnostic: staging / production の WEBULL_APP_KEY が
      // 手元 1Password 値と一致してるかを確認するための head 6 文字 (32 文字 hex
      // の先頭 6 文字は十分公開しても安全)。token と app_key が違う app に紐付く
      // と broker が INVALID_TOKEN を返すため、operator が手元値と並べて確認できる
      // ようにする。
      appKey: {
        length: appKey.length,
        head: appKey.slice(0, 6),
      },
      quote: quoteResult,
      // 後方互換: dashboard UI が `positions` を保有銘柄リスト描画に使うので
      // 旧 path 結果を従来通り返す。
      positions: positionsOld,
      // 新 OpenAPI docs ベースの結果。drift 比較に使う。
      positionsNew,
      orderHistoryOld,
      orderHistoryNew,
      // #415 buying-power: Account Balance endpoint 候補の probe 結果。どれが 200 +
      // buying-power フィールドを返すかで本実装の path/version/DTO を確定する。
      balanceAccountV1,
      balanceAssetsV2,
      balanceAssetsAccountV2,
      // Yahoo Finance 経由の同 symbol snapshot (#21 follow-up)。Webull の data-api
      // が応答しない状況での代替経路の生死を可視化する。
      quoteYahoo: quoteYahooResult,
      // #461: instrument 照会 (Webull 取扱の事前チェック近似)。quotes / trade の
      // 両 host 候補。UI は 200 が返った側を採用して判定カードを出す。
      instrumentStockTrade,
      instrumentStockTradeAlt,
      instrumentStockQuotes,
      instrumentStockQuotesAlt,
      instrumentQuotesHost,
      instrumentTradeHost,
      previewVariants,
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
  /**
   * #415: 口座買付余力の軽量 JSON。dashboard (ホーム / 銘柄設定) が client-side
   * fetch して表示する用 (broker/probe と同じく credentials: 'same-origin' で
   * CF Access cookie を流用)。live token が無い / broker エラーは fail-safe で
   * `status:'unavailable'` を返し、ページ描画は壊さない。通貨別 buying_power を
   * そのまま返す (FX 換算はせず、表示側で通貨別に出す)。
   */
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
   * #21 Phase B: `WebullTokenStateDO` operator endpoints。
   *
   * - GET /webull-token        : 現在の状態 metadata を返す (token plaintext は返却しない)
   * - POST /webull-token/seed  : operator が `pnpm run issue-token` で取得した NORMAL token を投入
   * - POST /webull-token/refresh: 手動 refresh トリガー (cron 待たずに更新)
   */
  .get('/webull-token', async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      throw new ValidationError('WEBULL_TOKEN_STATE binding is not configured', { field: 'env' })
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    const state = await store.getState()
    // token plaintext は返さない (audit log / browser cache / screenshot に
    // 漏れないため)。head/tail だけ表示して operator が「どの token か」を
    // 識別できれば十分。さらに browser / intermediary cache にも残らない
    // よう Cache-Control: no-store (CodeRabbit #326)。
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
    // operator が貼り付けた token が本当に NORMAL かを broker 側で再確認してから DO に保存。
    // (Phase A の issue-token script では verify 済だが、time-of-check vs time-of-use の
    // ズレを締めるため。期限切れ間近の token を seed されても弾ける)
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
    // 監査ログには token plaintext は含めず metadata のみ (CodeRabbit #326)。
    // 「誰がいつ seed したか」が requestId / actor 付きで D1 に残る。
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
    // force=true で「期限まで余裕あるからスキップ」のロジックを bypass。
    const summary = await refreshWebullToken(c.env, { force: true })
    // 監査ログ: 手動 refresh が走った事実 (とその結果) を残す (CodeRabbit #326)。
    // token plaintext は出さず、status と時刻だけ before/after に積む。
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
      // before/after の token plaintext は返さない (上記 GET と同じ理由)。
      // status / 時刻のみ。
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
  .get('/orders/:clientOrderId', async (c) => {
    const clientOrderId = c.req.param('clientOrderId').trim()
    if (clientOrderId.length === 0) {
      throw new ValidationError('clientOrderId must be non-empty', { field: 'clientOrderId' })
    }
    // #139: operator can opt into a bounded deep-lookup sweep via query
    // params. Default behaviour (no params) is the prior single-page lookup.
    // `maxPages` is hard-capped at 20 so a typo / abuse can't fan out into a
    // huge broker batch — 20 * 50 = 1000 rows is plenty for ops use.
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
    // 総資産チャート (`/dashboard/portfolio`) 用の時系列スナップショット。
    // PortfolioStateDO は通貨を区別しない単一値 (慣例的 USD) なので USD カラムに
    // 書き込み、JPY は per-currency split が入るまで NULL。書込失敗で handler
    // 本体は止めない (audit と同じ姿勢 — DO 状態変更は既に成立済)。
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
   * Bulk seed `earnings_calendar` rows (issue #196 1/3)。POC では外部 API 連携を
   * 持たず、operator が手動で curl 経由で seed する。重複 (symbol × earnings_date)
   * は `INSERT OR IGNORE` で skip し、件数を返す。
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
   * Bulk seed `macro_event_calendar` rows (issue #196 2/3)。POC では外部 API
   * 連携を持たず、operator が手動で curl 経由で seed する。重複 (event_type ×
   * event_date) は `INSERT OR IGNORE` で skip し、件数を返す。
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
   * symbol_config CRUD (#292) — UI からの form POST 用 endpoint 群。
   *
   * `/admin/symbol-config`               INSERT (重複 symbol は 409)
   * `/admin/symbol-config/:symbol/update` 全列 UPDATE
   * `/admin/symbol-config/:symbol/toggle-active` active 1↔0
   * `/admin/symbol-config/:symbol/delete` soft delete (active=false; hard delete はしない)
   *
   * いずれも `rateLimit('ADMIN_WRITE')` + `writeAuditLog` を経由する。
   * dashboard form (application/x-www-form-urlencoded) からの POST を想定し、
   * 成功時は 303 redirect で `/dashboard/symbols` に戻す (PRG)。JSON body も
   * 同じ shape で受理し、JSON Accept (= ヘッダ無し) の場合は 200 JSON を返す。
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

    // #315: inverse_symbol が指定されたら bull/bear を対で登録する (連動登録)。
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
    // path の :symbol を強制し、body symbol は無視 (path が source of truth)。
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
    // #315: half-pair を残さないよう inverse_pairs のリンクも cascade 削除
    // (相手の symbol_config 行は残す)。symbol_config 削除成功後に実行。
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
   * 予算配分% の一括更新 (#budget-alloc ラダー)。一覧の各 slider が
   * `pct_<SYMBOL>` field を送り、「確定」押下で全銘柄まとめて更新する
   * (確定するまでは client 側で仮調整)。値は % (0-100)、空 / 0 → NULL
   * (= risk-% sizing)。インバース対は片側でも UI が同期するので両側送られる
   * 想定だが、server 側でも相手を同値に揃える防御を入れる (JS off 耐性)。
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
    // pct_<SYMBOL> を集約 (大文字正規化、% → fraction、空/0 → null)。
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
    // インバース対の同値同期 (両側 desired にある場合は UI 値を尊重、片側のみなら相手も揃える)。
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
   * symbol search (live autocomplete + form auto-fill 用)。
   *
   * Yahoo Finance の public search endpoint を proxy する。query (`?q=AA` 等) の
   * 部分マッチで複数候補を返す。JP 判定 (4 桁数字 → `.T` 付け足し) は
   * server 側で行い、quotes は market / currency 推測込みで返す。
   *
   * Yahoo 障害時は `matches: []` を返して client は手動入力に fallback。
   * Access auth + ADMIN_WRITE rate-limit を通る。
   */
  /**
   * 銘柄の Webull JP 取扱チェック (#461)。登録フォームが symbol 選択時に呼ぶ。
   * Preview Order (発注しない注文検証) で TICKER_IS_DENY を発注前に引く。
   * 'denied' のみ登録ブロック対象 — 'error' / 'unavailable' は通す (check 不能で
   * 全登録が止まるのは過剰 fail-closed。発注側には #460 の事後ガードがある)。
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
    const priceRaw = Number(c.req.query('price'))
    const result = await checkTradability(c.env, {
      symbol: symbolRaw,
      market,
      ...(Number.isFinite(priceRaw) && priceRaw > 0 ? { price: priceRaw } : {}),
    })
    return c.json(result)
  })
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
          // `.T` suffix の銘柄は JP 扱い、それ以外は US (Yahoo の他取引所は将来拡張)
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
   * #77 portfolio exposure gate: operator-supplied baseline for
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

/**
 * `/admin/trading/toggle` の body parser (issue #276)。JSON / form 双方を受け、
 * `enabled` (boolean) と `reason` (1..256 chars) を strict に validate する。
 * form value は string で渡るため "true"/"false"/"1"/"0"/"on" を許容。
 */
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
    // form post は string で来る。dashboard form は 'true' / 'false' を送るので
    // それを正規ケースに、CLI ミス防止に 'on' (HTML checkbox 流儀) も許容。
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
 * (#139)
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

/**
 * 状態変更系 admin POST 用の audit log writer (#274)。基本認証 user を header
 * から抽出し `recordChange` で diff 1 行を書く。`env.DB` が無い / D1 が落ちて
 * いるケースは log を skip (handler 本体の状態変更は既に成立しているため、
 * audit の欠落で 500 を返したくない)。before == after は recordChange 側で
 * no-op skip される。
 */
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

/**
 * `client.getState(symbol)` を safe wrap。stub に getState が無い (legacy fake)
 * / DO 呼び出しが throw した場合は `null` を返す — audit ログの before snapshot
 * が取れないだけで、handler 本体の状態変更は止めない。
 */
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
 * symbol_config CRUD UI (#292) で受け付ける form/JSON body を共通化して
 * 解析する。dashboard form は application/x-www-form-urlencoded、CLI は JSON
 * を送る想定。
 *
 *   - symbol: 1〜10 chars、英数字 (`[A-Za-z0-9]`)。JP の 4 桁数字 (e.g. `1570`)
 *     も合法。upper-case で正規化する。
 *   - market: 'US' | 'JP'
 *   - currency: 'USD' | 'JPY' (DB CHECK 制約と一致)
 *   - active: boolean (form では 'true'/'false'/'on' を許容、checkbox の 'on'
 *     → true、未送信 → false で扱う)
 *   - maxNotional: 正の数 or null (空文字 → null)
 *   - name / notes: optional string、256 chars 上限
 */
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
    alternatives?: unknown
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
  // form の checkbox は未送信時に key 自体が来ない (= undefined)。dashboard
  // form は hidden input で `active=false` を必ず送る運用にするが、未送信は
  // 安全側に false (= disabled) で受ける。
  const active = parseFormBool(raw.active, false)
  const maxNotionalRaw = raw.max_notional ?? raw.maxNotional
  const maxNotional = parseOptionalPositiveNumber(maxNotionalRaw, 'maxNotional')
  const name = parseOptionalString(raw.name, 'name')
  const notes = parseOptionalString(raw.notes, 'notes')
  // Per-symbol pullback override (#316)。空文字 / undefined → NULL (= global
  // default fall-through)。範囲外は ValidationError、DB CHECK と二重防御。
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
  // 予算配分: form は **% (0.1<=pct<=100)** で送る。fraction (0.001<=pct<=1) に変換して
  // 保存 (#budget-alloc)。空 / undefined → NULL (= 従来の risk-% sizing)。下限は UI の
  // 表示丸め (0.1% 刻み) / slider (5% 刻み) と揃え、sub-0.1% の保持崩れを防ぐ
  // (CodeRabbit #405)。範囲外は 400。
  const budgetAllocPctRaw = parseOptionalNumberInRange(
    raw.budget_alloc_pct ?? raw.budgetAllocPct,
    'budgetAllocPct',
    0.1,
    100,
  )
  const budgetAllocPct = budgetAllocPctRaw === null ? null : budgetAllocPctRaw / 100
  // 売買単位は **入力必須** (空欄/未指定はエラー)。fallback しない (#symbol-lot-size)。
  // 整数 1-100000 (JP 個別株=100 / ETF=1 / US=1 を想定、上限は防御的に広め)。
  const lotSize = parseRequiredIntegerInRange(raw.lot_size ?? raw.lotSize, 'lotSize', 1, 100_000)
  // stop/TP override (#exit-atr): form は **% (符号付き)** で送る。fraction に変換して保存。
  // 空 / undefined → NULL (= global default)。stop は負 (-99..-0.1%)、TP は正 (0.1..100%)。
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
  // intraday-only (#intraday-only): checkbox 未送信は false。active と同じ form bool 解釈。
  const intradayOnly = parseFormBool(raw.intraday_only ?? raw.intradayOnly, false)
  // role (#452 Layer 1): 空 / undefined → NULL (= 従来挙動)。enum 外は 400 —
  // typo した role を黙って従来挙動に倒さない (fail-closed の入口防御)。
  const role = parseSymbolRole(raw.role)
  // entry gate override (#452 Layer 2a): form は押し目/トレンド/過伸長を **%**、
  // ATR 比を ratio 生値で送る。fraction に変換して保存。空 / undefined → NULL
  // (= role preset → global default の fall-through)。
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
  // 押し目バンドの cross-check: max (0 側) が min (深い側) より深いと entry が
  // 永久に成立しない。fail-closed 方向だが入力時点の typo はここで弾く。片側
  // だけの指定は global / preset と組むので判定しない (repo 側コメント参照)。
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
  const alternatives = parseAlternativesInput(raw.alternatives, symbol)
  // 条件連動配分 (#452 Layer 3): checkbox 未送信は false (= 従来挙動)。退避先は
  // ticker 文法 + self 参照禁止。空 → NULL (= 退避しない)。
  const entryRequired = parseFormBool(raw.entry_required ?? raw.entryRequired, false)
  const alwaysActive = parseFormBool(raw.always_active ?? raw.alwaysActive, false)
  const cashFallbackSymbol = parseCashFallbackSymbol(
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
    alternatives,
    entryRequired,
    alwaysActive,
    cashFallbackSymbol,
  }
}

/**
 * cash_fallback_symbol (#452): 空 / undefined → NULL。ticker 文法外・self 参照は
 * 400 (誤った退避先へ積み増す事故の入口防御)。
 */
function parseCashFallbackSymbol(value: unknown, selfSymbol: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ValidationError('cashFallbackSymbol must be a symbol string', {
      field: 'cashFallbackSymbol',
    })
  }
  const sym = value.trim().toUpperCase()
  if (sym === '') return null
  if (!/^[A-Z0-9]{1,10}$/.test(sym)) {
    throw new ValidationError(`cashFallbackSymbol is not a valid symbol: ${sym}`, {
      field: 'cashFallbackSymbol',
    })
  }
  if (sym === selfSymbol.toUpperCase()) {
    throw new ValidationError('cashFallbackSymbol cannot reference itself', {
      field: 'cashFallbackSymbol',
    })
  }
  return sym
}

/**
 * role (#452): 空文字 / undefined / null → null (= 従来挙動)。enum 外は 400。
 */
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

/**
 * 3 値 boolean (#452 require_above_sma50_override)。form select は '' (= global
 * default) / 'true' / 'false' を送る。それ以外は 400。
 */
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

/**
 * alternatives (#452、表示専用): form はカンマ/空白区切り text、JSON はその文字列
 * or 配列を送る。ticker 文法 ([A-Za-z0-9]{1,10}) 外の要素は 400。self 参照と
 * 重複は除去、上限 MAX_ALTERNATIVES 超過は 400。空 → null。
 */
function parseAlternativesInput(value: unknown, selfSymbol: string): string[] | null {
  if (value === undefined || value === null) return null
  let tokens: string[]
  if (Array.isArray(value)) {
    tokens = value.map((v) => {
      if (typeof v !== 'string') {
        throw new ValidationError('alternatives must be symbols', { field: 'alternatives' })
      }
      return v
    })
  } else if (typeof value === 'string') {
    tokens = value.split(/[\s,]+/)
  } else {
    throw new ValidationError('alternatives must be a string or array of symbols', {
      field: 'alternatives',
    })
  }
  const out: string[] = []
  for (const token of tokens) {
    const sym = token.trim().toUpperCase()
    if (sym === '') continue
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) {
      throw new ValidationError(`alternatives contains an invalid symbol: ${sym}`, {
        field: 'alternatives',
      })
    }
    if (sym === selfSymbol.toUpperCase()) continue
    if (!out.includes(sym)) out.push(sym)
  }
  if (out.length > MAX_ALTERNATIVES) {
    throw new ValidationError(`alternatives must have at most ${MAX_ALTERNATIVES} symbols`, {
      field: 'alternatives',
    })
  }
  return out.length > 0 ? out : null
}

/**
 * 必須 integer in [min,max]。空文字 / undefined / null は **エラー** (fallback
 * しない、#symbol-lot-size)。売買単位 lot_size の受け口。
 */
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

/**
 * `inverse_symbol` (連動登録用、任意) を抽出。未指定 / 空文字 → null (= 単一登録)。
 * 指定時は symbol と同じ正規化 (1-10 英数大文字) を通す。#315。
 */
function parseInverseSymbolField(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = (body as { inverse_symbol?: unknown; inverseSymbol?: unknown })
  const value = raw.inverse_symbol ?? raw.inverseSymbol
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return normalizeSymbol(value)
}

/**
 * 連動登録時の counterpart メタ (Yahoo lookup 由来、任意)。form の hidden field
 * `inverse_name` / `inverse_market` / `inverse_currency` を拾い、counterpart の
 * symbol_config に焼く (インバース銘柄名を一覧に出すため #315)。market/currency が
 * 不正値なら undefined を返し createSymbolPair 側で primary 継承に倒す。
 */
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

/**
 * Optional integer in [min,max]。空文字 / undefined / null → null (fall-through)。
 * 整数 (Number.isInteger) でない値は ValidationError。範囲外も ValidationError。
 * Per-symbol override (#316) で time_stop_days_override の受け口に使う。
 */
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

/**
 * Optional finite float in [min,max]。空文字 / undefined / null → null
 * (fall-through)。範囲外 / 非数値は ValidationError。Per-symbol override
 * (#316) で k_atr_override の受け口に使う。
 */
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
    // audit before/after に全設定列を含める (CodeRabbit #453)。ここに列が
    // 落ちていると admin API の row echo と監査差分から変更が見えなくなる。
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
    alternatives: row.alternatives,
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
