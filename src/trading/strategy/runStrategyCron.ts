import type { Env } from '../../config/env'
import { YahooBarClient } from '../../infrastructure/quotes/YahooBarClient'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import {
  detectAndNotifyConfigStateChanges,
  type WatchedConfig,
} from '../../infrastructure/notification/configStateChange'
import { createNotifier } from '../../infrastructure/notification/createNotifier'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { createWebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import { MockExecution } from '../execution/MockExecution'
import { WebullExecution } from '../execution/WebullExecution'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'
import { computeDrawdownRiskScale } from '../risk/drawdownRiskScale'
import {
  logStrategyDecision,
  strategyDecisionDbOrUndefined,
} from '../../infrastructure/logger/strategyDecisionLog'
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
} from '../../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
} from '../../infrastructure/calendar/macroEventCalendarRepo'
import {
  evaluateVixRegime,
  type VixRegimeFilterDecision,
} from '../risk/vixRegimeFilter'
import { detectAndNotifyVixRegimeChange } from '../../infrastructure/notification/vixRegimeChange'
import { runPullbackScheduler, type PullbackDecisionTrace, type PullbackRunSummary } from './pullbackScheduler'

const DEFAULT_EQUITY_USD = 10_000
const DEFAULT_EQUITY_JPY = 1_500_000
const JP_LOT_SIZE = 100

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  /**
   * Operator/AI analysis packet. Safe for logs: no broker secrets or raw
   * Webull payloads, only config/risk context and per-symbol decisions.
   */
  analysis: StrategyCronAnalysis
  skipReason?:
    | 'trading_disabled'
    | 'no_tradable_symbols'
    | 'no_bridge_state'
    | 'portfolio_halted'
    | 'drawdown_kill'
}

export interface StrategyCronAnalysis {
  schema: 'strategy_cron_analysis.v1'
  generatedAt: string
  requestId?: string
  config: {
    dryRun: boolean
    tradingEnabled: boolean
    pullbackRule: {
      stopPct: number
      takeProfitPct: number
      timeStopDays: number
      pullbackMax: number
      pullbackMin: number
      minReturn50d: number
      requireAboveSma50: boolean
      kAtr: number
    }
    risk: {
      basePerTradePct: number
      scaledPerTradePct?: number
      ddHalfThreshold: number
      ddHaltThreshold: number
      drawdownKillThreshold: number
      bucketExposurePct: number
    }
  }
  universe: {
    symbols: string[]
    byCurrency: Record<SymbolCurrency, string[]>
    symbolMaxNotional: Record<string, number>
    symbolBucket: Record<string, string>
  }
  portfolio?: {
    dailyStartEquity: number
    dailyRealizedPnl: number
    tradingDisabledUntil: string | null
    lastRolledAt: string | null
    updatedAt: string
  }
  drawdownScale?: {
    step: 'normal' | 'half' | 'halt'
    scale: number
    drawdown: number
  }
  /**
   * VIX regime decision (issue #196 3/3)。`^VIX` の最新値から導出。
   * cron tick で一度だけ算出し、両 currency run に同じ decision を渡す。
   */
  vix?: VixRegimeFilterDecision
  runs: Array<{
    currency: SymbolCurrency
    equity: number
    lotSize: number
    symbols: string[]
    bucketCapMap: Record<string, number>
  }>
  decisions: PullbackDecisionTrace[]
}

/**
 * Cron-driven Pullback strategy entry。呼び出し側 (`src/index.ts`) は:
 *   1. global_config + symbol_universe を D1 から読む
 *   2. trading_enabled=0 / symbol 不在 / SYMBOL_STATE 未 bind なら skip
 *   3. PortfolioStateDO の kill-switch / drawdown を確認 (fail-closed)
 *   4. currency 毎に runPullbackScheduler を起動し summary を合算
 *
 * Risk gate のうち **portfolio-wide な pre-flight 判定** (tradingDisabledUntil
 * と drawdown_kill) は本関数で適用する。per-symbol gate (spread / halt / gap /
 * JP band / inverse_pair / settled_cash) は `evaluatePerSymbolRisk` を介して
 * `runPullbackScheduler` に注入し、TradingService と判定が一致するよう unify
 * 済み (issue #138)。
 *
 * JP 銘柄は 100 株ロットで round-down される。bar 取得は Yahoo Finance の
 * `<code>.T` サフィックス (YahooBarClient 内で自動付与)。
 */
export interface RunStrategyCronOptions {
  /** Correlation id for structured logs (from scheduled() handler). */
  requestId?: string
}

export async function runStrategyCron(
  env: Env,
  options: RunStrategyCronOptions = {},
): Promise<StrategyCronResult> {
  const emptySummary = (): PullbackRunSummary => ({
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
  })

  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env, options.requestId),
    loadSymbolUniverse(env),
  ])

  // Notifier は cron tick の最序盤で組み立てる: 後続の skipReason 通知や
  // state change 検知が同じ instance を使う (#141)。requestId を伝搬させる
  // ことで `notification_emit_log.request_id` に紐付く。
  const notifier = createNotifier(env, { requestId: options.requestId })

  // global_config の watched field 遷移を検知 (#141)。await して snapshot を
  // 確実に書き終えてから次の処理に進む — 1 cron tick 中に複数の通知 path が
  // STATE_CHANGE を出すと重複するので、ここで 1 回だけ走らせる。失敗しても
  // 内部で握りつぶされる (caller は気にしなくて良い)。
  const watchedNow: WatchedConfig = {
    dryRun: global.dryRun,
    tradingEnabled: global.tradingEnabled,
    marketHoursCheck: global.marketHoursCheck,
    drawdownKillThreshold: global.drawdownKillThreshold,
  }
  await detectAndNotifyConfigStateChanges({
    db: env.DB,
    notifier,
    current: watchedNow,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'config_state_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  const defaultRule = {
    stopPct: global.pullbackDefaultStopPct,
    takeProfitPct: global.pullbackDefaultTakeProfitPct,
    timeStopDays: global.pullbackDefaultTimeStopDays,
    pullbackMax: global.pullbackDefaultPullbackMax,
    pullbackMin: global.pullbackDefaultPullbackMin,
    minReturn50d: global.pullbackDefaultMinReturn50d,
    requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
    kAtr: global.pullbackDefaultKAtr,
  }
  const byCurrency: Record<SymbolCurrency, string[]> = { USD: [], JPY: [] }
  for (const sym of universe.allowedSymbols) {
    const cur = universe.symbolCurrency[sym] ?? 'USD'
    byCurrency[cur].push(sym)
  }
  const analysisBase = (): StrategyCronAnalysis => ({
    schema: 'strategy_cron_analysis.v1',
    generatedAt: new Date().toISOString(),
    requestId: options.requestId,
    config: {
      dryRun: global.dryRun,
      tradingEnabled: global.tradingEnabled,
      pullbackRule: defaultRule,
      risk: {
        basePerTradePct: global.riskBasePerTradePct,
        ddHalfThreshold: global.riskDdHalfThreshold,
        ddHaltThreshold: global.riskDdHaltThreshold,
        drawdownKillThreshold: global.drawdownKillThreshold,
        bucketExposurePct: global.bucketExposurePct,
      },
    },
    universe: {
      symbols: universe.allowedSymbols,
      byCurrency,
      symbolMaxNotional: universe.symbolMaxNotional,
      symbolBucket: universe.symbolBucket,
    },
    runs: [],
    decisions: [],
  })

  // Critical な cron skip は #141 で push 通知化する。`trading_disabled` /
  // `no_tradable_symbols` は「設定通り」なので noisy にしないよう **通知しない**
  // (operator は意図的に切ってる場合が多い)。
  if (!global.tradingEnabled) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'trading_disabled' }
  }

  if (universe.allowedSymbols.length === 0) {
    return { summary: emptySummary(), symbols: [], analysis: analysisBase(), skipReason: 'no_tradable_symbols' }
  }

  if (!env.SYMBOL_STATE) {
    emitSkipReasonNotify(notifier, 'no_bridge_state', options.requestId, 'critical')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: 'no_bridge_state',
    }
  }

  // Portfolio-level pre-flight (fail-closed):
  // - PORTFOLIO_STATE binding 不在 → halt (drawdown kill を評価する術が無い)
  // - getPortfolio 例外 → halt
  // - tradingDisabledUntil が truthy だが parse 不能 → halt (silent pass 防止)
  // - tradingDisabledUntil が有効 & 未来 → halt
  // - drawdown 閾値超過 → halt
  if (!env.PORTFOLIO_STATE) {
    emitSkipReasonNotify(notifier, 'portfolio_halted', options.requestId, 'critical', 'PORTFOLIO_STATE binding missing')
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis: analysisBase(),
      skipReason: 'portfolio_halted',
    }
  }
  const portfolioStore = new PortfolioStateClient(env.PORTFOLIO_STATE)
  let portfolioSnapshot: Awaited<ReturnType<typeof portfolioStore.getPortfolio>>
  let analysis = analysisBase()
  try {
    portfolioSnapshot = await portfolioStore.getPortfolio()
    // `lastRolledAt` は #140 で追加した forward-compat フィールド。古い DO row
    // / fixture に欠けている場合 `undefined` で読めるので null に正規化する
    // (`null` = 「未 roll」扱いで stale 判定は skip)。
    const lastRolledAt = portfolioSnapshot.lastRolledAt ?? null
    analysis = {
      ...analysis,
      portfolio: {
        dailyStartEquity: portfolioSnapshot.dailyStartEquity,
        dailyRealizedPnl: portfolioSnapshot.dailyRealizedPnl,
        tradingDisabledUntil: portfolioSnapshot.tradingDisabledUntil,
        lastRolledAt,
        updatedAt: portfolioSnapshot.updatedAt,
      },
    }
    // Stale roll detection (issue #140)。`lastRolledAt` から 24h 以上経過して
    // いれば warning ログ。POC 段階では fail-closed までは行かず、operator が
    // dashboard で気付ける可視化に留める。
    emitStaleRollWarningIfNeeded({ lastRolledAt, requestId: options.requestId })
    const now = Date.now()
    if (portfolioSnapshot.tradingDisabledUntil) {
      const disabledUntilMs = new Date(portfolioSnapshot.tradingDisabledUntil).getTime()
      if (!Number.isFinite(disabledUntilMs) || disabledUntilMs > now) {
        emitSkipReasonNotify(
          notifier,
          'portfolio_halted',
          options.requestId,
          'critical',
          `tradingDisabledUntil=${portfolioSnapshot.tradingDisabledUntil}`,
        )
        return {
          summary: emptySummary(),
          symbols: universe.allowedSymbols,
          analysis,
          skipReason: 'portfolio_halted',
        }
      }
    }
    if (portfolioSnapshot.dailyStartEquity > 0) {
      const ratio = portfolioSnapshot.dailyRealizedPnl / portfolioSnapshot.dailyStartEquity
      if (ratio <= global.drawdownKillThreshold) {
        emitSkipReasonNotify(
          notifier,
          'drawdown_kill',
          options.requestId,
          'critical',
          `ratio=${ratio.toFixed(4)} <= threshold=${global.drawdownKillThreshold}`,
        )
        return {
          summary: emptySummary(),
          symbols: universe.allowedSymbols,
          analysis,
          skipReason: 'drawdown_kill',
        }
      }
    }
  } catch (error) {
    emitSkipReasonNotify(
      notifier,
      'portfolio_halted',
      options.requestId,
      'critical',
      `getPortfolio threw: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      analysis,
      skipReason: 'portfolio_halted',
    }
  }

  // Drawdown-scaled risk: derate sizing for the rest of the trading day
  // when realized PnL is underwater but not yet at drawdown_kill threshold.
  // Emits a journal-visible log so the operator can tell a quiet day from
  // a halved one.
  const { portfolio: portfolioForScale, usedFallback } = resolvePortfolioForRiskScale(
    portfolioSnapshot,
    global.totalCapitalUsd,
  )
  if (usedFallback) {
    console.log(
      JSON.stringify({
        event: 'portfolio_unseeded_fallback',
        requestId: options.requestId,
        fallbackEquity: portfolioForScale.dailyStartEquity,
      }),
    )
  }
  const ddScale = computeDrawdownRiskScale(portfolioForScale, {
    baseRiskPct: global.riskBasePerTradePct,
    halfThreshold: global.riskDdHalfThreshold,
    haltThreshold: global.riskDdHaltThreshold,
  })
  analysis = {
    ...analysis,
    config: {
      ...analysis.config,
      risk: {
        ...analysis.config.risk,
        scaledPerTradePct: global.riskBasePerTradePct * ddScale.scale,
      },
    },
    drawdownScale: {
      step: ddScale.step,
      scale: ddScale.scale,
      drawdown: ddScale.drawdown,
    },
  }
  if (ddScale.step !== 'normal') {
    console.log(
      JSON.stringify({
        event: 'drawdown_risk_scale',
        requestId: options.requestId,
        step: ddScale.step,
        scale: ddScale.scale,
        drawdown: ddScale.drawdown,
      }),
    )
  }
  const scaledRiskPerTradePct = global.riskBasePerTradePct * ddScale.scale

  const positionStore = new SymbolStateClient(env.SYMBOL_STATE)
  const execution = global.dryRun
    ? new MockExecution()
    : new WebullExecution(createWebullHttpClient(env))
  // notifier は関数冒頭で組み立て済み (#141)。BUY/SELL emit / per-symbol
  // bar fetch error / broker submit error は scheduler 内で注入された
  // notifier を使う (#199 経路のまま)。
  // Yahoo Finance /v8/finance/chart is free, no auth, covers US + JP (7267.T
  // style) in one endpoint — chosen over Webull's JP-subscription-gated
  // market-data API (see #84). Webull is still the order-execution path.
  const barClient = new YahooBarClient()

  // Earnings calendar gate (issue #196 1/3): table 未 migrate な環境で
  // `fetchByRange()` が `no such table` を吐くと fail-closed で全 BUY が
  // `earnings_gate_fetch_failed` reject になる。新環境 / preview deploy 等で
  // 0013 未適用の状態を許容するため、起動時に 1 回 sqlite_master を見て
  // table の有無を判定し、無ければ gate を 注入しない (= 過去挙動 = 全通過)
  // (CodeRabbit #196 review)。
  const earningsGateReady = env.DB ? await isEarningsCalendarReady(env.DB) : false
  if (env.DB && !earningsGateReady) {
    console.warn(
      JSON.stringify({
        event: 'earnings_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }
  // Macro event gate (issue #196 2/3): 同じ理由で 0014 未適用環境では gate を
  // 無効化 (table 不在 → fetch 失敗 → fail-closed で全 BUY reject の連鎖を回避)。
  const macroEventGateReady = env.DB ? await isMacroEventCalendarReady(env.DB) : false
  if (env.DB && !macroEventGateReady) {
    console.warn(
      JSON.stringify({
        event: 'macro_event_gate_disabled_table_missing',
        requestId: options.requestId,
      }),
    )
  }

  // VIX regime filter (issue #196 3/3)。`^VIX` daily の最新 close を 1 本だけ
  // 取得し、`evaluateVixRegime` で regime / sizeScale を決める。fetch 失敗は
  // fail-open (= normal fallback)。POC 段階で fail-closed BUY 全停止は厳しい。
  // `^VIX` は free / no-auth で Yahoo `chart` endpoint がそのまま使える。
  const vixDecision = await loadVixDecision(barClient, global, options.requestId)
  analysis = { ...analysis, vix: vixDecision }
  // Regime 遷移 (normal → warning, warning → critical 等) を STATE_CHANGE 通知。
  // 同 regime の連続 tick では emit しない (snapshot table で dedup)。
  await detectAndNotifyVixRegimeChange({
    db: env.DB,
    notifier,
    current: vixDecision,
    requestId: options.requestId,
  }).catch((err) => {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_change_detect_failed',
        requestId: options.requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  })

  // Pullback デフォルト rule は D1 global_config に寄せた (#118)。
  // 実運用中の tuning は `UPDATE global_config SET ...` で即反映可能。
  const summary = emptySummary()
  const runs: Array<{ currency: SymbolCurrency; equity: number; lotSize: number; symbols: string[] }> = []
  if (byCurrency.USD.length > 0) {
    runs.push({
      currency: 'USD',
      equity: sanitizeEquity(global.totalCapitalUsd, DEFAULT_EQUITY_USD),
      lotSize: 1,
      symbols: byCurrency.USD,
    })
  }
  if (byCurrency.JPY.length > 0) {
    runs.push({
      currency: 'JPY',
      equity: sanitizeEquity(global.totalCapitalJpy, DEFAULT_EQUITY_JPY),
      lotSize: JP_LOT_SIZE,
      symbols: byCurrency.JPY,
    })
  }

  for (const run of runs) {
    // Bucket cap: per-currency NAV × global.bucketExposurePct。
    // 同一 bucket の合計 open notional がこれを超える BUY は reject。
    // bucket が未分類 (symbol_config.bucket NULL) の symbol は素通り。
    const buckets = new Set<string>()
    for (const sym of run.symbols) {
      const b = universe.symbolBucket[sym.toUpperCase()]
      if (b) buckets.add(b)
    }
    const bucketCapMap: Record<string, number> = {}
    for (const b of buckets) {
      bucketCapMap[b] = run.equity * global.bucketExposurePct
    }
    analysis.runs.push({
      currency: run.currency,
      equity: run.equity,
      lotSize: run.lotSize,
      symbols: run.symbols,
      bucketCapMap,
    })
    const decisionDb = strategyDecisionDbOrUndefined(env)
    const sub = await runPullbackScheduler({
      symbols: run.symbols,
      equity: run.equity,
      lotSize: run.lotSize,
      barClient,
      positionStore,
      execution,
      symbolCapMap: universe.symbolMaxNotional,
      symbolBucketMap: universe.symbolBucket,
      bucketCapMap,
      defaultRule,
      riskPerTradePct: scaledRiskPerTradePct,
      requestId: options.requestId,
      notifier,
      // Per-symbol risk gate (issue #138 — TradingService と unify)。
      // global_config / symbol_universe から populate。manual route と同じ
      // deps なので、cron / `/trade/execute` の判定が一致する。
      perSymbolRisk: {
        inversePairs: universe.inversePairs,
        spreadLimits: {
          US: global.spreadLimitPctUs,
          JP: global.spreadLimitPctJp,
        },
        staleQuoteMs: global.staleQuoteMs,
        gapRejectPct: global.gapRejectPct,
      },
      // Earnings calendar gate (issue #196 1/3)。env.DB が無い OR table 未
      // migrate なら skip (POC 後方互換 / CodeRabbit #196 review)。
      // freezeBusinessDays は POC 段階では default 1 固定。将来 global_config に
      // 出すなら別 PR (#196 follow-up)。
      ...(env.DB && earningsGateReady
        ? {
            earningsGate: {
              repo: createEarningsCalendarRepo(createEarningsCalendarDb(env.DB)),
              freezeBusinessDays: 1,
            },
          }
        : {}),
      // Macro event gate (issue #196 2/3)。同様に env.DB / 0014 適用の双方が
      // あるときだけ注入。config は default (±1h, full-day=true) で POC 運用。
      ...(env.DB && macroEventGateReady
        ? {
            macroEventGate: {
              repo: createMacroEventCalendarRepo(createMacroEventCalendarDb(env.DB)),
            },
          }
        : {}),
      // VIX regime filter (issue #196 3/3)。critical で BUY 全停止、warning で
      // size を縮小、normal は no-op。両 currency run に同じ decision を渡す
      // (`^VIX` は global indicator なので per-currency に変える意味はない)。
      vixDecision,
      onDecision: (record) =>
        logStrategyDecision(decisionDb, {
          timestamp: new Date().toISOString(),
          requestId: options.requestId,
          ...record,
        }),
    })
    summary.evaluated += sub.evaluated
    summary.buys += sub.buys
    summary.sells += sub.sells
    summary.holds += sub.holds
    summary.rejected.push(...sub.rejected)
    summary.errors.push(...sub.errors)
    summary.decisions.push(...sub.decisions)
    analysis.decisions.push(...sub.decisions)
  }

  return { summary, symbols: universe.allowedSymbols, analysis }
}

function sanitizeEquity(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * 「未 seed」portfolio と「壊れた値」の portfolio を区別する pure helper。
 *
 * 分類:
 *   - `dailyStartEquity > 0`: seed 済、そのまま使う (fallback なし)
 *   - `dailyStartEquity <= 0` かつ **有限値** (0 / 負値): 未 seed 扱い。
 *     `global.totalCapitalUsd` が正値なら baseline として fallback。負値も
 *     同じく未 seed 判定 (tests 参照) で、broken data ではない。
 *   - `dailyStartEquity` が **非有限** (NaN / Infinity): 壊れ値 → fallback
 *     しない。後段 `drawdownRiskScale` の fail-closed (step: 'halt') に任せる。
 *   - `dailyRealizedPnl` が非有限: 同上、fallback 経路で 0 に上書きして
 *     fail-closed を迂回しないよう早期 return (CodeRabbit review #131)。
 *
 * 狙い: `/admin/portfolio/roll-daily` 未実行の初日 / 日跨ぎでも
 * `drawdownRiskScale` が halt ではなく normal で動き、BUY 機会を逃さない。
 * 同時に CodeRabbit review #125 の fail-closed 意図 (壊れ値は halt) は維持。
 */
export function resolvePortfolioForRiskScale<
  P extends { dailyStartEquity: number; dailyRealizedPnl: number },
>(
  portfolio: P,
  totalCapitalUsd: number | null | undefined,
): { portfolio: P; usedFallback: boolean } {
  // start > 0 ならそのまま
  if (portfolio.dailyStartEquity > 0) return { portfolio, usedFallback: false }
  // dailyStartEquity が NaN / Infinity → fallback しない (halt を期待)
  if (!Number.isFinite(portfolio.dailyStartEquity)) return { portfolio, usedFallback: false }
  // dailyRealizedPnl が壊れている (NaN / Infinity) なら fallback しない。
  // fallback 経路で勝手に 0 へ上書きすると壊れ値を fail-closed で捕まえ損ねる
  // (CodeRabbit review #131)。
  if (!Number.isFinite(portfolio.dailyRealizedPnl)) return { portfolio, usedFallback: false }
  if (
    totalCapitalUsd === null ||
    totalCapitalUsd === undefined ||
    !Number.isFinite(totalCapitalUsd) ||
    totalCapitalUsd <= 0
  ) {
    return { portfolio, usedFallback: false }
  }
  return {
    portfolio: {
      ...portfolio,
      dailyStartEquity: totalCapitalUsd,
      dailyRealizedPnl: 0, // 未 seed = 未実現損益もゼロ扱い
    },
    usedFallback: true,
  }
}

/**
 * Issue #140: stale roll の閾値 (hours)。
 *
 * 24h 以上経過 → `event: 'portfolio_roll_stale'` を warning ログ出力。
 *  - 22:00 UTC daily cron が 1 回 miss すると 24h を超えるので、最初の miss で
 *    operator が気付ける粒度にしている。
 *  - `lastRolledAt === null` (= まだ一度も roll が走っていない) は **stale 扱い
 *    しない**。新規環境 / DO 永続化前の state は EOD cron が初回成功するまで
 *    null のままなので、ここで毎 cron tick warn すると noise になる。代わりに
 *    dashboard 側で「未実行」を別表記する。
 *  - `Date.now()` をベースにするので呼び出し側の test は `vi.useFakeTimers` で
 *    時刻を固定する。
 */
const STALE_ROLL_WARNING_HOURS = 24

export function emitStaleRollWarningIfNeeded(args: {
  lastRolledAt: string | null
  requestId?: string
  now?: () => number
}): void {
  if (args.lastRolledAt === null) return
  const lastMs = new Date(args.lastRolledAt).getTime()
  if (!Number.isFinite(lastMs)) {
    // Corrupt timestamp。silent pass を避けて warn を出すが、stale_hours は
    // 計算不能なので "unparseable" を載せる。
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        reason: 'unparseable_lastRolledAt',
      }),
    )
    return
  }
  const nowMs = (args.now ?? Date.now)()
  const elapsedHours = (nowMs - lastMs) / 3_600_000
  if (elapsedHours >= STALE_ROLL_WARNING_HOURS) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_stale',
        requestId: args.requestId,
        lastRolledAt: args.lastRolledAt,
        staleHours: Number(elapsedHours.toFixed(2)),
        thresholdHours: STALE_ROLL_WARNING_HOURS,
      }),
    )
  }
}

/**
 * 0013 migration (`earnings_calendar`) が当該 D1 で適用済みかを判定する。
 *
 * 新環境 / preview deploy 等で 0013 未適用の状態に対し earnings gate を有効化
 * すると、`fetchByRange()` が `no such table` を吐き fail-closed で全 BUY が
 * reject される (CodeRabbit #196 review)。それを避けるため、cron 起動時に
 * `sqlite_master` を 1 回参照し、table が存在しなければ gate を **注入しない**
 * (過去挙動 = 全通過 へ fallback)。
 *
 * クエリ自体が throw した場合 (DB 接続失敗 / corruption 等) も「未 ready」
 * 扱い。これは「earnings 評価ができない壊れた D1 で gate を有効化しない」
 * という選択で、安全側の fallback として bucket / perSymbolRisk gate に任せる。
 */
async function isEarningsCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='earnings_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * `^VIX` の最新 close を取って `evaluateVixRegime` に流し、size scaling 用
 * decision を返す (issue #196 3/3)。
 *
 * fail-open: VIX fetch / parse 失敗時は `null` を渡して `regime: 'normal'` /
 * `sizeScale: 1.0` (= 通常運用) に倒す。POC 段階では VIX は part-of-the-system
 * で必須ではなく、fetch 失敗 = BUY 全停止は副作用が大きすぎる。warning ログ
 * だけ吐いて続行。
 */
async function loadVixDecision(
  barClient: YahooBarClient,
  global: { vixWarningThreshold: number; vixCriticalThreshold: number; vixWarningSizeScale: number },
  requestId: string | undefined,
): Promise<VixRegimeFilterDecision> {
  let vix: number | null = null
  try {
    // `^VIX` (CBOE Volatility Index)。Yahoo は記号付き symbol を URL encode で
    // 受けてくれる。lookback=1 で最新 close 1 本だけ。
    const bars = await barClient.getDailyBars('^VIX', 1)
    const last = bars[bars.length - 1]
    if (last && Number.isFinite(last.close) && last.close > 0) {
      vix = last.close
    } else {
      console.warn(
        JSON.stringify({
          event: 'vix_fetch_no_bars',
          requestId,
          barsLength: bars.length,
        }),
      )
    }
  } catch (err) {
    // fail-open: warning ログだけ。decision は null = normal fallback。
    console.warn(
      JSON.stringify({
        event: 'vix_fetch_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return evaluateVixRegime(vix, {
    warningThreshold: global.vixWarningThreshold,
    criticalThreshold: global.vixCriticalThreshold,
    warningSizeScale: global.vixWarningSizeScale,
  })
}

/**
 * 0014 migration (`macro_event_calendar`) が当該 D1 で適用済みかを判定する
 * (issue #196 2/3)。`isEarningsCalendarReady` と同じ理由 — 未 migrate な
 * preview / 新環境では gate を 無効化 して fail-closed の連鎖 reject を回避。
 */
async function isMacroEventCalendarReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='macro_event_calendar' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * cron tick の skip reason を Notifier に push する (#141)。fire-and-forget
 * + silent fallback。`portfolio_halted` / `drawdown_kill` / `no_bridge_state`
 * の 3 種を critical として通知する。
 *
 * 既存の `strategy_cron_run.skipReason` ログ列はそのまま (後方互換)。
 */
function emitSkipReasonNotify(
  notifier: Notifier,
  reason: 'portfolio_halted' | 'drawdown_kill' | 'no_bridge_state',
  requestId: string | undefined,
  severity: 'critical' | 'warning' = 'critical',
  detail?: string,
): void {
  const note = requestId ? ` requestId=${requestId}` : ''
  const message = detail ? `cron skipped: ${reason} — ${detail}${note}` : `cron skipped: ${reason}${note}`
  notifier
    .notify({
      type: 'ERROR',
      message,
      cause: reason,
      severity,
    })
    .catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'cron_skip_notify_failed',
          requestId,
          reason,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
}
