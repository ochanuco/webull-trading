import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { ValidationError } from '../shared/errors'
import { createWebullHttpClient } from '../infrastructure/webull/WebullHttpClient'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import { reconcileFills } from '../trading/reconciliation/reconcileFills'
import { runStrategyCron } from '../trading/strategy/runStrategyCron'
import { YahooBarClient } from '../infrastructure/quotes/YahooBarClient'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../infrastructure/db/schema'
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
  type EarningsCalendarSeedInput,
} from '../infrastructure/calendar/earningsCalendarRepo'
import { runBacktest, type BacktestParams } from '../trading/backtest/runBacktest'
import type { SymbolRule } from '../trading/strategy/strategies/PullbackUptrendStrategy'

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

    const global = await loadGlobalConfigFrom(c.env)
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