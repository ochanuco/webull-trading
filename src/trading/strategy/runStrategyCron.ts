import type { Env } from '../../config/env'
import { createWebullBarClient } from '../../infrastructure/quotes/BarClient'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { createWebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import { MockExecution } from '../execution/MockExecution'
import { WebullExecution } from '../execution/WebullExecution'
import { SymbolStateClient } from '../state/SymbolStateClient'
import { runPullbackScheduler, type PullbackRunSummary } from './pullbackScheduler'

export interface StrategyCronResult {
  summary: PullbackRunSummary
  symbols: string[]
  skipReason?: 'trading_disabled' | 'no_us_symbols' | 'no_bridge_state'
}

/**
 * Cron-driven Pullback strategy entry. 呼び出し側 (`src/index.ts`) は次の順で使う:
 *   1. global_config + symbol_universe を D1 から読む
 *   2. trading_enabled=0 or JP-only universe なら skip で return
 *   3. US symbols に絞って runPullbackScheduler を起動
 *
 * NOTE: TradingService の risk gate (drawdown_kill / spread_guard / halt /
 * gap / JP price band / inverse_pair / settled_cash) はここでは適用されない。
 * PullbackUptrendStrategy 内の pending_order / cooldown / exit 判定 + per-symbol
 * max_notional のみが働く。gate parity は follow-up issue で対応予定。
 *
 * JP 銘柄は Webull JP UAT で market-data bar が 404 なので本 cron では除外する。
 * JP は手動 /trade/execute 運用 (#32 live 疎通後に解禁)。
 */
export async function runStrategyCron(env: Env): Promise<StrategyCronResult> {
  const [global, universe] = await Promise.all([
    loadGlobalConfigFrom(env),
    loadSymbolUniverse(env),
  ])

  if (!global.tradingEnabled) {
    return {
      summary: { evaluated: 0, buys: 0, sells: 0, holds: 0, rejected: [], errors: [] },
      symbols: [],
      skipReason: 'trading_disabled',
    }
  }

  // JP 銘柄 (currency='JPY') は除外 — bar endpoint が JP UAT で 404
  const usSymbols = universe.allowedSymbols.filter(
    (sym) => (universe.symbolCurrency[sym] ?? 'USD') === 'USD',
  )
  if (usSymbols.length === 0) {
    return {
      summary: { evaluated: 0, buys: 0, sells: 0, holds: 0, rejected: [], errors: [] },
      symbols: [],
      skipReason: 'no_us_symbols',
    }
  }

  if (!env.SYMBOL_STATE) {
    return {
      summary: { evaluated: 0, buys: 0, sells: 0, holds: 0, rejected: [], errors: [] },
      symbols: usSymbols,
      skipReason: 'no_bridge_state',
    }
  }

  const positionStore = new SymbolStateClient(env.SYMBOL_STATE)
  const execution = global.dryRun
    ? new MockExecution()
    : new WebullExecution(createWebullHttpClient(env))
  const barClient = createWebullBarClient(env)

  // equity は D1 から。未 seed なら POC 仮値で継続 (cron を止めない)。
  const equity = global.totalCapitalUsd ?? 10_000

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
