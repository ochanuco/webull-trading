import type { LoadedGlobalConfig } from '../../../infrastructure/db/globalConfigLoader'
import type { SymbolUniverse } from '../../../infrastructure/db/symbolUniverse'
import type { BuyabilityView } from '../../../trading/strategy/entryDistance'
import type { EntryStatus, EntryStatusResult } from '../../../trading/strategy/entryStatus'
import type { PairRegimeDecision } from '../../../trading/strategy/pairRegime'
import type { SymbolAllocation } from '../../../trading/strategy/conditionalAllocation'
import type { EquityPoint, EquityTradeMarker, MonthlyReturn, PeriodReturn } from './equity'
import type { BenchmarkPoint } from './benchmark'
import type { SymbolChartData } from './loaders'
import type { DecisionBreakdownPoint, PnlHistogramBin, TradeStats } from './quality'
import type { DecisionRow } from '../cron'
import { esc } from '../shared'

/**
 * 戦略妥当性チャート (#158)。
 *
 * 設計方針:
 * - ECharts CDN load (jsdelivr)、build step 導入しない (POC scope 維持)
 * - データは `<script>` で window.__chartData に埋込、`</script>` を escape
 * - CDN 失敗時は chart 部分のみ unavailable 表示で fail-graceful
 *
 * Phase 0+1 では equity curve + drawdown のみ。Phase 2-4 で追加予定。
 */

export const ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js'

/**
 * 銘柄チャートタブの client 側初期化スクリプト (`symbolChartScript.ts`) を
 * 配信する静的 route のパス。`symbol.ts` (`<script src>` 参照) と
 * `index.ts` (route 登録) の両方から同じ定数を参照し、path の drift を防ぐ。
 */
export const SYMBOL_CHART_STATIC_PATH = '/dashboard/static/symbol-chart.js'

export type ChartsTab = 'overview' | 'quality' | 'symbol'

export function parseChartsTab(value: string | undefined): ChartsTab {
  if (value === 'quality' || value === 'symbol') return value
  // 旧 銘柄グリッド (#remove-grid): タブ廃止後の旧 URL / ブックマークは
  // 個別銘柄タブへ寄せる (銘柄横断の視点は rail で代替)。
  if (value === 'grid') return 'symbol'
  return 'overview'
}

/**
 * 銘柄タブ内サブビュー (#charts-symbol-redesign)。
 * - `chart`: 判断サマリ + チャート (fold 内で完結させたい既定ビュー)
 * - `detail`: 判定履歴30件 + 戦略パラメータ (長物を分離した別サブタブ)
 */
export type SymbolTabView = 'chart' | 'detail'

export function parseSymbolView(value: string | undefined): SymbolTabView {
  return value === 'detail' ? 'detail' : 'chart'
}

export interface ChartsBodyOverview {
  tab: 'overview'
  equity: EquityPoint[]
  /**
   * equity line に重ねる全銘柄の fill マーカー (#equity-enhance)。
   * additive フィールドなので optional: 省略時はマーカー非表示 (旧呼出互換)。
   */
  tradeMarkers?: EquityTradeMarker[]
  /**
   * QQQ ベンチマーク騰落率系列 (右 y 軸に % で重ねる)。
   * null = Yahoo fetch 失敗 (series 省略、注記のみ表示)。省略も同義。
   */
  benchmark?: BenchmarkPoint[] | null
  /** 期間別リターン (1W / 1M / 3M / YTD / ALL の PnL 変化額)。 */
  periodReturns?: PeriodReturn[]
  /** 月次 (JST) PnL 増分 (bar チャート用)。 */
  monthlyReturns?: MonthlyReturn[]
}

export interface ChartsBodyQuality {
  tab: 'quality'
  decisions: DecisionBreakdownPoint[]
  pnls: number[]
  stats: TradeStats
  histogram: PnlHistogramBin[]
}

/**
 * 戦略パラメータの現在値スナップショット (PullbackUptrendStrategy)。
 * チャート併置パネルで「今どのルールで動いているか」を見せるための
 * read-only view (#168)。default 値からの変更はパネル側で ⚠ flag。
 */
export interface StrategyParamsSnapshot {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  minReturn50d: number
  requireAboveSma50: boolean
  kAtr: number
  /** 過熱ガード閾値 `(price-sma50)/sma50` 上限 (#entry-distance / #overextension)。 */
  maxSma50DeviationPct: number
  /** ボラ過熱ガード閾値 `atr20/baselineAtr20` 上限。 */
  maxAtrRatio: number
  /** #reentry: 再エントリー価格ガード 前回売値からの最小 ATR 下方距離。 */
  reentryMinAtrBelowLastExit: number
  /** #reentry: 再エントリー価格ガードの有効窓 (営業日)。 */
  reentryGuardBusinessDays: number
  /** #stop-rr-cap: stop 幅の上限 = |価格 * takeProfitPct| * これ。0 で無効。 */
  maxStopToTpRatio: number
}

/**
 * global_config の pullback default 群 → `StrategyParamsSnapshot` の組み立てを
 * 1 か所に寄せる (#dashboard-json-api)。SSR 銘柄タブと
 * `/dashboard/charts/symbol/json` が共用する — 2 か所に literal が増えると
 * 「画面のパラメータ表と JSON の rules がずれる」drift になるため、field の
 * 追加・変更は必ずこの関数経由で行うこと。
 */
export function strategyParamsFromGlobal(global: LoadedGlobalConfig): StrategyParamsSnapshot {
  return {
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
    // #reentry: cron の runStrategyCron 既定と一致 (まだ global_config 列なし)。
    reentryMinAtrBelowLastExit: 1.0,
    reentryGuardBusinessDays: 3,
  }
}

/**
 * ISO UTC timestamp (例: "2026-04-15T00:00:00Z") をパースして Date を返す。
 * timezone marker (末尾 Z または ±HH:MM offset) が無い datetime 文字列は
 * `new Date` だと local time 扱いになり (JST runner で意図しないシフト)、
 * JSDoc の "UTC timestamp" 約束に違反する。`T` を含むのに tz が無ければ
 * `Z` を補って UTC と解釈させる。date-only ("2026-04-15") は ECMAScript
 * 仕様で既に UTC 解釈なので変更不要。
 */
export function parseIsoTimestamp(raw: string | undefined): Date | null {
  if (!raw || raw.trim() === '') return null
  let s = raw.trim()
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)
  if (s.includes('T') && !hasTz) {
    s = `${s}Z`
  }
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return null
  return d
}

/** chart の zoom 初期 window 既定: 直近 7 日 (UI で zoom 操作可能) */
export const DEFAULT_ZOOM_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * chart x-axis の zoom 範囲を決める:
 * 1. URL params (zoomFrom / zoomTo) が valid (from < to) → それを採用
 * 2. URL に無い + chart に points がある → 直近 7 日 (lastTimestamp - 7d ～ lastTimestamp)
 * 3. それ以外 (chart 自体空) → null (= 全体表示 / no zoom)
 *
 * lastTimestamp 基準なので、休場日や POC 開始直後で `now()` 基準が data
 * 範囲外になるケースでも broken にならない。
 */
export function computeZoomRange(
  zoomFrom: Date | null,
  zoomTo: Date | null,
  chart: SymbolChartData | null,
): { from: Date; to: Date } | null {
  if (zoomFrom !== null && zoomTo !== null && zoomFrom < zoomTo) {
    return { from: zoomFrom, to: zoomTo }
  }
  if (!chart || chart.points.length === 0) return null
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return null
  return {
    from: new Date(lastMs - DEFAULT_ZOOM_WINDOW_MS),
    to: new Date(lastMs),
  }
}

export interface ChartsBodySymbol {
  tab: 'symbol'
  focusSymbol: string | null
  symbolChart: SymbolChartData | null
  availableSymbols: string[]
  /** focus symbol に適用される effective 値 (global → role preset → override)。 */
  strategyParams: StrategyParamsSnapshot
  /** global_config の値。effective と異なる項目に「銘柄別」タグを付ける比較基準。 */
  strategyParamsGlobal?: StrategyParamsSnapshot
  /** dataZoom 初期範囲。null なら全期間 (full data) */
  zoom: { from: Date; to: Date } | null
  /** symbol picker / chart title を JP 銘柄向け 番号-会社名 形式に整形するための universe。 */
  universe?: SymbolUniverse | null
  /** 入場距離ビュー (#entry-distance)。「入場まであと/いつ頃」の描画用。null = データ無し。 */
  buyability?: BuyabilityView | null
  /** 段階判定 (#452 PR 2)。null = 評価データ無し。 */
  entryStatus?: EntryStatusResult | null
  /** focus symbol のロール / 配分ポリシー要約 (#452)。 */
  symbolPolicy?: SymbolPolicySummary | null
  /**
   * focus symbol の判定履歴 (#decisions-chart-unify)。戦略判定ページと同じ
   * loader/renderer を共用 — チャートの判定 pin と同じデータを表でも読める。
   */
  decisionRows?: DecisionRow[]
  /** ペアレジーム表示 (#472)。regime 有効ペアの一員 + mode != off のときのみ。 */
  pairRegime?: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null
  /** サブビュー (#charts-symbol-redesign)。未指定 (旧 fixture 等) は 'chart' 相当。 */
  view?: SymbolTabView
}

export interface SymbolPolicySummary {
  role: string | null
  /** budget_alloc_pct (fraction)。未設定 (risk-% sizing) は null。 */
  targetWeight: number | null
  entryRequired: boolean
  alwaysActive: boolean
  cashFallbackSymbols: string[] | null
}

export type ChartsBodyArgs =
  | ChartsBodyOverview
  | ChartsBodyQuality
  | ChartsBodySymbol

/**
 * dataZoom プリセット (1D / 5D / 1M / All)。TradingView ライクの 1 click ズーム。
 * lastTimestamp 基準で from/to を data-attr に焼き、client 側 click handler で
 * symChart.dispatchAction({ type: 'dataZoom', startValue, endValue }) を発火する。
 * 既存の dataZoom listener が URL を replaceState で更新するので、preset でも
 * URL ?from / ?to が同期される。
 */
export function renderZoomPresetButtons(chart: SymbolChartData | null): string {
  if (!chart || chart.points.length === 0) return ''
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return ''
  const earliestMs = (() => {
    const first = chart.points[0]
    if (!first) return lastMs
    const ms = new Date(first.timestamp).getTime()
    return Number.isFinite(ms) ? ms : lastMs
  })()
  const day = 24 * 3600 * 1000
  // ラベルは Google Finance JA 準拠 (1日 / 5日 / 1か月 / 最大)。
  const presets: Array<{ label: string; fromMs: number; toMs: number }> = [
    { label: '1日', fromMs: lastMs - 1 * day, toMs: lastMs },
    { label: '5日', fromMs: lastMs - 5 * day, toMs: lastMs },
    { label: '1か月', fromMs: lastMs - 30 * day, toMs: lastMs },
    { label: '最大', fromMs: earliestMs, toMs: lastMs },
  ]
  const buttons = presets
    .map(
      (p) =>
        `<button class="zoom-preset" data-from-ms="${p.fromMs}" data-to-ms="${p.toMs}">${esc(p.label)}</button>`,
    )
    .join('')
  return `<p style="margin:8px 0 0">${buttons}</p>`
}
