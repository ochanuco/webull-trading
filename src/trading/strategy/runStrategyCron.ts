import type { Env } from '../../config/env'
import { createWebullBarClient } from '../../infrastructure/quotes/BarClient'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createWebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import { MockExecution } from '../execution/MockExecution'
import { WebullExecution } from '../execution/WebullExecution'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import { SymbolStateClient } from '../state/SymbolStateClient'
import { runPullbackScheduler, type PullbackRunSummary } from './pullbackScheduler'

const DEFAULT_EQUITY_USD = 10_000

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  skipReason?:
    | 'trading_disabled'
    | 'no_us_symbols'
    | 'no_bridge_state'
    | 'portfolio_halted'
    | 'drawdown_kill'
}

/**
 * Cron-driven Pullback strategy entry。呼び出し側 (`src/index.ts`) は:
 *   1. global_config + symbol_universe を D1 から読む
 *   2. trading_enabled=0 / JP-only / SYMBOL_STATE 未 bind なら skip
 *   3. PortfolioStateDO の kill-switch / drawdown を確認 (fail-closed)
 *   4. US symbols に絞って runPullbackScheduler を起動
 *
 * Risk gate のうち **portfolio-wide な pre-flight 判定** (tradingDisabledUntil
 * と drawdown_kill) は本関数で適用する。per-symbol gate (spread / halt / gap /
 * JP band / inverse_pair / settled_cash) は TradingService 側が持っており、
 * 本 cron 経路では未統合 — follow-up で gate parity を取る予定。
 *
 * JP 銘柄は Webull JP UAT で market-data bar が 404 なので本 cron では除外。
 * JP は手動 /trade/execute 運用 (#32 live 疎通後に解禁)。
 */
export async function runStrategyCron(env: Env): Promise<StrategyCronResult> {
  const emptySummary: PullbackRunSummary = {
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
  }

  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env),
    loadSymbolUniverse(env),
  ])

  if (!global.tradingEnabled) {
    return { summary: emptySummary, symbols: [], skipReason: 'trading_disabled' }
  }

  const usSymbols = universe.allowedSymbols.filter(
    (sym) => (universe.symbolCurrency[sym] ?? 'USD') === 'USD',
  )
  if (usSymbols.length === 0) {
    return { summary: emptySummary, symbols: [], skipReason: 'no_us_symbols' }
  }

  if (!env.SYMBOL_STATE) {
    return { summary: emptySummary, symbols: usSymbols, skipReason: 'no_bridge_state' }
  }

  // Portfolio-level pre-flight (fail-closed):
  // - PORTFOLIO_STATE binding 不在 → halt (drawdown kill を評価する術が無い)
  // - getPortfolio 例外 → halt
  // - tradingDisabledUntil が truthy だが parse 不能 → halt (silent pass 防止)
  // - tradingDisabledUntil が有効 & 未来 → halt
  // - drawdown 閾値超過 → halt
  if (!env.PORTFOLIO_STATE) {
    return { summary: emptySummary, symbols: usSymbols, skipReason: 'portfolio_halted' }
  }
  const portfolioStore = new PortfolioStateClient(env.PORTFOLIO_STATE)
  try {
    const portfolio = await portfolioStore.getPortfolio()
    const now = Date.now()
    if (portfolio.tradingDisabledUntil) {
      const disabledUntilMs = new Date(portfolio.tradingDisabledUntil).getTime()
      if (!Number.isFinite(disabledUntilMs) || disabledUntilMs > now) {
        return { summary: emptySummary, symbols: usSymbols, skipReason: 'portfolio_halted' }
      }
    }
    if (portfolio.dailyStartEquity > 0) {
      const ratio = portfolio.dailyRealizedPnl / portfolio.dailyStartEquity
      if (ratio <= global.drawdownKillThreshold) {
        return { summary: emptySummary, symbols: usSymbols, skipReason: 'drawdown_kill' }
      }
    }
  } catch {
    return { summary: emptySummary, symbols: usSymbols, skipReason: 'portfolio_halted' }
  }

  const positionStore = new SymbolStateClient(env.SYMBOL_STATE)
  const execution = global.dryRun
    ? new MockExecution()
    : new WebullExecution(createWebullHttpClient(env))
  const barClient = createWebullBarClient(env)

  // sizing に流す equity は正の有限値のみ許可 (0 / 負 / NaN / Infinity を弾く)。
  // D1 から読んだ値が壊れていたら default に落とす。
  const equity = sanitizeEquity(global.totalCapitalUsd)

  const summary = await runPullbackScheduler({
    symbols: usSymbols,
    equity,
    barClient,
    positionStore,
    execution,
    symbolCapMap: universe.symbolMaxNotional,
  })

  return { summary, symbols: usSymbols }
}

function sanitizeEquity(value: number | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_EQUITY_USD
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_EQUITY_USD
  return value
}
