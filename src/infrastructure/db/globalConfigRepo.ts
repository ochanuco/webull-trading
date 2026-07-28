import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig, type GlobalConfigRow } from './schema'

export interface GlobalConfigSnapshot {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  /**
   * #session-window-gate: true で開場 30 分前〜引けの窓外は戦略 cron を skip
   * (市場ごと判定)。default false = 従来通り常時評価。
   */
  sessionWindowGateEnabled: boolean
  /**
   * @deprecated Phase E で通貨別 `maxOrderNotionalUsd` / `maxOrderNotionalJpy`
   * に移行。互換目的でロード時も読み出しているが Risk gate は通貨別値を使う。
   */
  maxOrderNotional: number
  maxOrderNotionalUsd: number
  maxOrderNotionalJpy: number
  /** 総資本 USD。null なら portfolio exposure check を skip。 */
  totalCapitalUsd: number | null
  totalCapitalJpy: number | null
  maxPortfolioExposurePct: number
  drawdownKillThreshold: number
  staleQuoteMs: number
  gapRejectPct: number
  spreadLimitPctUs: number
  spreadLimitPctJp: number
  /** Pullback 戦略のデフォルト rule。#118 で hardcoded → D1 化。 */
  pullbackDefaultStopPct: number
  pullbackDefaultTakeProfitPct: number
  pullbackDefaultTimeStopDays: number
  pullbackDefaultPullbackMax: number
  pullbackDefaultPullbackMin: number
  pullbackDefaultMinReturn50d: number
  pullbackDefaultRequireAboveSma50: boolean
  /** ATR multiplier for vol-adaptive stop。default 2.0。 */
  pullbackDefaultKAtr: number
  /** 過熱ガード: SMA50 上方乖離がこの比率超で BUY 見送り (#strategy-overextension-guards)。 */
  pullbackDefaultMaxSma50DeviationPct: number
  /** ボラ過熱ガード: atr20/baselineAtr20 がこの比率超で BUY 見送り。 */
  pullbackDefaultMaxAtrRatio: number
  /** Stop 幅の上限 = |価格 * takeProfitPct| * これ (#stop-rr-cap)。0 で無効。 */
  pullbackDefaultMaxStopToTpRatio: number
  /** 売買コスト見積りの料率 (#trade-cost)。0 で従来どおり gross PnL。 */
  feePctOfNotional: number
  /** 売買コスト見積りの 1 注文固定費 (銘柄通貨建て)。 */
  feeFixedPerOrder: number
  /** baseline ATR から直近 20 本を除外するか (#atr-baseline-window)。 */
  atrBaselineExcludeRecent: boolean
  /** Base risk fraction per trade (0.4% default)。#23 Lane 2。 */
  riskBasePerTradePct: number
  /** drawdown がこの閾値 (負) 未満で size を 0.5× に (-0.05 default)。 */
  riskDdHalfThreshold: number
  /** drawdown がこの閾値 (負) 未満で size を 0 に (-0.10 default)。 */
  riskDdHaltThreshold: number
  /**
   * VIX regime filter (issue #196 3/3)。`^VIX` 最新値がこの閾値超で BUY size を
   * `vixWarningSizeScale` 倍に縮小 (default 25 → x0.5)。
   */
  vixWarningThreshold: number
  /** VIX がこの閾値超で BUY 全停止 (sizeScale=0)。default 30。 */
  vixCriticalThreshold: number
  /** warning 領域の size 倍率。default 0.5。 */
  vixWarningSizeScale: number
  /**
   * 条件連動配分の cash fallback 自動発注 (#452 Layer 3)。default false
   * (fail-closed): off の間は判定・表示のみで退避先への自動 BUY は出さない。
   */
  cashFallbackOrdersEnabled: boolean
  /**
   * ペアレジーム layer (#472)。'off' (default) / 'observe' (log のみ) /
   * 'enforce'。enum 外の DB 値は 'off' に倒す (gate 無効 = 従来挙動が安全側)。
   */
  pairRegimeMode: 'off' | 'observe' | 'enforce'
  /** Schmitt 閾値 (1x proxy 基準、#472)。順序検証は pairRegime 側 (破壊→unknown)。 */
  pairRegimeThetaBullEnter: number
  pairRegimeThetaBullExit: number
  pairRegimeThetaBearEnter: number
  pairRegimeThetaBearExit: number
  /**
   * News shock gate (issue #196 follow-up、news-shock-gate PR 2)。'off'
   * (default) / 'observe' (trace のみ) / 'enforce'。enum 外の DB 値は 'off'
   * に倒す (gate 無効が安全側、pairRegimeMode と同じ規約)。
   */
  newsShockMode: 'off' | 'observe' | 'enforce'
  /** ratio (直近 max / baseline median) がこれを超えると warning。default 2.3 (GDELT 12ヶ月実測 p90)。 */
  newsShockWarnRatio: number
  /** ratio がこれを超え、かつ tone 条件充足で critical。default 4.4 (同 p99)。 */
  newsShockBlockRatio: number
  /** warning 領域の size 倍率。default 0.5。 */
  newsShockWarnSizeScale: number
  /** critical 判定に要求する tone 低下幅 (baselineTone - latestTone)。default 1.5。 */
  newsShockToneDropThreshold: number
  /** true (default) で critical 判定に tone 低下 AND 条件を要求する。 */
  newsShockRequireTone: boolean
  /** baseline (median 母集団) の trailing 日数。default 7。 */
  newsShockBaselineDays: number
  /** baseline サンプル数の下限。未満なら unknown (insufficient_baseline)。default 200。 */
  newsShockMinSamples: number
  /** ratio 分子側 (直近 max) の窓 (分)。default 120。 */
  newsShockWindowMin: number
  /** 最新観測がこれより古ければ unknown (unavailable) 扱い。default 90 (分)。 */
  newsShockMaxAgeMin: number
  /**
   * attention 観測 (GDELT producer) が不可用/不足のときの fail-open/closed
   * 切替。'fail_open' (default) | 'block_buy' (operator escape hatch)。
   */
  attentionStalePolicy: 'fail_open' | 'block_buy'
}

/**
 * Hard defaults used when D1 does not have a `global_config` row yet (i.e.
 * before the initial seed is applied). Matches the previous env-var defaults
 * so existing deployments keep the same behaviour through the cutover.
 */
export const GLOBAL_CONFIG_DEFAULTS: GlobalConfigSnapshot = Object.freeze({
  dryRun: true,
  tradingEnabled: false,
  marketHoursCheck: false,
  sessionWindowGateEnabled: false,
  maxOrderNotional: 100,
  maxOrderNotionalUsd: 2000,
  maxOrderNotionalJpy: 100000,
  totalCapitalUsd: null,
  totalCapitalJpy: null,
  maxPortfolioExposurePct: 0.6,
  drawdownKillThreshold: -0.02,
  staleQuoteMs: 15 * 60 * 1_000,
  gapRejectPct: 0.03,
  spreadLimitPctUs: 0.0025,
  spreadLimitPctJp: 0.006,
  pullbackDefaultStopPct: -0.04,
  pullbackDefaultTakeProfitPct: 0.07,
  pullbackDefaultTimeStopDays: 10,
  pullbackDefaultPullbackMax: -0.03,
  pullbackDefaultPullbackMin: -0.06,
  pullbackDefaultMinReturn50d: 0.08,
  pullbackDefaultRequireAboveSma50: true,
  pullbackDefaultKAtr: 2.0,
  pullbackDefaultMaxSma50DeviationPct: 0.6,
  pullbackDefaultMaxAtrRatio: 1.5,
  pullbackDefaultMaxStopToTpRatio: 2.0,
  feePctOfNotional: 0,
  feeFixedPerOrder: 0,
  atrBaselineExcludeRecent: false,
  riskBasePerTradePct: 0.004,
  riskDdHalfThreshold: -0.05,
  riskDdHaltThreshold: -0.10,
  vixWarningThreshold: 25.0,
  vixCriticalThreshold: 30.0,
  vixWarningSizeScale: 0.5,
  cashFallbackOrdersEnabled: false,
  pairRegimeMode: 'off',
  pairRegimeThetaBullEnter: 0.03,
  pairRegimeThetaBullExit: 0.01,
  pairRegimeThetaBearEnter: -0.04,
  pairRegimeThetaBearExit: -0.015,
  newsShockMode: 'off',
  newsShockWarnRatio: 2.3,
  newsShockBlockRatio: 4.4,
  newsShockWarnSizeScale: 0.5,
  newsShockToneDropThreshold: 1.5,
  newsShockRequireTone: true,
  newsShockBaselineDays: 7,
  newsShockMinSamples: 200,
  newsShockWindowMin: 120,
  newsShockMaxAgeMin: 90,
  attentionStalePolicy: 'fail_open',
})

/**
 * Dashboard overview パネル表示設定 (#dashboard-mf-layout)。`global_config.overview_panels`
 * の CSV を読み書きする。表示専用なので `GlobalConfigSnapshot` / cron 経路には通さず、
 * dashboard だけが参照する独立 read/write。
 */
// #dashboard-ia: status (資産サマリ帯) / positions (保有ポジション) を additive に
// 追加。未設定 (列 NULL/空) の default は全表示。operator が保存済みの CSV は
// そのまま尊重する (新 key は再保存まで OFF)。
export const OVERVIEW_PANELS_DEFAULT = 'status,positions,kpi,equity,composition,recent'

export async function loadOverviewPanelsCsv(db: DrizzleD1Database): Promise<string> {
  try {
    const rows = await db
      .select({ value: globalConfig.overviewPanels })
      .from(globalConfig)
      .where(eq(globalConfig.id, 'default'))
      .limit(1)
    const v = rows[0]?.value
    return typeof v === 'string' && v.trim().length > 0 ? v : OVERVIEW_PANELS_DEFAULT
  } catch {
    // 列未 migration / D1 エラーは全表示 default に倒す (overview は描画継続)。
    return OVERVIEW_PANELS_DEFAULT
  }
}

/**
 * overview_panels を upsert で書く。row 未 seed でも作れ、同時 POST でも INSERT
 * 主キー衝突しない (CodeRabbit #397)。
 *
 * 旧値 read と write を **同一 D1 batch (= 1 transaction)** に束ね、監査ログ用の
 * `before` が write と原子境界を共有するようにする (CodeRabbit #397 2nd round:
 * 別操作だと同時更新で before/after がズレ誤監査になる)。`before` を返す。
 * 他列は schema default 任せ。
 */
export async function setOverviewPanels(
  db: DrizzleD1Database,
  csv: string,
  nowIso: string,
): Promise<{ before: string }> {
  const results = await db.batch([
    db
      .select({ value: globalConfig.overviewPanels })
      .from(globalConfig)
      .where(eq(globalConfig.id, 'default'))
      .limit(1),
    db
      .insert(globalConfig)
      .values({ id: 'default', overviewPanels: csv, updatedAt: nowIso })
      .onConflictDoUpdate({
        target: globalConfig.id,
        set: { overviewPanels: csv, updatedAt: nowIso },
      }),
  ])
  const beforeRows = results[0] as Array<{ value: string | null }>
  const prev = beforeRows[0]?.value
  return { before: typeof prev === 'string' && prev.trim().length > 0 ? prev : OVERVIEW_PANELS_DEFAULT }
}

/**
 * VIX 値の application-level validation。
 *
 * 0015 migration は ALTER TABLE ADD COLUMN しか実行しておらず CHECK 制約は
 * 将来の table-rebuild migration で一括投入予定 (schema.ts 参照)。それまでの
 * 補完として、`loadGlobalConfig` が返す前にここで範囲・順序を検証する。
 *
 * 違反時は **fail-closed = defaults fallback**:
 * - cron 全停止より既知 default で動かす方が POC では安全
 * - warn ログに違反 field / 値 / 期待範囲を出して運用で検知できるようにする
 *
 * CodeRabbit #216 6th round 対応。
 */
function validateVixConfig(
  config: GlobalConfigSnapshot,
  requestId: string | undefined,
): GlobalConfigSnapshot {
  const violations: Array<{ field: string; value: unknown; expected: string }> = []
  const { vixWarningThreshold, vixCriticalThreshold, vixWarningSizeScale } = config

  if (!(vixWarningThreshold > 0 && vixWarningThreshold <= 200)) {
    violations.push({
      field: 'vixWarningThreshold',
      value: vixWarningThreshold,
      expected: '>0 and <=200',
    })
  }
  if (!(vixCriticalThreshold > 0 && vixCriticalThreshold <= 200)) {
    violations.push({
      field: 'vixCriticalThreshold',
      value: vixCriticalThreshold,
      expected: '>0 and <=200',
    })
  }
  if (vixWarningThreshold > vixCriticalThreshold) {
    violations.push({
      field: 'vixWarningThreshold/vixCriticalThreshold',
      value: { warning: vixWarningThreshold, critical: vixCriticalThreshold },
      expected: 'warning <= critical',
    })
  }
  if (!(vixWarningSizeScale >= 0 && vixWarningSizeScale <= 1)) {
    violations.push({
      field: 'vixWarningSizeScale',
      value: vixWarningSizeScale,
      expected: '>=0 and <=1',
    })
  }

  if (violations.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'global_config_vix_validation_failed',
        requestId: requestId ?? null,
        violations,
      }),
    )
    return {
      ...config,
      vixWarningThreshold: GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
      vixCriticalThreshold: GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
      vixWarningSizeScale: GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
    }
  }

  return config
}

/**
 * News shock config の application-level validation (news-shock-gate PR 2)。
 * `validateVixConfig` と同じ層防御: 0042 migration は ALTER TABLE ADD COLUMN
 * のみで DB CHECK を持たないため、範囲・順序をここで検証する。
 *
 * enum field (`newsShockMode` / `attentionStalePolicy`) はここでは扱わない —
 * `pairRegimeMode` と同じく、呼び出し側 (`loadGlobalConfig` の row マッピング)
 * で enum 外の値を安全側 default に inline で倒す。ここは数値 field の
 * 範囲・順序だけを見る。
 *
 * 違反時は該当する **数値 field のみ** defaults へ差し替える (mode はここでは
 * 変更しない)。cron 全停止より既知 default で動かす方が安全という判断。
 */
function validateNewsShockConfig(
  config: GlobalConfigSnapshot,
  requestId: string | undefined,
): GlobalConfigSnapshot {
  const violations: Array<{ field: string; value: unknown; expected: string }> = []
  const {
    newsShockWarnRatio,
    newsShockBlockRatio,
    newsShockWarnSizeScale,
    newsShockToneDropThreshold,
    newsShockBaselineDays,
    newsShockMinSamples,
    newsShockWindowMin,
    newsShockMaxAgeMin,
  } = config

  if (!(newsShockWarnRatio > 0 && newsShockWarnRatio <= 100)) {
    violations.push({ field: 'newsShockWarnRatio', value: newsShockWarnRatio, expected: '>0 and <=100' })
  }
  if (!(newsShockBlockRatio > 0 && newsShockBlockRatio <= 100)) {
    violations.push({ field: 'newsShockBlockRatio', value: newsShockBlockRatio, expected: '>0 and <=100' })
  }
  if (newsShockWarnRatio > newsShockBlockRatio) {
    violations.push({
      field: 'newsShockWarnRatio/newsShockBlockRatio',
      value: { warn: newsShockWarnRatio, block: newsShockBlockRatio },
      expected: 'warn <= block',
    })
  }
  if (!(newsShockWarnSizeScale >= 0 && newsShockWarnSizeScale <= 1)) {
    violations.push({
      field: 'newsShockWarnSizeScale',
      value: newsShockWarnSizeScale,
      expected: '>=0 and <=1',
    })
  }
  if (!(newsShockToneDropThreshold >= 0 && newsShockToneDropThreshold <= 100)) {
    violations.push({
      field: 'newsShockToneDropThreshold',
      value: newsShockToneDropThreshold,
      expected: '>=0 and <=100',
    })
  }
  if (!(Number.isInteger(newsShockBaselineDays) && newsShockBaselineDays > 0 && newsShockBaselineDays <= 365)) {
    violations.push({ field: 'newsShockBaselineDays', value: newsShockBaselineDays, expected: 'integer >0 and <=365' })
  }
  if (!(Number.isInteger(newsShockMinSamples) && newsShockMinSamples > 0 && newsShockMinSamples <= 1_000_000)) {
    violations.push({ field: 'newsShockMinSamples', value: newsShockMinSamples, expected: 'integer >0 and <=1000000' })
  }
  if (!(Number.isInteger(newsShockWindowMin) && newsShockWindowMin > 0 && newsShockWindowMin <= 10_080)) {
    violations.push({ field: 'newsShockWindowMin', value: newsShockWindowMin, expected: 'integer >0 and <=10080 (1 week in minutes)' })
  }
  if (!(Number.isInteger(newsShockMaxAgeMin) && newsShockMaxAgeMin > 0 && newsShockMaxAgeMin <= 10_080)) {
    violations.push({ field: 'newsShockMaxAgeMin', value: newsShockMaxAgeMin, expected: 'integer >0 and <=10080 (1 week in minutes)' })
  }

  if (violations.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'global_config_news_shock_validation_failed',
        requestId: requestId ?? null,
        violations,
      }),
    )
    return {
      ...config,
      newsShockWarnRatio: GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
      newsShockBlockRatio: GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
      newsShockWarnSizeScale: GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
      newsShockToneDropThreshold: GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
      newsShockBaselineDays: GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
      newsShockMinSamples: GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
      newsShockWindowMin: GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
      newsShockMaxAgeMin: GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
    }
  }

  return config
}

export async function loadGlobalConfig(
  db: DrizzleD1Database,
  requestId?: string,
): Promise<GlobalConfigSnapshot> {
  // VIX 列 (vix_warning_threshold / vix_critical_threshold / vix_warning_size_scale)
  // は migration 0015 で追加。pre-0015 deploy / ALTER 適用前の D1 では `select` 自体が
  // SQL レベルで失敗するため、`row.vixXxx ?? defaults` の null fallback では救えない。
  // ここでは query 境界を try/catch で囲み、「missing column」を文字列マッチで検知して
  // defaults を返す段階デプロイ救済を行う (POC 用フォールバック)。それ以外のエラーは
  // 上に再 throw して fail-closed を維持する。
  //
  // Regex は **schema-missing 限定**で組む: `vix_` 単独マッチを許すと非スキーマ
  // 障害メッセージに `vix_` が偶然含まれただけで fail-open 化するリスクがあるため、
  // SQLite 系の `no such column: vix_*` か、`vix_<col> not found / does not exist /
  // unknown column` 形式に絞る (CodeRabbit 2nd round 指摘)。
  //
  // news-shock-gate PR 2: 0042 migration (`news_shock_*` / `attention_stale_policy`)
  // 未適用の環境でも同じ「SELECT が SQL レベルで落ちる」罠を踏む。同じ
  // schema-missing 限定パターンで `news_shock_` / `attention_stale_policy` も
  // 拾う (単純な `news_shock` 部分一致は他エラーに偶然含まれた場合の fail-open
  // リスクがあるため避け、`no such column:` / `not found|does not exist|unknown
  // column` 形式に絞る — vix と同じ規約)。
  const MISSING_COLUMN_PATTERN = '(?:vix_[a-z_]*|news_shock_[a-z_]*|attention_stale_policy)'
  let rows: GlobalConfigRow[]
  try {
    rows = await db.select().from(globalConfig).where(eq(globalConfig.id, 'default')).limit(1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isMissingVixColumn =
      new RegExp(`no such column:\\s*${MISSING_COLUMN_PATTERN}`, 'i').test(message) ||
      new RegExp(`${MISSING_COLUMN_PATTERN}\\s+(not found|does not exist|unknown column)`, 'i').test(message)
    if (isMissingVixColumn) {
      console.warn(
        JSON.stringify({
          event: 'global_config_pre_0015_fallback',
          requestId: requestId ?? null,
          message,
        }),
      )
      // 段階デプロイ救済: VIX 3 列だけ defaults で埋め、他の列は legacy row から
      // 読み出す。`{ ...GLOBAL_CONFIG_DEFAULTS }` で全部上書きすると
      // `tradingEnabled: false` のような既存運用値が `tradingEnabled: true` (default)
      // で踏み潰されるリスクがある。明示的に vix_ 以外の列だけを select し、
      // defaults と shallow-merge する。
      try {
        const legacyRows = await db
          .select({
            id: globalConfig.id,
            dryRun: globalConfig.dryRun,
            tradingEnabled: globalConfig.tradingEnabled,
            marketHoursCheck: globalConfig.marketHoursCheck,
            maxOrderNotional: globalConfig.maxOrderNotional,
            maxOrderNotionalUsd: globalConfig.maxOrderNotionalUsd,
            maxOrderNotionalJpy: globalConfig.maxOrderNotionalJpy,
            totalCapitalUsd: globalConfig.totalCapitalUsd,
            totalCapitalJpy: globalConfig.totalCapitalJpy,
            maxPortfolioExposurePct: globalConfig.maxPortfolioExposurePct,
            drawdownKillThreshold: globalConfig.drawdownKillThreshold,
            staleQuoteMs: globalConfig.staleQuoteMs,
            gapRejectPct: globalConfig.gapRejectPct,
            spreadLimitPctUs: globalConfig.spreadLimitPctUs,
            spreadLimitPctJp: globalConfig.spreadLimitPctJp,
            pullbackDefaultStopPct: globalConfig.pullbackDefaultStopPct,
            pullbackDefaultTakeProfitPct: globalConfig.pullbackDefaultTakeProfitPct,
            pullbackDefaultTimeStopDays: globalConfig.pullbackDefaultTimeStopDays,
            pullbackDefaultPullbackMax: globalConfig.pullbackDefaultPullbackMax,
            pullbackDefaultPullbackMin: globalConfig.pullbackDefaultPullbackMin,
            pullbackDefaultMinReturn50d: globalConfig.pullbackDefaultMinReturn50d,
            pullbackDefaultRequireAboveSma50: globalConfig.pullbackDefaultRequireAboveSma50,
            pullbackDefaultKAtr: globalConfig.pullbackDefaultKAtr,
            pullbackDefaultMaxSma50DeviationPct: globalConfig.pullbackDefaultMaxSma50DeviationPct,
            pullbackDefaultMaxAtrRatio: globalConfig.pullbackDefaultMaxAtrRatio,
            pullbackDefaultMaxStopToTpRatio: globalConfig.pullbackDefaultMaxStopToTpRatio,
            feePctOfNotional: globalConfig.feePctOfNotional,
            feeFixedPerOrder: globalConfig.feeFixedPerOrder,
            atrBaselineExcludeRecent: globalConfig.atrBaselineExcludeRecent,
            riskBasePerTradePct: globalConfig.riskBasePerTradePct,
            riskDdHalfThreshold: globalConfig.riskDdHalfThreshold,
            riskDdHaltThreshold: globalConfig.riskDdHaltThreshold,
          })
          .from(globalConfig)
          .where(eq(globalConfig.id, 'default'))
          .limit(1)
        const legacyRow = legacyRows[0]
        if (legacyRow) {
          return validateNewsShockConfig(validateVixConfig({
            dryRun: legacyRow.dryRun,
            tradingEnabled: legacyRow.tradingEnabled,
            marketHoursCheck: legacyRow.marketHoursCheck,
            maxOrderNotional: legacyRow.maxOrderNotional,
            maxOrderNotionalUsd: legacyRow.maxOrderNotionalUsd,
            maxOrderNotionalJpy: legacyRow.maxOrderNotionalJpy,
            totalCapitalUsd: legacyRow.totalCapitalUsd,
            totalCapitalJpy: legacyRow.totalCapitalJpy,
            maxPortfolioExposurePct: legacyRow.maxPortfolioExposurePct,
            drawdownKillThreshold: legacyRow.drawdownKillThreshold,
            staleQuoteMs: legacyRow.staleQuoteMs,
            gapRejectPct: legacyRow.gapRejectPct,
            spreadLimitPctUs: legacyRow.spreadLimitPctUs,
            spreadLimitPctJp: legacyRow.spreadLimitPctJp,
            pullbackDefaultStopPct: legacyRow.pullbackDefaultStopPct,
            pullbackDefaultTakeProfitPct: legacyRow.pullbackDefaultTakeProfitPct,
            pullbackDefaultTimeStopDays: legacyRow.pullbackDefaultTimeStopDays,
            pullbackDefaultPullbackMax: legacyRow.pullbackDefaultPullbackMax,
            pullbackDefaultPullbackMin: legacyRow.pullbackDefaultPullbackMin,
            pullbackDefaultMinReturn50d: legacyRow.pullbackDefaultMinReturn50d,
            pullbackDefaultRequireAboveSma50: legacyRow.pullbackDefaultRequireAboveSma50,
            pullbackDefaultKAtr: legacyRow.pullbackDefaultKAtr,
            pullbackDefaultMaxSma50DeviationPct: legacyRow.pullbackDefaultMaxSma50DeviationPct,
            pullbackDefaultMaxAtrRatio: legacyRow.pullbackDefaultMaxAtrRatio,
            // 0038 追加列 (#stop-rr-cap)。legacy path は default。
            pullbackDefaultMaxStopToTpRatio: GLOBAL_CONFIG_DEFAULTS.pullbackDefaultMaxStopToTpRatio,
            // 0039 追加列 (#trade-cost)。legacy path は default (= gross PnL)。
            feePctOfNotional: GLOBAL_CONFIG_DEFAULTS.feePctOfNotional,
            feeFixedPerOrder: GLOBAL_CONFIG_DEFAULTS.feeFixedPerOrder,
            // 0040 追加列 (#atr-baseline-window)。legacy path は default (従来窓)。
            atrBaselineExcludeRecent: GLOBAL_CONFIG_DEFAULTS.atrBaselineExcludeRecent,
            riskBasePerTradePct: legacyRow.riskBasePerTradePct,
            riskDdHalfThreshold: legacyRow.riskDdHalfThreshold,
            riskDdHaltThreshold: legacyRow.riskDdHaltThreshold,
            // VIX 3 項目だけ defaults (列が存在しないので legacy row には無い)
            vixWarningThreshold: GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
            vixCriticalThreshold: GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
            vixWarningSizeScale: GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
            // 0036 追加列 (#session-window-gate)。legacy path は default (false = 常時評価)。
            sessionWindowGateEnabled: GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
            // 0030 追加列 (#452)。legacy path は default (false = 自動発注しない)。
            cashFallbackOrdersEnabled: GLOBAL_CONFIG_DEFAULTS.cashFallbackOrdersEnabled,
            // 0031 追加列 (#472)。legacy path は default ('off' = gate 無効)。
            pairRegimeMode: GLOBAL_CONFIG_DEFAULTS.pairRegimeMode,
            pairRegimeThetaBullEnter: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullEnter,
            pairRegimeThetaBullExit: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullExit,
            pairRegimeThetaBearEnter: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearEnter,
            pairRegimeThetaBearExit: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearExit,
            // 0042 追加列 (news-shock-gate PR 2)。legacy path は default ('off' = gate 無効)。
            newsShockMode: GLOBAL_CONFIG_DEFAULTS.newsShockMode,
            newsShockWarnRatio: GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
            newsShockBlockRatio: GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
            newsShockWarnSizeScale: GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
            newsShockToneDropThreshold: GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
            newsShockRequireTone: GLOBAL_CONFIG_DEFAULTS.newsShockRequireTone,
            newsShockBaselineDays: GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
            newsShockMinSamples: GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
            newsShockWindowMin: GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
            newsShockMaxAgeMin: GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
            attentionStalePolicy: GLOBAL_CONFIG_DEFAULTS.attentionStalePolicy,
          }, requestId), requestId)
        }
      } catch (legacyError) {
        // legacy fetch も失敗 → 想定外の double failure。ここまで来たら全 defaults
        // で fail-open を選ぶ (cron 全停止より既知 default で動かす)。
        console.warn(
          JSON.stringify({
            event: 'global_config_legacy_load_failed',
            requestId: requestId ?? null,
            message: legacyError instanceof Error ? legacyError.message : String(legacyError),
          }),
        )
      }
      // legacy row なし or legacy fetch 失敗 → 全 defaults
      return validateNewsShockConfig(validateVixConfig({ ...GLOBAL_CONFIG_DEFAULTS }, requestId), requestId)
    }
    throw error
  }
  const row = rows[0]
  if (!row) return validateNewsShockConfig(validateVixConfig({ ...GLOBAL_CONFIG_DEFAULTS }, requestId), requestId)
  return validateNewsShockConfig(validateVixConfig({
    dryRun: row.dryRun,
    tradingEnabled: row.tradingEnabled,
    marketHoursCheck: row.marketHoursCheck,
    maxOrderNotional: row.maxOrderNotional,
    maxOrderNotionalUsd: row.maxOrderNotionalUsd,
    maxOrderNotionalJpy: row.maxOrderNotionalJpy,
    totalCapitalUsd: row.totalCapitalUsd,
    totalCapitalJpy: row.totalCapitalJpy,
    maxPortfolioExposurePct: row.maxPortfolioExposurePct,
    drawdownKillThreshold: row.drawdownKillThreshold,
    staleQuoteMs: row.staleQuoteMs,
    gapRejectPct: row.gapRejectPct,
    spreadLimitPctUs: row.spreadLimitPctUs,
    spreadLimitPctJp: row.spreadLimitPctJp,
    pullbackDefaultStopPct: row.pullbackDefaultStopPct,
    pullbackDefaultTakeProfitPct: row.pullbackDefaultTakeProfitPct,
    pullbackDefaultTimeStopDays: row.pullbackDefaultTimeStopDays,
    pullbackDefaultPullbackMax: row.pullbackDefaultPullbackMax,
    pullbackDefaultPullbackMin: row.pullbackDefaultPullbackMin,
    pullbackDefaultMinReturn50d: row.pullbackDefaultMinReturn50d,
    pullbackDefaultRequireAboveSma50: row.pullbackDefaultRequireAboveSma50,
    pullbackDefaultKAtr: row.pullbackDefaultKAtr,
    pullbackDefaultMaxSma50DeviationPct: row.pullbackDefaultMaxSma50DeviationPct,
    pullbackDefaultMaxAtrRatio: row.pullbackDefaultMaxAtrRatio,
    pullbackDefaultMaxStopToTpRatio: row.pullbackDefaultMaxStopToTpRatio,
    feePctOfNotional: row.feePctOfNotional,
    feeFixedPerOrder: row.feeFixedPerOrder,
    atrBaselineExcludeRecent: row.atrBaselineExcludeRecent,
    riskBasePerTradePct: row.riskBasePerTradePct,
    riskDdHalfThreshold: row.riskDdHalfThreshold,
    riskDdHaltThreshold: row.riskDdHaltThreshold,
    // VIX 列は 0015 で追加。古い D1 (snapshot 取得失敗 / ALTER 直前 race) では
    // undefined になり得るため、defaults へ畳む (snapshot 経由 read だが safety)。
    // schema 自体の欠落は上の try/catch で defaults fallback する。
    vixWarningThreshold:
      row.vixWarningThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
    vixCriticalThreshold:
      row.vixCriticalThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
    vixWarningSizeScale:
      row.vixWarningSizeScale ?? GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
    // 0036 で追加 (#session-window-gate)。古い D1 では undefined になり得るため
    // default (false = 常時評価) へ畳む — 従来挙動側なので安全。
    sessionWindowGateEnabled:
      row.sessionWindowGateEnabled ?? GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
    // 0030 で追加 (#452)。古い D1 では undefined になり得るため default (false =
    // 自動発注しない) へ畳む — fail-closed 側なので安全。
    cashFallbackOrdersEnabled:
      row.cashFallbackOrdersEnabled ?? GLOBAL_CONFIG_DEFAULTS.cashFallbackOrdersEnabled,
    // 0031 で追加 (#472)。mode は enum 検証して不正値は 'off' (gate 無効が安全側)。
    pairRegimeMode:
      row.pairRegimeMode === 'observe' || row.pairRegimeMode === 'enforce'
        ? row.pairRegimeMode
        : 'off',
    pairRegimeThetaBullEnter:
      row.pairRegimeThetaBullEnter ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullEnter,
    pairRegimeThetaBullExit:
      row.pairRegimeThetaBullExit ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullExit,
    pairRegimeThetaBearEnter:
      row.pairRegimeThetaBearEnter ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearEnter,
    pairRegimeThetaBearExit:
      row.pairRegimeThetaBearExit ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearExit,
    // 0042 で追加 (news-shock-gate PR 2)。古い D1 (ALTER 直前 race / undefined) は
    // default へ畳む。mode は enum 検証して不正値は 'off' (gate 無効が安全側)。
    newsShockMode:
      row.newsShockMode === 'observe' || row.newsShockMode === 'enforce' ? row.newsShockMode : 'off',
    newsShockWarnRatio: row.newsShockWarnRatio ?? GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
    newsShockBlockRatio: row.newsShockBlockRatio ?? GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
    newsShockWarnSizeScale: row.newsShockWarnSizeScale ?? GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
    newsShockToneDropThreshold:
      row.newsShockToneDropThreshold ?? GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
    newsShockRequireTone: row.newsShockRequireTone ?? GLOBAL_CONFIG_DEFAULTS.newsShockRequireTone,
    newsShockBaselineDays: row.newsShockBaselineDays ?? GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
    newsShockMinSamples: row.newsShockMinSamples ?? GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
    newsShockWindowMin: row.newsShockWindowMin ?? GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
    newsShockMaxAgeMin: row.newsShockMaxAgeMin ?? GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
    // attention_stale_policy は enum 検証。不正値は 'fail_open' (既存 gate 全体と
    // 同じ判断が安全側) に倒す。
    attentionStalePolicy: row.attentionStalePolicy === 'block_buy' ? 'block_buy' : 'fail_open',
  }, requestId), requestId)
}
