import { sql } from 'drizzle-orm'
import { check, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * append-only trade decision / order lifecycle log. A single row per logical
 * event (`decision` → `intent` → `pre_submit` → `post_submit` → `fill` /
 * `exit`). Column shape is intentionally flat — schema mirrors
 * {@link TradeJournalRecord} in src/infrastructure/logger/tradeJournal.ts
 * so we can straight-map records into rows without adapter logic.
 *
 * 振り返り用 SELECT 例は docs/db-operations.md 参照。
 */
export const tradeJournal = sqliteTable('trade_journal', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull(),
  tradeEventType: text('trade_event_type').notNull(),
  requestId: text('request_id'),
  clientOrderId: text('client_order_id'),
  orderId: text('order_id'),
  symbol: text('symbol'),
  strategyName: text('strategy_name'),
  signalAction: text('signal_action'),
  signalReason: text('signal_reason'),
  riskAllowed: integer('risk_allowed', { mode: 'boolean' }),
  riskReasons: text('risk_reasons'),
  side: text('side'),
  quantity: real('quantity'),
  limitPrice: real('limit_price'),
  notional: real('notional'),
  latencyMs: real('latency_ms'),
  brokerStatus: text('broker_status'),
  mode: text('mode'),
  submitted: integer('submitted', { mode: 'boolean' }),
  filledQty: real('filled_qty'),
  filledPrice: real('filled_price'),
  realizedPnl: real('realized_pnl'),
  holdDays: real('hold_days'),
  exitReason: text('exit_reason'),
  errorClass: text('error_class'),
  errorMessage: text('error_message'),
})

export type TradeJournalRow = typeof tradeJournal.$inferSelect
export type TradeJournalInsert = typeof tradeJournal.$inferInsert

/**
 * Per-symbol universe + trading policy. Replaces `ALLOWED_SYMBOLS` and
 * `SYMBOL_MAX_NOTIONAL` env vars so changes do not require redeploy. Operator
 * edits via `wrangler d1 execute "INSERT / UPDATE ..."`. See
 * docs/db-operations.md for recipes.
 *
 * `active = 0` で一時停止扱い (ALLOWED_SYMBOLS から外れる)。`max_notional`
 * が NULL なら global の MAX_ORDER_NOTIONAL 上限に丸める (fall-through)。
 */
export const symbolConfig = sqliteTable(
  'symbol_config',
  {
    symbol: text('symbol').primaryKey(),
    /** 人間可読な銘柄名 (例: "Direxion Daily Semiconductor Bull 3X"、トヨタ自動車)。運用時の識別用。 */
    name: text('name'),
    market: text('market').notNull(), // 'US' | 'JP'
    /**
     * 取引通貨 ISO 4217 ('USD' / 'JPY' ...)。notional を global cap と比較する時の
     * 基準。market と独立に持つのは将来 HKD ADR 等への拡張を見越してのこと。
     */
    currency: text('currency').notNull().default('USD'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    maxNotional: real('max_notional'),
    notes: text('notes'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    currencyEnum: check(
      'symbol_config_currency_enum',
      sql`${t.currency} IN ('USD', 'JPY')`,
    ),
  }),
)

export type SymbolConfigRow = typeof symbolConfig.$inferSelect
export type SymbolConfigInsert = typeof symbolConfig.$inferInsert

/**
 * Structurally anti-correlated pairs (SOXL/SOXS, TQQQ/SQQQ 等)。相手 symbol
 * で position を抱えている間の BUY を拒否するために使う (#38-A inverse-pair
 * correlation cap の env 置換)。
 *
 * 1 方向だけ書き込めば十分 — repo 側で bidirectional に展開する。
 */
export const inversePairs = sqliteTable('inverse_pairs', {
  symbol: text('symbol').primaryKey(),
  inverse: text('inverse').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type InversePairRow = typeof inversePairs.$inferSelect
export type InversePairInsert = typeof inversePairs.$inferInsert

/**
 * Singleton global risk / lifecycle config。`id = 'default'` の 1 行のみ。
 * 運用者が `wrangler d1 execute` で UPDATE して runtime 変更する (実発注
 * ON / drawdown 閾値 / kill-switch 等)。env var 側と完全一致のフィールド
 * を持ち、Worker 起動時に loadGlobalConfig で取得する。
 *
 * bridge_run_mode は 'auto' / 'always-on' / 'disabled' の文字列。
 * drawdown_kill_threshold は負の float (例: -0.02 = -2%)。
 */
export const globalConfig = sqliteTable(
  'global_config',
  {
    id: text('id').primaryKey(), // 'default' 固定
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
    tradingEnabled: integer('trading_enabled', { mode: 'boolean' }).notNull().default(false),
    marketHoursCheck: integer('market_hours_check', { mode: 'boolean' }).notNull().default(false),
    /** @deprecated Phase E で通貨別 cap に移行。互換のため残置、参照はしない。 */
    maxOrderNotional: real('max_order_notional').notNull().default(100),
    /** USD 銘柄 (currency='USD') の 1 注文上限。 */
    maxOrderNotionalUsd: real('max_order_notional_usd').notNull().default(2000),
    /** JPY 銘柄 (currency='JPY') の 1 注文上限。 */
    maxOrderNotionalJpy: real('max_order_notional_jpy').notNull().default(100000),
    /** 総資本 (USD)。NULL なら portfolio exposure check は skip。 */
    totalCapitalUsd: real('total_capital_usd'),
    /** 総資本 (JPY)。NULL なら portfolio exposure check は skip。 */
    totalCapitalJpy: real('total_capital_jpy'),
    /**
     * 同時保有エクスポージャー上限 = total_capital * max_portfolio_exposure_pct。
     * 両通貨共通で、各通貨の `open_exposure` が通貨別 `total_capital` の
     * この比率を超える新規 BUY は reject。
     */
    maxPortfolioExposurePct: real('max_portfolio_exposure_pct').notNull().default(0.6),
    drawdownKillThreshold: real('drawdown_kill_threshold').notNull().default(-0.02),
    staleQuoteMs: integer('stale_quote_ms').notNull().default(900000),
    gapRejectPct: real('gap_reject_pct').notNull().default(0.03),
    spreadLimitPctUs: real('spread_limit_pct_us').notNull().default(0.0025),
    spreadLimitPctJp: real('spread_limit_pct_jp').notNull().default(0.006),
    bridgeRunMode: text('bridge_run_mode').notNull().default('auto'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    // DB レベルで typo / 桁違いの UPDATE を弾く。上限値は POC としての上限
    // (例: 1 回の発注で $10M は明らかに誤入力) を想定。
    maxOrderNotionalRange: check(
      'global_config_max_order_notional_range',
      sql`${t.maxOrderNotional} > 0 AND ${t.maxOrderNotional} <= 10000000`,
    ),
    maxOrderNotionalUsdRange: check(
      'global_config_max_order_notional_usd_range',
      sql`${t.maxOrderNotionalUsd} > 0 AND ${t.maxOrderNotionalUsd} <= 1000000`,
    ),
    maxOrderNotionalJpyRange: check(
      'global_config_max_order_notional_jpy_range',
      sql`${t.maxOrderNotionalJpy} > 0 AND ${t.maxOrderNotionalJpy} <= 100000000`,
    ),
    totalCapitalUsdRange: check(
      'global_config_total_capital_usd_range',
      sql`${t.totalCapitalUsd} IS NULL OR ${t.totalCapitalUsd} > 0`,
    ),
    totalCapitalJpyRange: check(
      'global_config_total_capital_jpy_range',
      sql`${t.totalCapitalJpy} IS NULL OR ${t.totalCapitalJpy} > 0`,
    ),
    maxPortfolioExposurePctRange: check(
      'global_config_max_portfolio_exposure_pct_range',
      sql`${t.maxPortfolioExposurePct} > 0 AND ${t.maxPortfolioExposurePct} <= 1`,
    ),
    drawdownKillThresholdRange: check(
      'global_config_drawdown_kill_threshold_range',
      sql`${t.drawdownKillThreshold} >= -1 AND ${t.drawdownKillThreshold} <= 0`,
    ),
    staleQuoteMsRange: check(
      'global_config_stale_quote_ms_range',
      sql`${t.staleQuoteMs} >= 0`,
    ),
    gapRejectPctRange: check(
      'global_config_gap_reject_pct_range',
      sql`${t.gapRejectPct} >= 0 AND ${t.gapRejectPct} <= 1`,
    ),
    spreadLimitPctUsRange: check(
      'global_config_spread_limit_pct_us_range',
      sql`${t.spreadLimitPctUs} >= 0 AND ${t.spreadLimitPctUs} <= 1`,
    ),
    spreadLimitPctJpRange: check(
      'global_config_spread_limit_pct_jp_range',
      sql`${t.spreadLimitPctJp} >= 0 AND ${t.spreadLimitPctJp} <= 1`,
    ),
    bridgeRunModeEnum: check(
      'global_config_bridge_run_mode_enum',
      sql`${t.bridgeRunMode} IN ('auto', 'always-on', 'disabled')`,
    ),
  }),
)

export type GlobalConfigRow = typeof globalConfig.$inferSelect
export type GlobalConfigInsert = typeof globalConfig.$inferInsert
