import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Max for pullbackDefaultTimeStopDays; exported so chart window logic matches the DB constraint. */
export const MAX_TIME_STOP_DAYS = 365

/**
 * Append-only trade decision / order lifecycle log, one row per logical
 * event (`decision` -> `intent` -> `pre_submit` -> `post_submit` -> `fill` /
 * `exit`). Flat column shape mirrors {@link TradeJournalRecord} in
 * src/infrastructure/logger/tradeJournal.ts so records map straight to rows
 * without adapter logic. SELECT examples: docs/db-operations.md.
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
  /**
   * 売買コスト見積り (round-trip、SELL 行のみ)。`realized_pnl` はこの額を
   * 引いた net。broker が実費を返さないため global_config の fee 設定から
   * 推定。NULL = 未設定 (realized_pnl は gross) または旧データ。
   */
  estimatedCost: real('estimated_cost'),
  holdDays: real('hold_days'),
  exitReason: text('exit_reason'),
  errorClass: text('error_class'),
  errorMessage: text('error_message'),
  /**
   * ISO timestamp when this FILLED row's DO-layer apply (SymbolStateDO
   * position / PortfolioStateDO realized PnL / cooldown) succeeded. NULL
   * means not yet applied (status not FILLED yet, or a prior apply threw).
   * Acts as an idempotent-apply ledger for `reconcileFills`: NULL rows with
   * a fill-carrying `broker_status` are retried every tick; once stamped, a
   * row is never re-applied even if re-selected.
   */
  stateAppliedAt: text('state_applied_at'),
  /**
   * Last DO-apply error for this row. NULL = never failed, or succeeded
   * since. Non-NULL with `state_applied_at` set means a prior failure
   * eventually succeeded — only meaningful paired with `state_applied_at`.
   */
  stateApplyError: text('state_apply_error'),
  /** DO-apply attempt count, bumped on each retry; `attempts >> 1` with `state_applied_at IS NULL` is a stuck-row alert signal. */
  stateApplyAttempts: integer('state_apply_attempts').notNull().default(0),
})

export type TradeJournalRow = typeof tradeJournal.$inferSelect
export type TradeJournalInsert = typeof tradeJournal.$inferInsert

/**
 * Per-symbol universe + trading policy. Replaces `ALLOWED_SYMBOLS` /
 * `SYMBOL_MAX_NOTIONAL` env vars so changes don't require redeploy — operator
 * edits via `wrangler d1 execute`, see docs/db-operations.md.
 *
 * `active=0` = suspended (drops out of the effective allowlist). Most
 * `*Override` columns are NULL = fall through to the `global_config`
 * default; several intentionally skip a DB range CHECK (SQLite can't ALTER
 * ADD CHECK on an existing column) and rely on admin-parse validation
 * instead — noted per column only where the range itself matters.
 */
export const symbolConfig = sqliteTable(
  'symbol_config',
  {
    symbol: text('symbol').primaryKey(),
    name: text('name'),
    market: text('market').notNull(), // 'US' | 'JP'
    /**
     * ISO 4217 通貨コード。notional を通貨別 global cap と比較する基準。
     * market と独立に持つ理由: 将来の HKD ADR 等、market と 1:1 でない通貨への拡張。
     */
    currency: text('currency').notNull().default('USD'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    maxNotional: real('max_notional'),
    notes: text('notes'),
    /** Per-symbol override (NULL = global_config default; integer 1-365). */
    timeStopDaysOverride: integer('time_stop_days_override'),
    /** Per-symbol override (NULL = global_config default; float 0.5-5.0). */
    kAtrOverride: real('k_atr_override'),
    /**
     * 予算配分 fraction (NULL = 従来の risk-% sizing、0<pct<=1)。設定時は
     * fixed-% モード: `notional = min(total_capital * pct, max_notional)`。
     */
    budgetAllocPct: real('budget_alloc_pct'),
    /**
     * 1 注文の最小ロット数 (US 株/ETF・JP ETF は通常 1、JP 個別株は 100)。
     * NULL は blanket 100/1 へフォールバックしない: cron sizing は NULL を
     * fail-closed (発注見送り) として扱う — 誤ったフォールバックは過大/過小発注
     * につながる。フォームは推奨値をプリフィルするが確定値は手入力必須。
     */
    lotSize: integer('lot_size'),
    /** Override for pullback_default_stop_pct (NULL = use global default; negative fraction). */
    stopPctOverride: real('stop_pct_override'),
    /** Override for take-profit fraction (NULL = global default; positive). */
    takeProfitPctOverride: real('take_profit_pct_override'),
    /** true = forced close before US market close instead of holding overnight. */
    intradayOnly: integer('intraday_only', { mode: 'boolean' }).notNull().default(false),
    /**
     * 銘柄ロール: 'cash_parking' | 'core_trend' | 'leveraged_trend' |
     * 'low_volatility' | 'sector_trend' | 'inverse_hedge'。NULL = 従来挙動。
     * enum 外の値は entry 抑止 (fail-closed、BUY を生成しない)。
     */
    role: text('role'),
    /**
     * Entry gate per-symbol override (NULL = role preset -> global_config
     * pullback_default_* fall-through). pullbackMax is the shallow bound
     * (e.g. -0.03), pullbackMin the deep bound (e.g. -0.06); an inverted
     * band (max < min) just yields zero eligible entries, not an error.
     */
    pullbackMaxOverride: real('pullback_max_override'),
    pullbackMinOverride: real('pullback_min_override'),
    /** Trend-condition override (NULL = global default; fraction). */
    minReturn50dOverride: real('min_return_50d_override'),
    /** Volatility-overheat guard override (NULL = global default; ratio > 0). */
    maxAtrRatioOverride: real('max_atr_ratio_override'),
    /** Overextension-guard override (NULL = global default; fraction > 0). */
    maxSma50DeviationPctOverride: real('max_sma50_deviation_pct_override'),
    /** Require-above-SMA50 override (NULL = global default; boolean). */
    requireAboveSma50Override: integer('require_above_sma50_override', { mode: 'boolean' }),
    /**
     * true = entry gate (ENTRY/HALF) 通過を実配分の必須条件にする。未通過の間は
     * active=0 になり、浮いた配分は cashFallbackSymbols へ退避される。false
     * (default) = budget_alloc_pct の枠が常時有効。
     */
    entryRequired: integer('entry_required', { mode: 'boolean' }).notNull().default(false),
    /** true = target is always active regardless of entry gate (cash-parking symbols like SGOV that bypass the pullback gate). */
    alwaysActive: integer('always_active', { mode: 'boolean' }).notNull().default(false),
    /**
     * entry_required 銘柄が条件未通過のときの退避先 (JSON 配列 text、例
     * '["SGOV","USMV"]')。複数は等分割。NULL/空 = 退避しない。通貨が異なる
     * 退避先は配分計算で skip (fail-closed、現金待機)。実際の自動発注は
     * global_config.cash_fallback_orders_enabled が on になるまで行わない。
     */
    cashFallbackSymbols: text('cash_fallback_symbols'),
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
 * の open position がある間 BUY を拒否するために使う。1 方向だけ書けば十分 —
 * repo 側で bidirectional に展開する。
 */
export const inversePairs = sqliteTable('inverse_pairs', {
  symbol: text('symbol').primaryKey(),
  inverse: text('inverse').notNull(),
  /**
   * Per-pair opt-in (0 = unchanged legacy behavior). 1 requires
   * regime_proxy_symbol / regime_bull_symbol; repo validation failure
   * falls back to zone=unknown (fail-closed, blocks BUY both sides).
   */
  regimeEnabled: integer('regime_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Regime-score input symbol (unleveraged underlying recommended, e.g. SOXX for SOXL/SOXS). Not required in the trading universe — fetched independently per pair. */
  regimeProxySymbol: text('regime_proxy_symbol'),
  /** Explicit bull-side symbol for the pair (does not assume `symbol` column = bull). Must equal `symbol` or `inverse`, else misconfigured. */
  regimeBullSymbol: text('regime_bull_symbol'),
  updatedAt: text('updated_at').notNull(),
})

export type InversePairRow = typeof inversePairs.$inferSelect
export type InversePairInsert = typeof inversePairs.$inferInsert

/**
 * Singleton global risk / lifecycle config, one row (`id='default'`).
 * Operator UPDATEs via `wrangler d1 execute` for runtime changes (trading
 * on/off, drawdown threshold, kill-switch, ...); loaded at Worker start via
 * `loadGlobalConfig`. `drawdownKillThreshold` is a negative fraction
 * (e.g. -0.02 = -2%).
 */
export const globalConfig = sqliteTable(
  'global_config',
  {
    id: text('id').primaryKey(), // 'default' 固定
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
    tradingEnabled: integer('trading_enabled', { mode: 'boolean' }).notNull().default(false),
    marketHoursCheck: integer('market_hours_check', { mode: 'boolean' }).notNull().default(false),
    /**
     * true = skip strategy cron evaluation entirely outside [open - 30min,
     * close] (US 09:30 ET / JP 08:30-09:00 JST). false (default) = always
     * evaluate.
     */
    sessionWindowGateEnabled: integer('session_window_gate_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
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
     * Concurrent-exposure cap = total_capital * max_portfolio_exposure_pct
     * per currency; new BUYs that would push open_exposure past this
     * fraction of total_capital are rejected.
     */
    maxPortfolioExposurePct: real('max_portfolio_exposure_pct').notNull().default(0.6),
    drawdownKillThreshold: real('drawdown_kill_threshold').notNull().default(-0.02),
    staleQuoteMs: integer('stale_quote_ms').notNull().default(900000),
    gapRejectPct: real('gap_reject_pct').notNull().default(0.03),
    spreadLimitPctUs: real('spread_limit_pct_us').notNull().default(0.0025),
    spreadLimitPctJp: real('spread_limit_pct_jp').notNull().default(0.006),
    // Pullback strategy defaults; symbolConfig's per-symbol *Override columns
    // fall through to these when NULL. DB-backed so tuning doesn't need a
    // PR/deploy.
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
     * Overextension guard: BUY skipped when `(price-sma50)/sma50` exceeds
     * this fraction (avoids blowoff-top entries on 3x leveraged ETFs).
     * POC default 0.60 (+60%).
     */
    pullbackDefaultMaxSma50DeviationPct: real('pullback_default_max_sma50_deviation_pct')
      .notNull()
      .default(0.6),
    /** Volatility-overheat guard: BUY skipped when atr20/baselineAtr20 exceeds this ratio. Default 1.1. */
    pullbackDefaultMaxAtrRatio: real('pullback_default_max_atr_ratio').notNull().default(1.1),
    /**
     * Stop-width cap = |avgPrice * take_profit_pct| * this value, bounding
     * how far the ATR-adaptive stop can widen relative to take-profit (2.0
     * -> R:R >= 0.5). 0 disables the cap (ATR stop unbounded).
     */
    pullbackDefaultMaxStopToTpRatio: real('pullback_default_max_stop_to_tp_ratio')
      .notNull()
      .default(2.0),
    /** Fee rate applied to notional, used to net realized PnL. 0 = gross (legacy). */
    feePctOfNotional: real('fee_pct_of_notional').notNull().default(0),
    /** Fixed per-order fee (symbol's currency). 0 = disabled. */
    feeFixedPerOrder: real('fee_fixed_per_order').notNull().default(0),
    /**
     * Baseline ATR window for the overheat guard's denominator
     * (`pullback_default_max_atr_ratio`). enum validated at loader (invalid
     * -> `percentile`).
     *
     * - `percentile` (default): symbol's own atr20 p80 — measures "high vol
     *   for this symbol" independent of its baseline vol level.
     * - `overlap`: trailing-60 mean. Denominator overlaps the numerator so
     *   the ratio barely moves and the guard never fires at any threshold.
     * - `exclude-recent`: trailing-60 mean excluding the last 20. Ratio
     *   moves cleanly but is noise-sensitive — small threshold changes swing
     *   results sharply.
     */
    atrBaselineMode: text('atr_baseline_mode').notNull().default('percentile'),
    /** Base risk fraction per trade (0.4% default); scaled by drawdown before reaching pullbackSizing. */
    riskBasePerTradePct: real('risk_base_per_trade_pct').notNull().default(0.004),
    /** drawdown がこの閾値 (負) 未満になると size を halfScaleFactor に。-0.05 既定。 */
    riskDdHalfThreshold: real('risk_dd_half_threshold').notNull().default(-0.05),
    /** drawdown がこの閾値 (負) 未満になると size を 0 に (halt)。-0.10 既定。 */
    riskDdHaltThreshold: real('risk_dd_halt_threshold').notNull().default(-0.10),
    /**
     * VIX regime filter: BUY size scaled to vix_warning_size_scale when
     * `^VIX` exceeds this (default 25 -> x0.5). At/below = normal (scale
     * 1.0); SELL is never gated by VIX.
     */
    vixWarningThreshold: real('vix_warning_threshold').notNull().default(25.0),
    /** BUY fully halted (sizeScale=0) above this VIX level; SELL unaffected (never blocks an exit). Default 30. */
    vixCriticalThreshold: real('vix_critical_threshold').notNull().default(30.0),
    /** Size multiplier applied in the VIX warning band (warning < VIX <= critical). Default 0.5. */
    vixWarningSizeScale: real('vix_warning_size_scale').notNull().default(0.5),
    /**
     * Pair-regime layer: 'off' (default) | 'observe' (log only, no gating) |
     * 'enforce'. Loader-validated; invalid values fall back to 'off'
     * (disabled gate is the safe default).
     */
    pairRegimeMode: text('pair_regime_mode').notNull().default('off'),
    /**
     * Schmitt-trigger thresholds (1x unleveraged proxy basis). Must satisfy
     * bear_enter < bear_exit < bull_exit < bull_enter; validated at
     * admin-parse/runtime (not a DB CHECK — added via ALTER, can't add
     * table-level CHECK). An order violation falls back to zone=unknown.
     */
    pairRegimeThetaBullEnter: real('pair_regime_theta_bull_enter').notNull().default(0.03),
    pairRegimeThetaBullExit: real('pair_regime_theta_bull_exit').notNull().default(0.01),
    pairRegimeThetaBearEnter: real('pair_regime_theta_bear_enter').notNull().default(-0.04),
    pairRegimeThetaBearExit: real('pair_regime_theta_bear_exit').notNull().default(-0.015),
    /**
     * CSV of enabled dashboard overview panel keys (kpi/equity/composition/
     * recent). Display-only — deliberately excluded from `GlobalConfigSnapshot`
     * (trading config) and read separately via `loadOverviewPanels`. Default
     * shows all panels.
     */
    overviewPanels: text('overview_panels').notNull().default('kpi,equity,composition,recent'),
    /**
     * Cash-fallback auto-order gate; default false (fail-closed) — off means
     * target/active is computed and displayed but no BUY is placed toward
     * fallback symbols. On does not bypass DRY_RUN / TRADING_ENABLED / risk
     * gates.
     */
    cashFallbackOrdersEnabled: integer('cash_fallback_orders_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * News-shock gate: shrinks/halts BUY size on a GDELT report-volume spike
     * + tone deterioration. 'off' (default) | 'observe' (trace only) |
     * 'enforce'. Invalid DB values fall back to 'off'. No DB CHECK (added
     * via ALTER ADD COLUMN) — validated in globalConfigRepo's runtime sanitize.
     */
    newsShockMode: text('news_shock_mode').notNull().default('off'),
    /** Warning threshold: (recent max / baseline median) ratio above this shrinks BUY size by news_shock_warn_size_scale. Default 2.3. */
    newsShockWarnRatio: real('news_shock_warn_ratio').notNull().default(2.3),
    /** Critical threshold: ratio above this AND (if requireTone) a tone drop halts BUY entirely. Default 4.4. */
    newsShockBlockRatio: real('news_shock_block_ratio').notNull().default(4.4),
    /** warning 領域の size 倍率。default 0.5。 */
    newsShockWarnSizeScale: real('news_shock_warn_size_scale').notNull().default(0.5),
    /** Tone-drop magnitude (baselineTone - latestTone) required for critical, so a volume spike alone (e.g. positive news) doesn't halt BUY. Default 1.5. */
    newsShockToneDropThreshold: real('news_shock_tone_drop_threshold').notNull().default(1.5),
    /** true (default) で critical 判定に tone 低下 AND 条件を要求する。 */
    newsShockRequireTone: integer('news_shock_require_tone', { mode: 'boolean' })
      .notNull()
      .default(true),
    /** baseline (median 母集団) の trailing 日数。default 7。 */
    newsShockBaselineDays: integer('news_shock_baseline_days').notNull().default(7),
    /** baseline サンプル数の下限。未満なら unknown (insufficient_baseline)。default 200。 */
    newsShockMinSamples: integer('news_shock_min_samples').notNull().default(200),
    /** ratio 分子側 (直近 max) の窓 (分)。default 120。 */
    newsShockWindowMin: integer('news_shock_window_min').notNull().default(120),
    /** 最新観測がこれより古ければ unknown (unavailable) 扱い。default 90 (分)。 */
    newsShockMaxAgeMin: integer('news_shock_max_age_min').notNull().default(90),
    /**
     * attention 観測 (GDELT producer) が不可用/不足のときの fail-open/closed
     * 切替。'fail_open' (default、既存 gate と同じ判断) | 'block_buy'
     * (operator が明示的に fail-closed へ倒す escape hatch)。
     */
    attentionStalePolicy: text('attention_stale_policy').notNull().default('fail_open'),
    /**
     * Extended-hours (pre-market) gate: applies same-day WARNING/
     * STOP_AT_OPEN_CANDIDATE from extended_hours_observation to BUY sizing.
     * 'off' (default) | 'observe' (trace only) | 'enforce'. Invalid DB
     * values fall back to 'off'; no DB CHECK (ALTER-added column),
     * validated in globalConfigRepo's runtime sanitize.
     */
    extendedHoursGateMode: text('extended_hours_gate_mode').notNull().default('off'),
    /**
     * Cash-fallback demand-linked auto-SELL: on ticks where the fallback
     * source attempts a BUY ("demand"; holding alone does not count —
     * avoids a sell-then-buyback round trip), partially sells the fallback
     * symbol's excess over active weight back to the source strategy.
     * 'off' (default) | 'observe' | 'enforce'. Invalid DB values fall back
     * to 'off'. Independent of cashFallbackOrdersEnabled (the BUY-side
     * flag) — SELL can be enforced first.
     */
    cashFallbackSellMode: text('cash_fallback_sell_mode').notNull().default('off'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    // Catches a typo/wrong-magnitude UPDATE at the DB level; the upper
    // bound is a POC sanity ceiling (e.g. $10M on a single order is
    // obviously a mistake).
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
    // No DB CHECK for max_sma50_deviation_pct / max_atr_ratio (ALTER-added
    // columns, SQLite can't add a table-level CHECK afterward) — the gate
    // itself is fail-safe on bad values (suppresses BUY, doesn't block).
    // This CHECK guards the relative order: min > max would silently zero
    // out eligible entries.
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
 * Per-symbol decision log from `runPullbackScheduler` (one row per cron
 * fire x symbol), covering all routes: HOLD / BUY / SELL / SKIP / REJECT /
 * ERROR. Used for per-symbol diagnosis of why a BUY did or didn't fire.
 */
export const strategyDecisionLog = sqliteTable(
  'strategy_decision_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: text('timestamp').notNull(),
    requestId: text('request_id'),
    symbol: text('symbol').notNull(),
    /**
     * 'BUY' / 'SELL' / 'HOLD' / 'SKIP' / 'REJECT' / 'ERROR'。
     * SKIP = bot 内部ゲート見送り (broker 未到達) / REJECT = broker 4xx 確定拒否 /
     * ERROR = 原因不明・一時的 (5xx / ネットワーク / 想定外の例外)。
     */
    decision: text('decision').notNull(),
    /** signal.reason (HOLD) / sizing.capReason (SKIP) / error.message (REJECT/ERROR) */
    reason: text('reason'),
    price: real('price'),
    /** indicators snapshot JSON (debug 用、optional) */
    indicatorsJson: text('indicators_json'),
    /**
     * client_order_id set on BUY/SELL rows; join key for dashboard to pull
     * realized_pnl from trade_journal. NULL for HOLD/SKIP/REJECT/ERROR.
     */
    clientOrderId: text('client_order_id'),
    /**
     * Ordered decision trace (`DecisionTraceStep[]`) of which gate/layer
     * accepted or rejected the signal; renders as an input->logic->output
     * ladder on the dashboard. NULL for pre-migration rows or paths that
     * don't emit a trace.
     */
    traceJson: text('trace_json'),
    /**
     * `HeadlineEvalSnapshot` JSON (news_headline_eval row visible at decision
     * time, or an `available:false` reason). Observe-only, never read by
     * sizing/gates — recorded for a later point-in-time Jev evaluation.
     */
    headlineEvalJson: text('headline_eval_json'),
  },
  (t) => ({
    // `/dashboard/cron?symbol=X` reads WHERE symbol=? ORDER BY id DESC — this
    // composite index covers it directly.
    symbolIdIdx: index('strategy_decision_log_symbol_id_idx').on(t.symbol, t.id),
    // Join key for trade_journal lookups.
    clientOrderIdIdx: index('strategy_decision_log_coid_idx').on(t.clientOrderId),
  }),
)

export type StrategyDecisionLogRow = typeof strategyDecisionLog.$inferSelect
export type StrategyDecisionLogInsert = typeof strategyDecisionLog.$inferInsert

/**
 * Append-only log of every event `Notifier.notify()` sent, independent of
 * webhook delivery success (audit trail survives a down/unset webhook).
 * `/dashboard/alerts` reads severity IN ('critical','warning') ORDER BY
 * timestamp DESC.
 *
 * `severity` stays free-form text (DB CHECK constraints are awkward to add
 * later via drizzle-kit); the value domain is enforced at the type level by
 * `NotificationSeverity`.
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
    // ORDER BY timestamp DESC, id DESC. timestamp leads (not id) because
    // out-of-order `waitUntil` INSERTs can make id order diverge from
    // actual event order; id is the tiebreak.
    timestampIdIdx: index('notification_emit_log_timestamp_id_idx').on(t.timestamp, t.id),
    // Covers severity filter + timestamp DESC sort in one index.
    severityTimestampIdIdx: index('notification_emit_log_severity_timestamp_id_idx').on(
      t.severity,
      t.timestamp,
      t.id,
    ),
    // Covers event-type filter (also serves cause values like 'strategy_cron_error').
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
 * Previous-value snapshot of key `global_config` fields. Each cron tick
 * diffs the fresh read against this table to detect transitions (e.g.
 * dry_run true->false, trading_enabled false->true) and fire a
 * STATE_CHANGE notification.
 *
 * One row per field (`key` primary key), updated via `INSERT OR REPLACE`.
 * `value` is `JSON.stringify`'d so boolean/number/string/null share one
 * column type.
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
 * Per-symbol earnings calendar; risk-gate source for avoiding entries.
 * `earningsGate` reads evalDate +/- freezeBusinessDays and rejects BUY if a
 * matching date exists (avoid-only, not a signal source). Operator-seeded
 * via `/admin/earnings/seed`; `UNIQUE (symbol, earnings_date)` blocks dupes.
 */
export const earningsCalendar = sqliteTable(
  'earnings_calendar',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 銘柄コード (例: 'AAPL', '7203')。upper-case 前提で repo 側が正規化する。 */
    symbol: text('symbol').notNull(),
    /** Earnings date ISO "YYYY-MM-DD". No BMO/AMC distinction — the +/-N business-day window is coarse enough without it. */
    earningsDate: text('earnings_date').notNull(),
    /** 自由 text。'Q2 2026' / 'BMO' / news source 等を operator が任意で残す。 */
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    // Physically blocks (symbol, earnings_date) dupes; bulk seed uses
    // INSERT OR IGNORE. Also covers the gate's (symbol, earnings_date)
    // range read, so no separate plain index is added.
    symbolDateUnique: uniqueIndex('earnings_calendar_symbol_date_unique').on(t.symbol, t.earningsDate),
  }),
)

export type EarningsCalendarRow = typeof earningsCalendar.$inferSelect
export type EarningsCalendarInsert = typeof earningsCalendar.$inferInsert

/**
 * Macro economic event calendar; same avoid-only risk-gate role as
 * `earningsCalendar`. `macroEventGate` freezes BUY entries within +/-N
 * hours of FOMC/CPI/NFP/PCE/GDP/ISM etc. (halts entries, not a signal
 * source). Operator-seeded via `/admin/macro-events/seed`;
 * `UNIQUE (event_type, event_date)` blocks dupes.
 *
 * `event_time` (HH:MM ET) is optional: unset freezes the whole day, set
 * freezes +/-N hours around it (ET via `Intl.DateTimeFormat` with
 * `America/New_York`).
 */
export const macroEventCalendar = sqliteTable(
  'macro_event_calendar',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Event type ('FOMC'/'CPI'/'NFP'/'PCE'/'GDP'/'ISM' etc.), upper-cased by the repo. Included in the gate's reason string, so keep it short. */
    eventType: text('event_type').notNull(),
    /** 発表日 ISO date "YYYY-MM-DD" (ET base — 米国経済指標の慣習)。 */
    eventDate: text('event_date').notNull(),
    /** Release time "HH:MM" ET, 24h. NULL = unknown time, freezes the whole day. E.g. CPI '08:30', FOMC '14:00'. */
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
 * Append-only audit trail of state-changing admin POST calls. One row per
 * mutation; `before_json` / `after_json` are `JSON.stringify`'d snapshots of
 * the affected resource so dashboard can render diffs without re-fetching
 * state.
 *
 * `recordChange()` only writes when before != after — a no-op call (e.g.
 * seed-cash with the same amount) is skipped.
 *
 * `actor` is the CF Access JWT principal (SSO email or service token
 * common_name, set by `accessJwt` middleware) — `extractActor` throws
 * rather than silently defaulting if it's missing. `target_key` is a
 * free-form short string (e.g. `symbol=SOXL`) so one endpoint covering
 * multiple resources can still group rows.
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
    // `/dashboard/audit` reads ORDER BY timestamp DESC; id is the tiebreak
    // for same-timestamp rows (same pattern as notification_emit_log).
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
 * Append-only kill-switch toggle history. `global_config.trading_enabled`
 * holds only the current value; this table keeps who/when/why for every
 * ON/OFF transition. Scoped to kill-switch before/after/reason only — the
 * general admin audit trail is `configAuditLog`.
 */
export const tradingToggleHistory = sqliteTable('trading_toggle_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull(),
  /** CF Access JWT principal (see `accessJwt` middleware / `extractActor`). */
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
 * Daily portfolio equity snapshot, one row per `rollDaily()` call. Persists
 * `PortfolioStateDO.dailyStartEquity` over time so `/dashboard/portfolio`
 * can chart true total assets (cash + holdings), unlike the
 * `/dashboard/charts?tab=overview` curve which only sums
 * `trade_journal.realized_pnl`.
 *
 * USD/JPY are separate columns (not JSON) so multi-currency snapshots don't
 * need ad-hoc parsing; either may be NULL — today only USD is populated,
 * pending a per-currency DO split.
 *
 * Never deduped within a day: repeated manual rolls intentionally produce
 * multiple rows so the audit trail keeps every transition.
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

/**
 * Cache of Webull OpenAPI's actually-orderable-symbol allowlist, sourced
 * from `GET /trade/instrument/tradable/list` (the OpenAPI-tradable set,
 * distinct from the consumer app's trading universe). `instrument/stock/list`'s
 * `status` field can't distinguish deny (both denied and allowed symbols
 * show `OC`), so this allowlist is the only pre-trade signal for it.
 *
 * Upsert-only, never physically deleted: a symbol dropping out of
 * tradable/list just flips `currently_tradable=false`. This keeps
 * reconcile/history intact and makes the `true->false` transition itself a
 * monitoring signal (a held symbol just lost trading eligibility) without
 * blocking orders — the real backstop is the post-417 `TICKER_IS_DENY`
 * auto-disable path.
 */
export const tradableInstrument = sqliteTable(
  'tradable_instrument',
  {
    /** 大文字正規化済みティッカー。 */
    symbol: text('symbol').primaryKey(),
    /** Webull instrument_id (端数 `.000000` を除去して保持)。 */
    instrumentId: text('instrument_id'),
    name: text('name'),
    currency: text('currency'),
    exchangeCode: text('exchange_code'),
    /** 直近の日次 sweep で tradable/list に在籍したか。false = 過去はいたが消失。 */
    currentlyTradable: integer('currently_tradable', { mode: 'boolean' }).notNull().default(true),
    /** 初めて allowlist に観測した時刻 (ISO 8601 UTC)。 */
    firstSeenAt: text('first_seen_at').notNull(),
    /** 直近で allowlist に在籍を確認した時刻 (ISO 8601 UTC)。消失後は更新しない。 */
    lastSeenAt: text('last_seen_at').notNull(),
    /** 行を最後に書いた時刻 (true→false 遷移含む)。 */
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    // 一覧/ワークフローで「現在取扱不可」だけを引くフィルタ用。
    currentlyTradableIdx: index('tradable_instrument_currently_idx').on(t.currentlyTradable),
  }),
)

export type TradableInstrumentRow = typeof tradableInstrument.$inferSelect
export type TradableInstrumentInsert = typeof tradableInstrument.$inferInsert

/**
 * Append-only news/crowd attention observation time series, shared across
 * sources via the `source` column (GDELT report-volume/tone today; room for
 * e.g. a YouTube upload-count producer without a schema fork). Written by
 * `newsScheduler` on the 5-minute cron, read by `newsShockGate`.
 *
 * `UNIQUE (source, probe_key, metric, bucket_at)` is the idempotent-backfill
 * mechanism: GDELT's `timespan=1d` request returns ~96 buckets every tick,
 * so each tick bulk-insert-ignores all of them. A missed tick self-heals on
 * the next one — already-seen buckets collide on the unique index and are
 * skipped, never duplicated.
 */
export const attentionObservation = sqliteTable(
  'attention_observation',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Data source: 'gdelt' (report volume/tone) or 'youtube' (upload count, not yet implemented). */
    source: text('source').notNull(),
    /** probe 定義のキー (`newsProbes.ts` のコード定数と一致)。 */
    probeKey: text('probe_key').notNull(),
    /** 'volume' (report-volume %) / 'tone' (mean tone) / 'upload_count' (not yet implemented). */
    metric: text('metric').notNull(),
    /** 観測 bucket の ISO UTC (GDELT timeline の `date` を正規化した値)。 */
    bucketAt: text('bucket_at').notNull(),
    value: real('value').notNull(),
    /** producer が実際に fetch/insert した時刻 (ISO UTC)。 */
    fetchedAt: text('fetched_at').notNull(),
    requestId: text('request_id'),
  },
  (t) => ({
    // Idempotent-backfill key (see table doc). Also covers newsShockGate's
    // trailing-window range read, like macroEventCalendar, so no separate
    // plain index is added.
    sourceProbeMetricBucketUnique: uniqueIndex(
      'attention_observation_source_probe_metric_bucket_unique',
    ).on(t.source, t.probeKey, t.metric, t.bucketAt),
  }),
)

export type AttentionObservationRow = typeof attentionObservation.$inferSelect
export type AttentionObservationInsert = typeof attentionObservation.$inferInsert

/**
 * Extended-hours (pre-market) reference observation table. Written by
 * `extendedHoursScheduler` on the US pre-market cron window
 * ([open-90min, open)) from Yahoo's `/v8/finance/chart` bars, and read by
 * `extendedHoursGate` (gated by `global_config.extended_hours_gate_mode`).
 * The producer itself never writes `lastQuote` / `QuoteSnapshot` /
 * SymbolStateDO.
 */
export const extendedHoursObservation = sqliteTable(
  'extended_hours_observation',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    /** 観測実行時刻 (ISO UTC)。 */
    capturedAt: text('captured_at').notNull(),
    /** NY ローカル日付 (YYYY-MM-DD)。当日 session の絞り込みに使う。 */
    sessionYmd: text('session_ymd').notNull(),
    status: text('status').notNull(),
    preMarketLast: real('pre_market_last'),
    preMarketLow: real('pre_market_low'),
    prevClose: real('prev_close'),
    gapPct: real('gap_pct'),
    direction15mPct: real('direction_15m_pct'),
    /** 保有時のみ算出。pnlPct(プレマ値基準) - effectiveStopPct。 */
    toStopPct: real('to_stop_pct'),
    lastBarAt: text('last_bar_at'),
    freshnessSec: integer('freshness_sec'),
    requestId: text('request_id'),
  },
  (t) => ({
    symbolIdIndex: index('extended_hours_observation_symbol_id_idx').on(t.symbol, t.id),
  }),
)

export type ExtendedHoursObservationRow = typeof extendedHoursObservation.$inferSelect
export type ExtendedHoursObservationInsert = typeof extendedHoursObservation.$inferInsert

/**
 * Observe-only market-headline + `typesafe/jev` classification log. Written
 * by `headlineEvalScheduler` on the 15-minute slot boundary of the
 * quote-reconcile cron; read by nothing in strategy/risk/execution — this
 * table exists to build a labeled dataset before any gate ever consumes it.
 * One row per attempt (including empty/fetch/AI failures) so gaps in
 * coverage are visible in the data itself, not just in logs.
 *
 * `source` records which feed actually produced the row: `yahoo_finance_rss`
 * (primary) or `google_news_rss` (fallback, used only when the Yahoo fetch
 * itself fails). `UNIQUE (source, evaluated_at)` caps writes at one row per
 * 15-minute slot per source — since the scheduler only ever picks one source
 * per slot, this is one row per slot in practice, mirroring
 * `attentionObservation`'s idempotent-backfill target.
 */
export const newsHeadlineEval = sqliteTable(
  'news_headline_eval',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 評価対象スロットの ISO UTC (15分境界)。 */
    evaluatedAt: text('evaluated_at').notNull(),
    /** 'yahoo_finance_rss' (primary) / 'google_news_rss' (fallback)。 */
    source: text('source').notNull(),
    query: text('query').notNull(),
    headlineCount: integer('headline_count').notNull(),
    /** Array<{ title, source, publishedAt }> の JSON。 */
    headlinesJson: text('headlines_json').notNull(),
    /** 'ok' / 'no_headlines' / 'fetch_error' / 'jev_error'。 */
    status: text('status').notNull(),
    error: text('error'),
    model: text('model'),
    shock: real('shock'),
    direction: text('direction'),
    directionConfidence: real('direction_confidence'),
    severity: real('severity'),
    severityConfidence: real('severity_confidence'),
    scope: text('scope'),
    scopeConfidence: real('scope_confidence'),
    /** jev の answers 生データ (JSON)。 */
    answersJson: text('answers_json'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    requestId: text('request_id'),
  },
  (t) => ({
    sourceEvaluatedAtUnique: uniqueIndex('news_headline_eval_source_evaluated_at_unique').on(
      t.source,
      t.evaluatedAt,
    ),
  }),
)

export type NewsHeadlineEvalRow = typeof newsHeadlineEval.$inferSelect
export type NewsHeadlineEvalInsert = typeof newsHeadlineEval.$inferInsert
