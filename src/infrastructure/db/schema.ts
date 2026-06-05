import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    notes: text('notes'),
    /**
     * 個別銘柄 override (NULL = global_config の default を使う、整数 1-365)。
     * 3x leveraged ETF 等で短い hold が望ましいケース用 (#316)。
     */
    timeStopDaysOverride: integer('time_stop_days_override'),
    /**
     * 個別銘柄 override (NULL = global_config の default を使う、float 0.5-5.0)。
     * 高ボラ銘柄で stop を緩めるケース用 (#316)。
     */
    kAtrOverride: real('k_atr_override'),
    /**
     * 予算配分 fraction (NULL = 従来の risk-% sizing、0<pct<=1)。指定されると
     * fixed-% 配分モードで `notional = min(total_capital * pct, max_notional)` で
     * sizing する (#budget-alloc)。小口座で高額レバ ETF を建てる用。range CHECK は
     * SQLite ALTER 制約で付けず admin parse + 将来 rebuild で担保。
     */
    budgetAllocPct: real('budget_alloc_pct'),
    /**
     * 売買単位 (1 注文の最小ロット = 1単元の株数 / ETF の口数)。NULL = 未設定。
     * **fallback しない**: cron sizing は NULL を fail-closed (発注見送り) として扱う
     * (誤った blanket 100/1 で過大・過小発注しないため #symbol-lot-size)。US 株/ETF・
     * JP ETF は通常 1、JP 個別株は 100。フォームは Yahoo `quoteType`/market から推奨値を
     * プリフィルするが、確定値は手入力必須。range CHECK は SQLite ALTER 制約を避け
     * admin parse + 将来 rebuild で担保 (budget_alloc_pct と同方針)。
     */
    lotSize: integer('lot_size'),
    /**
     * 損切り fraction override (NULL = global_config.pullback_default_stop_pct、負値)。
     * 3x レバ ETF 等でボラに合わせ stop を広げる用 (#exit-atr)。range CHECK は SQLite
     * ALTER 制約を避け admin parse で担保 (k_atr_override と同方針)。
     */
    stopPctOverride: real('stop_pct_override'),
    /**
     * 利食い fraction override (NULL = global default、正値)。R:R を銘柄別に調整する用。
     */
    takeProfitPctOverride: real('take_profit_pct_override'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    currencyEnum: check(
      'symbol_config_currency_enum',
      sql`${t.currency} IN ('USD', 'JPY')`,
    ),
    timeStopDaysOverrideRange: check(
      'symbol_config_time_stop_days_override_range',
      sql`${t.timeStopDaysOverride} IS NULL OR (${t.timeStopDaysOverride} >= 1 AND ${t.timeStopDaysOverride} <= ${MAX_TIME_STOP_DAYS})`,
    ),
    kAtrOverrideRange: check(
      'symbol_config_k_atr_override_range',
      sql`${t.kAtrOverride} IS NULL OR (${t.kAtrOverride} >= 0.5 AND ${t.kAtrOverride} <= 5.0)`,
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
 *
 * **戦略意図 (#315 regime hedge 明文化)**: 同 sector の 3x leveraged ETF を
 * 同時 universe に入れる構成は dead-money リスクを生む可能性があったが、
 * この table 経由で「inverse 相手に open position がある間は BUY 不可」を強制
 * する事で 1 銘柄 active な regime hedge として動作する。SOXL pullback で entry
 * → trend 続行で hold、regime 反転で SELL → クールダウン後に SOXS 側 entry、
 * の交互運用を想定。
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
     * 過熱ガード (#strategy-overextension-guards): `(price-sma50)/sma50` がこの比率超
     * で BUY 見送り。+3x レバ ETF の blowoff 高値掴み回避。POC default 0.60 (+60%)。
     */
    pullbackDefaultMaxSma50DeviationPct: real('pullback_default_max_sma50_deviation_pct')
      .notNull()
      .default(0.6),
    /**
     * ボラ過熱ガード: `atr20/baselineAtr20` がこの比率超で BUY 見送り。POC default 1.5。
     */
    pullbackDefaultMaxAtrRatio: real('pullback_default_max_atr_ratio').notNull().default(1.5),
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
     * VIX regime filter (issue #196 3/3)。`^VIX` 最新値がこの閾値を超えたら
     * BUY size を `vix_warning_size_scale` 倍に縮小 (default 25 → x0.5)。
     * 25 以下は normal (size scale 1.0)、SELL は閾値関係なく通す。
     */
    vixWarningThreshold: real('vix_warning_threshold').notNull().default(25.0),
    /**
     * VIX が `vix_critical_threshold` を超えたら BUY を全停止 (sizeScale=0)。
     * SELL は VIX 関係なく通す (= existing position の exit を妨げない)。
     * default 30。
     */
    vixCriticalThreshold: real('vix_critical_threshold').notNull().default(30.0),
    /**
     * VIX warning 領域 (warning < VIX <= critical) で適用する size 倍率。
     * default 0.5 (= 半分に縮小)。0..1 で運用想定。
     */
    vixWarningSizeScale: real('vix_warning_size_scale').notNull().default(0.5),
    /**
     * Dashboard overview パネルの表示 ON/OFF (#dashboard-mf-layout)。有効パネル
     * key の CSV。表示専用設定なので trading config (`GlobalConfigSnapshot`) には
     * 通さず、dashboard が専用 read (`loadOverviewPanels`) で参照する。
     * key: kpi / equity / composition / recent。default は全表示。
     */
    overviewPanels: text('overview_panels').notNull().default('kpi,equity,composition,recent'),
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
    // 過熱ガード 2 列 (max_sma50_deviation_pct / max_atr_ratio) は 0015(vix) と同様、
    // ALTER ADD COLUMN で追加するため DB CHECK は付けない (SQLite 制約)。範囲の
    // 妥当性はゲートが本質的に fail-safe (異常値でも BUY を抑制する方向) なため、
    // 将来の table-rebuild migration でまとめて CHECK 投入予定。
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
    // VIX 閾値は実数値 (10..100 程度の運用想定だが余裕を持って 0..200)。
    // 0 以下 / 上限超 / 順序逆 (warning > critical) を弾く。
    vixWarningThresholdRange: check(
      'global_config_vix_warning_threshold_range',
      sql`${t.vixWarningThreshold} > 0 AND ${t.vixWarningThreshold} <= 200`,
    ),
    vixCriticalThresholdRange: check(
      'global_config_vix_critical_threshold_range',
      sql`${t.vixCriticalThreshold} > 0 AND ${t.vixCriticalThreshold} <= 200`,
    ),
    // warning ≤ critical の順序を強制。逆転すると warning 領域が空集合になり
    // 「critical を超えていないのに sizeScale が 0」みたいな矛盾が出る。
    vixThresholdOrder: check(
      'global_config_vix_threshold_order',
      sql`${t.vixWarningThreshold} <= ${t.vixCriticalThreshold}`,
    ),
    vixWarningSizeScaleRange: check(
      'global_config_vix_warning_size_scale_range',
      sql`${t.vixWarningSizeScale} >= 0 AND ${t.vixWarningSizeScale} <= 1`,
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
    // dashboard `/dashboard/alerts` は ORDER BY timestamp DESC, id DESC で読む。
    // `waitUntil` 配下の INSERT が前後して id 順と発生順がずれるケースを
    // tiebreak で吸収するため、timestamp を first key にする (CodeRabbit #210)。
    timestampIdIdx: index('notification_emit_log_timestamp_id_idx').on(t.timestamp, t.id),
    // severity フィルタ + timestamp DESC ソートを 1 本でカバー。
    severityTimestampIdIdx: index('notification_emit_log_severity_timestamp_id_idx').on(
      t.severity,
      t.timestamp,
      t.id,
    ),
    // event type 別フィルタ ('strategy_cron_error' のような cause も同 index で覆える)。
    eventTypeTimestampIdIdx: index('notification_emit_log_event_type_timestamp_id_idx').on(
      t.eventType,
      t.timestamp,
      t.id,
    ),
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

/**
 * Per-symbol earnings calendar (issue #196 1/3)。entry を avoid させる用途
 * の risk gate ソース。`earningsGate` が evalDate ± freezeBusinessDays を
 * 範囲で読み、該当日があれば BUY を reject する (シグナル源ではなく avoid 用)。
 *
 * POC では外部 API 取得は別 issue で、`/admin/earnings/seed` 経由で operator が
 * 手動 seed する想定。`UNIQUE (symbol, earnings_date)` で重複 insert は弾く。
 */
export const earningsCalendar = sqliteTable(
  'earnings_calendar',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 銘柄コード (例: 'AAPL', '7203')。upper-case 前提で repo 側が正規化する。 */
    symbol: text('symbol').notNull(),
    /**
     * 決算発表日 ISO date "YYYY-MM-DD"。BMO (Before Market Open) / AMC
     * (After Market Close) の区別は POC では持たない (±N 営業日窓で十分粗い)。
     */
    earningsDate: text('earnings_date').notNull(),
    /** 自由 text。'Q2 2026' / 'BMO' / news source 等を operator が任意で残す。 */
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    // 同一銘柄 × 同一日の重複を物理的に防ぐ。bulk seed は INSERT OR IGNORE で skip。
    // unique index は gate の (symbol, earnings_date) range read もカバーするので
    // 通常の index は別建てしない (drop-in covering)。
    symbolDateUnique: uniqueIndex('earnings_calendar_symbol_date_unique').on(t.symbol, t.earningsDate),
  }),
)

export type EarningsCalendarRow = typeof earningsCalendar.$inferSelect
export type EarningsCalendarInsert = typeof earningsCalendar.$inferInsert

/**
 * Macro economic event calendar (issue #196 2/3)。`earningsCalendar` と
 * 同じく avoid 用 risk gate のソース。FOMC / CPI / NFP / PCE / GDP / ISM 等の
 * 重要発表 当日 ±N 時間に被る BUY エントリを `macroEventGate` が凍結する
 * (シグナル源ではない、BUY を *止める* だけ)。
 *
 * POC では外部 API 取得は別 issue で、`/admin/macro-events/seed` 経由で
 * operator が手動 seed する想定。`UNIQUE (event_type, event_date)` で同一
 * event の重複 insert を物理的に弾く。
 *
 * `event_time` (HH:MM ET) は optional — 未設定なら「当日全日凍結」、設定
 * されていれば 発表時刻 ± N 時間で window 判定 (簡略 ET tz: `Intl.DateTimeFormat`
 * with `America/New_York`)。
 */
export const macroEventCalendar = sqliteTable(
  'macro_event_calendar',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Event 種別 (例: 'FOMC' / 'CPI' / 'NFP' / 'PCE' / 'GDP' / 'ISM')。
     * upper-case 前提で repo 側が正規化する。reason 文字列に含めるので
     * operator が dashboard で読みやすい短い記号を使う。
     */
    eventType: text('event_type').notNull(),
    /** 発表日 ISO date "YYYY-MM-DD" (ET base — 米国経済指標の慣習)。 */
    eventDate: text('event_date').notNull(),
    /**
     * 発表時刻 ISO time "HH:MM" (ET base、24h)。NULL なら時刻不明 = 当日全日
     * 凍結扱い (例: 一部 ISM / GDP の正確な分単位が事前未確定なケース)。
     * 例: CPI '08:30', FOMC '14:00', NFP '08:30'。
     */
    eventTime: text('event_time'),
    /** 自由 text。'June FOMC' / 'June CPI release' / source 等。 */
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    // 同一 event_type × 同一日の重複を物理的に防ぐ。bulk seed は
    // INSERT OR IGNORE (drizzle `.onConflictDoNothing()`) で skip。
    typeDateUnique: uniqueIndex('macro_event_calendar_type_date_unique').on(t.eventType, t.eventDate),
    // gate 側の range read (event_date 範囲) を加速する。type_date_unique は
    // (type, date) の複合 index なので date 単独 prefix では使えない。
    dateIdx: index('macro_event_calendar_date_idx').on(t.eventDate),
  }),
)

export type MacroEventCalendarRow = typeof macroEventCalendar.$inferSelect
export type MacroEventCalendarInsert = typeof macroEventCalendar.$inferInsert

/**
 * Append-only audit trail of state-changing admin POST calls (#274). One row per
 * mutation: `before_json` / `after_json` are `JSON.stringify`'d snapshots of the
 * affected resource so dashboard can render diffs without re-fetching state.
 *
 * Rows are written by `recordChange()` only when before != after — pure no-op
 * calls (e.g. seed-cash with the same amount) are skipped to keep the table
 * focused on actual changes.
 *
 * `actor` is the basic-auth username, falling back to `'ai-agent'` when the
 * header is missing or unparseable. `target_key` is a free-form short string
 * (e.g. `symbol=SOXL` / `portfolio=daily`) so a single endpoint with multiple
 * resources (`/earnings/seed`) can still group rows.
 */
export const configAuditLog = sqliteTable(
  'config_audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: text('timestamp').notNull(),
    actor: text('actor').notNull(),
    endpoint: text('endpoint').notNull(),
    targetKey: text('target_key'),
    beforeJson: text('before_json').notNull(),
    afterJson: text('after_json').notNull(),
    requestId: text('request_id'),
  },
  (t) => ({
    // dashboard `/dashboard/audit` は timestamp DESC で読む。id を tiebreak に
    // 含めて同 timestamp の順序を安定化 (notification_emit_log 相当の対応)。
    timestampIdIdx: index('config_audit_log_timestamp_id_idx').on(t.timestamp, t.id),
    actorTimestampIdIdx: index('config_audit_log_actor_timestamp_id_idx').on(
      t.actor,
      t.timestamp,
      t.id,
    ),
    endpointTimestampIdIdx: index('config_audit_log_endpoint_timestamp_id_idx').on(
      t.endpoint,
      t.timestamp,
      t.id,
    ),
  }),
)

export type ConfigAuditLogRow = typeof configAuditLog.$inferSelect
export type ConfigAuditLogInsert = typeof configAuditLog.$inferInsert

/**
 * Runtime kill-switch toggle history (issue #276)。`global_config.trading_enabled`
 * は単一行で「現在値」、こちらは append-only で「いつ誰が何故 ON/OFF にしたか」
 * を残す。full audit log は #274 で別途扱う想定なので、ここでは kill-switch の
 * before/after/reason に絞る最小スキーマ。
 */
export const tradingToggleHistory = sqliteTable('trading_toggle_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull(),
  /** basic-auth user (admin endpoint 経由は username, dashboard 経由も同様)。 */
  actor: text('actor'),
  /** 切替前の trading_enabled。NULL は初回 toggle (snapshot 不能) のみ想定。 */
  before: integer('before', { mode: 'boolean' }),
  /** 切替後の trading_enabled。 */
  after: integer('after', { mode: 'boolean' }).notNull(),
  /** operator から渡された自由記述の理由。必須 (audit context)。 */
  reason: text('reason').notNull(),
  requestId: text('request_id'),
})

export type TradingToggleHistoryRow = typeof tradingToggleHistory.$inferSelect
export type TradingToggleHistoryInsert = typeof tradingToggleHistory.$inferInsert

/**
 * Daily portfolio equity snapshot (1 row per `rollDaily()` execution). Persists
 * `PortfolioStateDO.dailyStartEquity` over time so the `/dashboard/portfolio`
 * page can render the "真の総資産チャート" — cash + holdings — rather than the
 * `/dashboard/charts?tab=overview` curve which only sums `trade_journal.realized_pnl`.
 *
 * USD / JPY are kept as separate columns so multi-currency snapshots can be
 * recorded without ad-hoc JSON. The DO today stores a single `dailyStartEquity`
 * number; today this populates USD by default with JPY left NULL until the DO
 * is split per-currency (out of scope of this PR). Either column may be NULL.
 *
 * One row per roll-daily call. We do NOT dedupe within a day — multiple
 * manual rolls on the same day intentionally produce multiple rows so the
 * audit trail keeps every transition.
 */
export const portfolioEquitySnapshot = sqliteTable(
  'portfolio_equity_snapshot',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotAt: text('snapshot_at').notNull(),
    /** `PortfolioStateDO.dailyStartEquity` 等価 (USD denomination)。 */
    dailyStartEquityUsd: real('daily_start_equity_usd'),
    /** `PortfolioStateDO.dailyStartEquity` 等価 (JPY denomination)。 */
    dailyStartEquityJpy: real('daily_start_equity_jpy'),
    dailyRealizedPnlUsd: real('daily_realized_pnl_usd'),
    dailyRealizedPnlJpy: real('daily_realized_pnl_jpy'),
    /** dailyRealizedPnl / dailyStartEquity (fraction、負が drawdown)。 */
    drawdownPct: real('drawdown_pct'),
    /** roll-daily を起こした request id (cron / 手動 trace 用)。任意。 */
    requestId: text('request_id'),
  },
  (t) => ({
    // chart 表示は snapshotAt ASC で range スキャンする (`loadPortfolioEquitySnapshots`)。
    snapshotAtIdx: index('portfolio_equity_snapshot_at_idx').on(t.snapshotAt),
  }),
)

export type PortfolioEquitySnapshotRow = typeof portfolioEquitySnapshot.$inferSelect
export type PortfolioEquitySnapshotInsert = typeof portfolioEquitySnapshot.$inferInsert
