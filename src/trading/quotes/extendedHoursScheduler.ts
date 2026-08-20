/**
 * Extended-hours (pre-market) reference observation producer (issue #709 Phase 1)。
 *
 * `newsScheduler` と同じ「cron から呼ばれる producer」の位置づけで、
 * `CRON_QUOTE_RECONCILE` (5分毎) にぶら下がる。US プレマーケット帯
 * ([開場-90分, 開場)) の間だけ Yahoo `/v8/finance/chart` の時間外 1分足を取り、
 * `extended_hours_observation` に保存する。**取引経路 (strategy/risk/execution)
 * からは一切参照されない参考情報** — `SymbolStateDO` への write も
 * `lastQuote` / `QuoteSnapshot` への write も行わない (read のみ)。
 *
 * fetch / DB 失敗は絶対に throw しない — 呼び出し元の cron (index.ts の
 * `ctx.waitUntil`) に伝播させず、既存ログ形式 (`console.warn(JSON.stringify(...))`)
 * で握りつぶす (`newsScheduler` と同じ配線パターン)。個別銘柄の Yahoo fetch
 * 失敗は全体を止めず、その銘柄だけ status=UNKNOWN の行として保存する。
 */
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import {
  createExtendedHoursObservationDb,
  createExtendedHoursObservationRepo,
  type ExtendedHoursObservationRecord,
} from '../../infrastructure/db/extendedHoursObservationRepo'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import {
  YahooExtendedHoursClient,
  type PreMarketBar,
  type PreMarketSeries,
} from '../../infrastructure/quotes/YahooExtendedHoursClient'
import { evaluateStrategyWindow, isWithinStrategyWindow } from '../domain/tradingCalendar'
import { buildSymbolRules } from '../strategy/symbolRuleResolution'
import { resolveStopDistance } from '../strategy/stopDistance'
import type { SymbolRule } from '../strategy/strategies/PullbackUptrendStrategy'
import { SymbolStateClient } from '../state/SymbolStateClient'

/** [開場 - 90分, 開場) の帯だけ稼働する (US プレマーケット)。 */
const PREMARKET_LEAD_MINUTES = 90
/** gap が -3% 以下なら WARNING。 */
const GAP_WARNING_PCT = -3
/** stop までの距離が 2% 以下なら WARNING。 */
const TO_STOP_WARNING_PCT = 2
/** 最終 bar から 20 分以上 stale なら UNKNOWN。 */
const STALE_FRESHNESS_SEC = 20 * 60

type ExtendedHoursStatus = 'NORMAL' | 'WARNING' | 'STOP_AT_OPEN_CANDIDATE' | 'UNKNOWN'

export interface ExtendedHoursObservationSummary {
  ran: boolean
  reason?: string
  symbols: number
  persisted: number
  statuses: Record<string, number>
  errors: number
}

interface RunExtendedHoursObservationOptions {
  env: Env
  requestId?: string
  now?: () => Date
  /** test seam。未指定なら本番 `YahooExtendedHoursClient` を使う。 */
  client?: YahooExtendedHoursClient
}

export interface AssessPreMarketInput {
  series: PreMarketSeries | null
  now: Date
  /** qty>0 / avgPrice>0 の保有時のみ toStopPct を算出する。 */
  position?: { qty: number; avgPrice: number } | null
  rule?: SymbolRule
  atr20?: number | null
}

export interface AssessPreMarketResult {
  status: ExtendedHoursStatus
  preMarketLast: number | null
  preMarketLow: number | null
  prevClose: number | null
  gapPct: number | null
  direction15mPct: number | null
  toStopPct: number | null
  lastBarAt: string | null
  freshnessSec: number | null
}

/**
 * pure function — Yahoo series + (任意) position/rule/atr20 から表示指標と
 * status を導出する。副作用なしなのでユニットテストで status 4 種を直接検証できる。
 */
export function assessPreMarket(input: AssessPreMarketInput): AssessPreMarketResult {
  const { series, now } = input
  if (!series || series.bars.length === 0) {
    return {
      status: 'UNKNOWN',
      preMarketLast: null,
      preMarketLow: null,
      prevClose: series?.prevClose ?? null,
      gapPct: null,
      direction15mPct: null,
      toStopPct: null,
      lastBarAt: null,
      freshnessSec: null,
    }
  }

  const lastBar = series.bars[series.bars.length - 1]!
  const preMarketLast = lastBar.close
  const preMarketLow = Math.min(...series.bars.map((b) => b.low ?? b.close))
  const prevClose = series.prevClose
  const lastBarAt = lastBar.at
  const lastBarMs = new Date(lastBarAt).getTime()
  const freshnessSec = Number.isFinite(lastBarMs) ? Math.round((now.getTime() - lastBarMs) / 1000) : null

  const gapPct =
    prevClose !== null && prevClose > 0 ? ((preMarketLast - prevClose) / prevClose) * 100 : null

  const direction15mPct = computeDirection15m(series.bars, lastBar, lastBarMs)

  const toStopPct = computeToStopPct(preMarketLast, input.position, input.rule, input.atr20)

  let status: ExtendedHoursStatus
  if (freshnessSec === null || freshnessSec > STALE_FRESHNESS_SEC || prevClose === null) {
    status = 'UNKNOWN'
  } else if (toStopPct !== null && toStopPct <= 0) {
    status = 'STOP_AT_OPEN_CANDIDATE'
  } else if ((gapPct !== null && gapPct <= GAP_WARNING_PCT) || (toStopPct !== null && toStopPct <= TO_STOP_WARNING_PCT)) {
    status = 'WARNING'
  } else {
    status = 'NORMAL'
  }

  return { status, preMarketLast, preMarketLow, prevClose, gapPct, direction15mPct, toStopPct, lastBarAt, freshnessSec }
}

/** 最終 bar 時刻から遡って 15 分以内で最も古い bar を基準にした変化率。基準 bar が最終 bar と同一なら null。 */
function computeDirection15m(bars: PreMarketBar[], lastBar: PreMarketBar, lastBarMs: number): number | null {
  if (!Number.isFinite(lastBarMs)) return null
  const cutoffMs = lastBarMs - 15 * 60 * 1000
  // bars は ascending 順 (YahooExtendedHoursClient が sort 済み) なので、
  // cutoff 以降で最初に見つかる bar が「15分以内で最も古い bar」。
  let baseBar: PreMarketBar | null = null
  for (const bar of bars) {
    const barMs = new Date(bar.at).getTime()
    if (Number.isFinite(barMs) && barMs >= cutoffMs) {
      baseBar = bar
      break
    }
  }
  if (!baseBar || baseBar.at === lastBar.at || !(baseBar.close > 0)) return null
  return ((lastBar.close - baseBar.close) / baseBar.close) * 100
}

/** 保有時のみ算出。pnlPct(プレマ値基準) - effectiveStopPct。position/rule が無ければ null。 */
function computeToStopPct(
  preMarketLast: number,
  position: { qty: number; avgPrice: number } | null | undefined,
  rule: SymbolRule | undefined,
  atr20: number | null | undefined,
): number | null {
  if (!position || !(position.qty > 0) || !(position.avgPrice > 0) || !rule) return null
  const stop = resolveStopDistance({
    price: position.avgPrice,
    stopPct: rule.stopPct,
    takeProfitPct: rule.takeProfitPct,
    atr20: atr20 ?? 0,
    kAtr: rule.kAtr,
    maxStopToTpRatio: rule.maxStopToTpRatio,
  })
  const pnlPct = ((preMarketLast - position.avgPrice) / position.avgPrice) * 100
  return pnlPct - stop.effectiveStopPct * 100
}

/**
 * 銘柄ごとの最新 atr20 (判定ログの indicators_json)。dashboard/index.ts の
 * `loadLatestAtr20` と同じ SQL — trading 層が routes 層を import する逆流を
 * 避けるため、あえて複製している (dashboard 側の表示挙動には触れない)。
 */
async function loadLatestAtr20(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  const rows = await db
    .prepare(
      `SELECT symbol, indicators_json FROM strategy_decision_log
       WHERE id IN (SELECT MAX(id) FROM strategy_decision_log GROUP BY symbol)`,
    )
    .all<{ symbol: string | null; indicators_json: string | null }>()
  for (const r of rows.results ?? []) {
    if (!r.symbol || !r.indicators_json) continue
    try {
      const parsed = JSON.parse(r.indicators_json) as { atr20?: unknown }
      if (typeof parsed.atr20 === 'number' && Number.isFinite(parsed.atr20) && parsed.atr20 > 0) {
        out.set(r.symbol.toUpperCase(), parsed.atr20)
      }
    } catch {
      // 壊れた JSON は無視 (この銘柄の atr20 が無いだけ)
    }
  }
  return out
}

/** NY ローカル日付 (YYYY-MM-DD)。`usMarketCalendar.formatNyYmd` と同じ formatToParts 手法。 */
const NY_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatNySessionYmd(date: Date): string {
  return NY_YMD_FORMATTER.format(date)
}

export async function runExtendedHoursObservation(
  options: RunExtendedHoursObservationOptions,
): Promise<ExtendedHoursObservationSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const empty = (reason: string): ExtendedHoursObservationSummary => ({
    ran: false,
    reason,
    symbols: 0,
    persisted: 0,
    statuses: {},
    errors: 0,
  })

  // 未設定 = 無効 (NEWS_ATTENTION_ENABLED と同じ判定パターン)。
  if ((env.EXTENDED_HOURS_OBSERVATION_ENABLED ?? '').trim().toLowerCase() !== 'true') {
    return empty('extended_hours_observation_disabled')
  }
  if (!env.DB) {
    return empty('db_unavailable')
  }

  const nowDate = now()
  // US 取引日の [開場-90分, 開場) の帯だけ稼働。tradingCalendar 自体は変更しない。
  const inPremarketWindow =
    evaluateStrategyWindow(nowDate, 'US', PREMARKET_LEAD_MINUTES) === 'in_window' &&
    !isWithinStrategyWindow(nowDate, 'US', 0)
  if (!inPremarketWindow) {
    return empty('outside_premarket_window')
  }

  try {
    const universe = await loadSymbolUniverse(env)
    const symbols = universe.allowedSymbols.filter(
      (sym) => !sym.startsWith('^') && universe.symbolMarket[sym] === 'US',
    )
    if (symbols.length === 0) {
      return empty('no_us_symbols')
    }

    const global = await loadGlobalConfigFrom(env, options.requestId)
    const defaultRule: SymbolRule = {
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
      reentryMinAtrBelowLastExit: 1.0,
      reentryGuardBusinessDays: 3,
      maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
    }
    const rules = buildSymbolRules(defaultRule, universe)

    const client = options.client ?? new YahooExtendedHoursClient()
    const symbolClient = env.SYMBOL_STATE ? new SymbolStateClient(env.SYMBOL_STATE) : null
    const atr20Map = await loadLatestAtr20(env.DB, symbols)
    const sessionYmd = formatNySessionYmd(nowDate)
    const capturedAt = nowDate.toISOString()

    const statuses: Record<string, number> = {}
    let errors = 0

    const records: ExtendedHoursObservationRecord[] = await Promise.all(
      symbols.map(async (symbol) => {
        let series: PreMarketSeries | null = null
        try {
          series = await client.getPreMarketSeries(symbol)
        } catch (error) {
          errors += 1
          console.warn(
            JSON.stringify({
              event: 'extended_hours_observation_symbol_error',
              requestId: options.requestId,
              symbol,
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        }
        const position = symbolClient
          ? await symbolClient
              .getState(symbol)
              .then((state) => state.position)
              .catch(() => null)
          : null
        const assessment = assessPreMarket({
          series,
          now: nowDate,
          position,
          rule: rules[symbol.toUpperCase()] ?? defaultRule,
          atr20: atr20Map.get(symbol.toUpperCase()) ?? null,
        })
        statuses[assessment.status] = (statuses[assessment.status] ?? 0) + 1
        return {
          symbol: symbol.toUpperCase(),
          capturedAt,
          sessionYmd,
          status: assessment.status,
          preMarketLast: assessment.preMarketLast,
          preMarketLow: assessment.preMarketLow,
          prevClose: assessment.prevClose,
          gapPct: assessment.gapPct,
          direction15mPct: assessment.direction15mPct,
          toStopPct: assessment.toStopPct,
          lastBarAt: assessment.lastBarAt,
          freshnessSec: assessment.freshnessSec,
          requestId: options.requestId ?? null,
        }
      }),
    )

    const repo = createExtendedHoursObservationRepo(createExtendedHoursObservationDb(env.DB))
    const { inserted } = await repo.insertMany(records)

    return {
      ran: true,
      symbols: symbols.length,
      persisted: inserted,
      statuses,
      errors,
    }
  } catch (error) {
    // universe / global config load 失敗等、tick 全体が失敗したケース。cron
    // 呼び出し元 (index.ts) には一切伝播させない。
    console.warn(
      JSON.stringify({
        event: 'extended_hours_observation_error',
        requestId: options.requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return empty('error')
  }
}
