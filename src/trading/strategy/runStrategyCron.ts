import type { Env } from '../../config/env'
import { YahooBarClient } from '../../infrastructure/quotes/YahooBarClient'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
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
import { runPullbackScheduler, type PullbackRunSummary } from './pullbackScheduler'

const DEFAULT_EQUITY_USD = 10_000
const DEFAULT_EQUITY_JPY = 1_500_000
const JP_LOT_SIZE = 100

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  skipReason?:
    | 'trading_disabled'
    | 'no_tradable_symbols'
    | 'no_bridge_state'
    | 'portfolio_halted'
    | 'drawdown_kill'
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
 * JP band / inverse_pair / settled_cash) は TradingService 側が持っており、
 * 本 cron 経路では未統合 — follow-up で gate parity を取る予定。
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
  })

  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env),
    loadSymbolUniverse(env),
  ])

  if (!global.tradingEnabled) {
    return { summary: emptySummary(), symbols: [], skipReason: 'trading_disabled' }
  }

  if (universe.allowedSymbols.length === 0) {
    return { summary: emptySummary(), symbols: [], skipReason: 'no_tradable_symbols' }
  }

  if (!env.SYMBOL_STATE) {
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
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
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
      skipReason: 'portfolio_halted',
    }
  }
  const portfolioStore = new PortfolioStateClient(env.PORTFOLIO_STATE)
  let portfolioSnapshot: Awaited<ReturnType<typeof portfolioStore.getPortfolio>>
  try {
    portfolioSnapshot = await portfolioStore.getPortfolio()
    const now = Date.now()
    if (portfolioSnapshot.tradingDisabledUntil) {
      const disabledUntilMs = new Date(portfolioSnapshot.tradingDisabledUntil).getTime()
      if (!Number.isFinite(disabledUntilMs) || disabledUntilMs > now) {
        return {
          summary: emptySummary(),
          symbols: universe.allowedSymbols,
          skipReason: 'portfolio_halted',
        }
      }
    }
    if (portfolioSnapshot.dailyStartEquity > 0) {
      const ratio = portfolioSnapshot.dailyRealizedPnl / portfolioSnapshot.dailyStartEquity
      if (ratio <= global.drawdownKillThreshold) {
        return {
          summary: emptySummary(),
          symbols: universe.allowedSymbols,
          skipReason: 'drawdown_kill',
        }
      }
    }
  } catch {
    return {
      summary: emptySummary(),
      symbols: universe.allowedSymbols,
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
  // Yahoo Finance /v8/finance/chart is free, no auth, covers US + JP (7267.T
  // style) in one endpoint — chosen over Webull's JP-subscription-gated
  // market-data API (see #84). Webull is still the order-execution path.
  const barClient = new YahooBarClient()

  // Pullback デフォルト rule は D1 global_config に寄せた (#118)。
  // 実運用中の tuning は `UPDATE global_config SET ...` で即反映可能。
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
  }

  return { summary, symbols: universe.allowedSymbols }
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
