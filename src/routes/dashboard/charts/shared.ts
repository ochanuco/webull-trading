import type { LoadedGlobalConfig } from '../../../infrastructure/db/globalConfigLoader'
import type { SymbolUniverse } from '../../../infrastructure/db/symbolUniverse'
import type { BuyabilityView } from '../../../trading/strategy/entryDistance'
import type { EntryStatus, EntryStatusResult } from '../../../trading/strategy/entryStatus'
import type { PairRegimeDecision } from '../../../trading/strategy/pairRegime'
import type { SymbolAllocation } from '../../../trading/strategy/conditionalAllocation'
import type { EquityPoint, EquityTradeMarker, MonthlyReturn, PeriodReturn } from './equity'
import type { BenchmarkPoint } from './benchmark'
import type { SymbolChartData } from './loaders'
import type { SkipReasonBreakdownPoint, SymbolStat, TradeStats } from './quality'
import type { DecisionRow } from '../cron'
import { esc } from '../shared'

export const ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js'

/**
 * Shared by `symbol.ts` (`<script src>`) and `index.ts` (route
 * registration) so the two can't drift onto different paths.
 */
export const SYMBOL_CHART_STATIC_PATH = '/dashboard/static/symbol-chart.js'

export type ChartsTab = 'overview' | 'quality' | 'symbol'

export function parseChartsTab(value: string | undefined): ChartsTab {
  if (value === 'quality' || value === 'symbol') return value
  // Legacy 'grid' tab value (bookmarked URLs) maps to 'symbol', its closest
  // replacement, instead of falling through to 'overview'.
  if (value === 'grid') return 'symbol'
  return 'overview'
}

export type SymbolTabView = 'chart' | 'detail'

export function parseSymbolView(value: string | undefined): SymbolTabView {
  return value === 'detail' ? 'detail' : 'chart'
}

export type QualityPeriod = '30d' | '90d' | 'all'

export function parseQualityPeriod(value: string | undefined): QualityPeriod {
  if (value === '30d' || value === '90d') return value
  return 'all'
}

export const QUALITY_PERIOD_LABELS: Record<QualityPeriod, string> = {
  '30d': '直近30日',
  '90d': '直近90日',
  all: '全期間',
}

export interface ChartsBodyOverview {
  tab: 'overview'
  equity: EquityPoint[]
  /** Optional for old-callsite compatibility; omitted means markers are hidden, not "load failed". */
  tradeMarkers?: EquityTradeMarker[]
  /** null = Yahoo fetch failed (series omitted, note-only display). Omitted is equivalent. */
  benchmark?: BenchmarkPoint[] | null
  periodReturns?: PeriodReturn[]
  monthlyReturns?: MonthlyReturn[]
}

export interface ChartsBodyQuality {
  tab: 'quality'
  period: QualityPeriod
  asOfJst: string
  /** Whether any trade exists before `?period=` filtering — false means no fills yet, not "none in this period". */
  hasTradeData: boolean
  stats: TradeStats
  symbolStats: SymbolStat[]
  /** Fixed 90-day window, independent of `?period=` (see loadSkipReasonBreakdown). */
  skipBreakdown: SkipReasonBreakdownPoint[]
}

/** Read-only snapshot of PullbackUptrendStrategy's current parameters, for the chart's side panel. */
export interface StrategyParamsSnapshot {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  minReturn50d: number
  requireAboveSma50: boolean
  kAtr: number
  /** Upper bound on `(price-sma50)/sma50` — the overextension entry guard. */
  maxSma50DeviationPct: number
  /** Upper bound on `atr20/baselineAtr20` — the vol-overextension entry guard. */
  maxAtrRatio: number
  /** Minimum ATR distance below the last exit price required to re-enter. */
  reentryMinAtrBelowLastExit: number
  /** Business days the re-entry price guard stays active. */
  reentryGuardBusinessDays: number
  /** Stop width cap = |price * takeProfitPct| * this. 0 disables the cap. */
  maxStopToTpRatio: number
}

/**
 * Single builder for global_config's pullback defaults → StrategyParamsSnapshot,
 * shared by the SSR symbol tab and `/dashboard/charts/symbol/json` so the
 * two can't drift onto different field sets.
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
    // No global_config column yet — hardcoded to match runStrategyCron's own default.
    reentryMinAtrBelowLastExit: 1.0,
    reentryGuardBusinessDays: 3,
  }
}

/**
 * Parses an ISO UTC timestamp. A datetime with no timezone marker (`Z` or
 * ±HH:MM) would otherwise parse as local time under `new Date` — wrong on a
 * JST runner — so `Z` is appended when `T` is present without one. A
 * date-only string ("2026-04-15") is already UTC under ECMAScript, so it's
 * left alone.
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

export const DEFAULT_ZOOM_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * Resolves the chart's initial zoom range: explicit URL params (`zoomFrom`/
 * `zoomTo`, if `from < to`) win; otherwise falls back to the last 7 days
 * ending at the chart's own last point, not `now()` — a `now()` basis would
 * land outside the data range on a market holiday or right after data
 * collection starts.
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
  /** Effective value for focusSymbol (global → role preset → override). */
  strategyParams: StrategyParamsSnapshot
  /** Global default, used as the comparison baseline to flag params that differ per-symbol. */
  strategyParamsGlobal?: StrategyParamsSnapshot
  /** Initial dataZoom range; null shows the full data range. */
  zoom: { from: Date; to: Date } | null
  /** For formatting the symbol picker / chart title as JP-style "number - company name". */
  universe?: SymbolUniverse | null
  buyability?: BuyabilityView | null
  entryStatus?: EntryStatusResult | null
  symbolPolicy?: SymbolPolicySummary | null
  /** Shares the strategy-decisions page's own loader/renderer, so the table matches the chart's decision pins. */
  decisionRows?: DecisionRow[]
  /** Only set when focusSymbol is in a regime-enabled pair with mode != off. */
  pairRegime?: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null
  /** Undefined (old fixtures) behaves as 'chart'. */
  view?: SymbolTabView
}

export interface SymbolPolicySummary {
  role: string | null
  /** budget_alloc_pct (fraction); null when sized by risk-% instead. */
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
 * One-click dataZoom presets (1D/5D/1M/All). from/to are baked into each
 * button's data attrs at the last chart point; the client click handler
 * dispatches a `dataZoom` action from them, which the existing dataZoom
 * listener already syncs to the URL via replaceState.
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
