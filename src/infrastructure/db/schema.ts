import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Schema-level max for pullbackDefaultTimeStopDays. Exported so chart window
 * logic can stay consistent with DB constraint.
 */
export const MAX_TIME_STOP_DAYS = 365

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
  /**
   * ISO timestamp when the FILLED row was successfully applied to the DO
   * layer (SymbolStateDO position / PortfolioStateDO realized PnL / cooldown).
   * NULL means apply has not yet succeeded — either because broker_status is
   * not yet FILLED, or because a previous DO apply attempt threw.
   *
   * Acts as an idempotent-apply ledger for `reconcileFills`: rows where
   * `broker_status='FILLED' AND state_applied_at IS NULL` are picked up by
   * the next reconcile tick (or the `?retryStateApply=1` repair mode) and
   * re-attempted. Once stamped, the row is never re-applied, even if it is
   * re-selected.
   *
   * Closes the split-brain that issue #142 tracked: D1 row was marked FILLED
   * but the DO position never updated because the DO call threw between the
   * UPDATE and the apply.
   */
  stateAppliedAt: text('state_applied_at'),
  /**
   * Last DO-apply error message captured while attempting to apply this
   * FILLED row. NULL when apply has never failed (or has succeeded since the
   * last failure). Only useful in conjunction with `state_applied_at IS NULL`
   * — a non-NULL value with `state_applied_at` set means the most recent
   * attempt eventually succeeded after a prior failure.
   */
  stateApplyError: text('state_apply_error'),
  /**
   * Number of DO-apply attempts (success or failure). Bumped on every retry.
   * Used by ops to spot rows stuck in a retry loop (`attempts >> 1` with
   * `state_applied_at IS NULL` is an alert signal).
   */
  stateApplyAttempts: integer('state_apply_attempts').notNull().default(0),
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
    /**
     * 相関 bucket の粗タグ (例: 'semi' / 'us_large_cap' / 'jp_auto')。
     * 同一 bucket の open position 合計 notional を
     * `equity * global_config.bucket_exposure_pct` で clamp するために使う
     * (#23 Lane 3)。NULL / 空文字 / 空白のみは bucket 未分類扱い (gate 素通り)。
     */
    bucket: text('bucket'),
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
    // Pullback 戦略のデフォルト rule パラメタ。per-symbol は symbol_config 側で
    // 個別 override 予定 (未実装、fall-through でここの値が全銘柄に効く)。
    // DB 化の狙いは "tune するのに PR / deploy 不要" (#118)。
    pullbackDefaultStopPct: real('pullback_default_stop_pct').notNull().default(-0.04),
    pullbackDefaultTakeProfitPct: real('pullback_default_take_profit_pct').notNull().default(0.07),
    pullbackDefaultTimeStopDays: integer('pullback_default_time_stop_days').notNull().default(10),
    pullbackDefaultPullbackMax: real('pullback_default_pullback_max').notNull().default(-0.03),
    pullbackDefaultPullbackMin: real('pullback_default_pullback_min').notNull().default(-0.06),
    pullbackDefaultMinReturn50d: real('pullback_default_min_return_50d').notNull().default(0.08),
    pullbackDefaultRequireAboveSma50: integer('pullback_default_require_above_sma50', { mode: 'boolean' }).notNull().default(true),
    /**
     * ATR multiplier for vol-adaptive stop sizing。
     *   stopDistance = max(k_atr * atr20, |entry * stop_pct|)
     * POC 推奨域 1.5–2.5、default 2.0。
     */
    pullbackDefaultKAtr: real('pullback_default_k_atr').notNull().default(2.0),
    /**
     * Base risk fraction per trade (0.4% default)。drawdown scale を掛けた値が
     * pullbackSizing に渡る。#23 Lane 2。
     */
    riskBasePerTradePct: real('risk_base_per_trade_pct').notNull().default(0.004),
    /** drawdown がこの閾値 (負) 未満になると size を halfScaleFactor に。-0.05 既定。 */
    riskDdHalfThreshold: real('risk_dd_half_threshold').notNull().default(-0.05),
    /** drawdown がこの閾値 (負) 未満になると size を 0 に (halt)。-0.10 既定。 */
    riskDdHaltThreshold: real('risk_dd_halt_threshold').notNull().default(-0.10),
    /**
     * 同一 bucket (symbol_config.bucket) の open 合計 notional 上限を
     * `equity * bucket_exposure_pct` で算出 (#23 Lane 3)。POC default 0.30。
     */
    bucketExposurePct: real('bucket_exposure_pct').notNull().default(0.30),
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
    pullbackDefaultStopPctRange: check(
      'global_config_pullback_default_stop_pct_range',
      sql`${t.pullbackDefaultStopPct} < 0 AND ${t.pullbackDefaultStopPct} >= -1`,
    ),
    pullbackDefaultTakeProfitPctRange: check(
      'global_config_pullback_default_take_profit_pct_range',
      sql`${t.pullbackDefaultTakeProfitPct} > 0 AND ${t.pullbackDefaultTakeProfitPct} <= 1`,
    ),
    pullbackDefaultTimeStopDaysRange: check(
      'global_config_pullback_default_time_stop_days_range',
      sql`${t.pullbackDefaultTimeStopDays} > 0 AND ${t.pullbackDefaultTimeStopDays} <= ${MAX_TIME_STOP_DAYS}`,
    ),
    pullbackDefaultPullbackMaxRange: check(
      'global_config_pullback_default_pullback_max_range',
      sql`${t.pullbackDefaultPullbackMax} <= 0 AND ${t.pullbackDefaultPullbackMax} >= -1`,
    ),
    pullbackDefaultPullbackMinRange: check(
      'global_config_pullback_default_pullback_min_range',
      sql`${t.pullbackDefaultPullbackMin} <= 0 AND ${t.pullbackDefaultPullbackMin} >= -1`,
    ),
    pullbackDefaultMinReturn50dRange: check(
      'global_config_pullback_default_min_return_50d_range',
      sql`${t.pullbackDefaultMinReturn50d} >= -1 AND ${t.pullbackDefaultMinReturn50d} <= 10`,
    ),
    pullbackDefaultKAtrRange: check(
      'global_config_pullback_default_k_atr_range',
      sql`${t.pullbackDefaultKAtr} > 0 AND ${t.pullbackDefaultKAtr} <= 10`,
    ),
    // 相対関係を DB で縛る: min > max だと BUY 条件を満たす pullback 幅が
    // 空集合になり戦略が静かに停止する。runtime UPDATE の typo 防止。
    pullbackDefaultPullbackWindowOrder: check(
      'global_config_pullback_default_pullback_window_order',
      sql`${t.pullbackDefaultPullbackMin} <= ${t.pullbackDefaultPullbackMax}`,
    ),
    riskBasePerTradePctRange: check(
      'global_config_risk_base_per_trade_pct_range',
      sql`${t.riskBasePerTradePct} > 0 AND ${t.riskBasePerTradePct} <= 1`,
    ),
    riskDdHalfThresholdRange: check(
      'global_config_risk_dd_half_threshold_range',
      sql`${t.riskDdHalfThreshold} < 0 AND ${t.riskDdHalfThreshold} >= -1`,
    ),
    riskDdHaltThresholdRange: check(
      'global_config_risk_dd_halt_threshold_range',
      sql`${t.riskDdHaltThreshold} < 0 AND ${t.riskDdHaltThreshold} >= -1`,
    ),
    // halt (深) ≤ half (浅) の順序を強制。逆転すると runtime で throw するので
    // DB 側でも弾く。
    riskDdThresholdOrder: check(
      'global_config_risk_dd_threshold_order',
      sql`${t.riskDdHaltThreshold} <= ${t.riskDdHalfThreshold}`,
    ),
    bucketExposurePctRange: check(
      'global_config_bucket_exposure_pct_range',
      sql`${t.bucketExposurePct} > 0 AND ${t.bucketExposurePct} <= 1`,
    ),
  }),
)

export type GlobalConfigRow = typeof globalConfig.$inferSelect
export type GlobalConfigInsert = typeof globalConfig.$inferInsert

/**
 * Per-symbol decision log from `runPullbackScheduler`。1 row per
 * (cron fire × symbol)。HOLD / BUY / SELL / REJECT / ERROR 全ルートを残す。
 * #128。運用で銘柄単位の診断 (なぜ BUY が出ないのか) に使う。
 * 7 日 TTL で quote feed cron が cleanup 同梱予定。
 */
export const strategyDecisionLog = sqliteTable(
  'strategy_decision_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: text('timestamp').notNull(),
    requestId: text('request_id'),
    symbol: text('symbol').notNull(),
    /** 'BUY' / 'SELL' / 'HOLD' / 'REJECT' / 'ERROR' */
    decision: text('decision').notNull(),
    /** signal.reason (HOLD) / sizing.capReason (REJECT) / error.message (ERROR) */
    reason: text('reason'),
    price: real('price'),
    /** indicators snapshot JSON (debug 用、optional) */
    indicatorsJson: text('indicators_json'),
    /**
     * BUY/SELL 成立時の client_order_id。dashboard が trade_journal と JOIN
     * して realized_pnl を引くためのキー (#143)。HOLD/REJECT/ERROR は null。
     */
    clientOrderId: text('client_order_id'),
  },
  (t) => ({
    // `/dashboard/cron?symbol=X` は WHERE symbol=? ORDER BY id DESC で読む。
    // (symbol, id) の複合 index で drop-in covering (CodeRabbit #132)。
    symbolIdIdx: index('strategy_decision_log_symbol_id_idx').on(t.symbol, t.id),
    // trade_journal との JOIN 用 (#143)。
    clientOrderIdIdx: index('strategy_decision_log_coid_idx').on(t.clientOrderId),
  }),
)

export type StrategyDecisionLogRow = typeof strategyDecisionLog.$inferSelect
export type StrategyDecisionLogInsert = typeof strategyDecisionLog.$inferInsert

/**
 * `Notifier.notify()` で push 通知を送った全イベントを書き出す append-only
 * ログ (#141)。dashboard `/dashboard/alerts` の active alerts view が
 * `severity = 'critical' | 'warning'` を timestamp DESC で読む。
 *
 * 役割:
 *   - operator が dashboard を見れば「直近 100 件の critical / warning」を
 *     一覧できる
 *   - Webhook が落ちていた / 未設定でも D1 だけは残る (audit trail)
 *   - Workers Logs retention を超える長期保全までは expectation しない (POC)。
 *     長期保全は Logpush to R2 (follow-up) でカバー想定。
 *
 * `severity` は free-form text にしておく (DB CHECK 制約は drizzle-kit で
 * 後から追加可能)。production の値域は `NotificationSeverity` 型で縛る。
 */
export const notificationEmitLog = sqliteTable(
  'notification_emit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: text('timestamp').notNull(),
    requestId: text('request_id'),
    /** 'TRADE' / 'ERROR' / 'STATE_CHANGE' (NotificationEvent.type と一致) */
    eventType: text('event_type').notNull(),
    /** 'critical' / 'warning' / 'info' (NotificationSeverity と一致)。TRADE は 'info'。 */
    severity: text('severity').notNull(),
    symbol: text('symbol'),
    /** ERROR の cause (例: `bar fetch`, `broker submit`)。STATE_CHANGE は field 名。 */
    cause: text('cause'),
    /** WebhookNotifier formatter が組み立てた text (Slack/Discord に送ったのと同じ)。 */
    message: text('message').notNull(),
  },
  (t) => ({
    // dashboard `/dashboard/alerts` は WHERE severity IN ('critical','warning')
    // ORDER BY id DESC で読む。
    severityIdIdx: index('notification_emit_log_severity_id_idx').on(t.severity, t.id),
    // event type 別フィルタ ('strategy_cron_error' のような cause も同 index で覆える)。
    eventTypeIdIdx: index('notification_emit_log_event_type_id_idx').on(t.eventType, t.id),
  }),
)

export type NotificationEmitLogRow = typeof notificationEmitLog.$inferSelect
export type NotificationEmitLogInsert = typeof notificationEmitLog.$inferInsert

/**
 * `global_config` の重要 field の前回値スナップショット (#141)。
 * cron tick で global_config を読む際にこの table と比較し、
 * `dry_run` true→false や `trading_enabled` false→true 等の遷移を検知して
 * STATE_CHANGE 通知を出す。
 *
 * `key` PRIMARY KEY 1 行 / field なので `INSERT OR REPLACE` で更新する。
 * 値は JSON.stringify で保存 (boolean / number / string / null を一律扱う)。
 */
export const configStateSnapshot = sqliteTable('config_state_snapshot', {
  /** field 名 (例: `dry_run`, `trading_enabled`). */
  key: text('key').primaryKey(),
  /** `JSON.stringify(value)` 形式。比較は文字列等価で行う。 */
  value: text('value').notNull(),
  snapshotAt: text('snapshot_at').notNull(),
  requestId: text('request_id'),
})

export type ConfigStateSnapshotRow = typeof configStateSnapshot.$inferSelect
export type ConfigStateSnapshotInsert = typeof configStateSnapshot.$inferInsert
