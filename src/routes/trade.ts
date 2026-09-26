import { Hono } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'
import { loadGlobalConfigFrom, type LoadedGlobalConfig } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse, type SymbolUniverse } from '../infrastructure/db/symbolUniverse'
import type { WebullClientEnv } from '../infrastructure/webull/WebullHttpClient'
import { resolveAccessToken } from '../infrastructure/webull/resolveAccessToken'
import { createWebullTradeClient } from '../infrastructure/webull/WebullTradeClient'
import { ValidationError } from '../shared/errors'
import { TradingService, type TradingConfig } from '../trading/application/TradingService'
import { MockExecution } from '../trading/execution/MockExecution'
import { WebullExecution } from '../trading/execution/WebullExecution'
import { DefaultRiskPolicy } from '../trading/risk/DefaultRiskPolicy'
import { resolveTradingEnabled } from '../trading/runtime/killSwitch'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import type { PortfolioStateDO } from '../trading/state/PortfolioStateDO'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import type { SymbolStateDO } from '../trading/state/SymbolStateDO'
import { FixedRuleStrategy } from '../trading/strategy/strategies/FixedRuleStrategy'

interface TradeRequest {
  symbol: string
  price: number
  quantity: number
  buyBelow: number
  sellAbove: number
}

export const trade = new Hono<AppBindings>()
  .post('/decide', async (c) => {
    const request = await parseTradeRequest(c.req.json())
    const requestId = c.get('requestId')
    const [universe, global] = await Promise.all([
      loadSymbolUniverse(c.env),
      loadGlobalConfigFrom(c.env, requestId),
    ])
    const service = await createTradingService(request, c.env, universe, global)
    return c.json(
      service.decide(request, toTradingConfig(request, universe, global, c.env.TRADING_ENABLED), {
        requestId,
      }),
    )
  })
  .post('/execute', async (c) => {
    const request = await parseTradeRequest(c.req.json())
    const requestId = c.get('requestId')
    const [universe, global] = await Promise.all([
      loadSymbolUniverse(c.env),
      loadGlobalConfigFrom(c.env, requestId),
    ])
    const service = await createTradingService(request, c.env, universe, global)
    return c.json(
      await service.executeTrade(request, toTradingConfig(request, universe, global, c.env.TRADING_ENABLED), {
        requestId,
      }),
    )
  })

async function parseTradeRequest(payload: Promise<unknown>): Promise<TradeRequest> {
  const body = asRecord(await payload)
  const symbol = readSymbol(body.symbol)
  const price = readPositiveNumber(body.price, 'price')
  const quantity = readPositiveNumber(body.quantity, 'quantity')
  const buyBelow = readFiniteNumber(body.buyBelow, 'buyBelow')
  const sellAbove = readFiniteNumber(body.sellAbove, 'sellAbove')

  if (buyBelow >= sellAbove) {
    throw new ValidationError('buyBelow must be less than sellAbove', { field: 'buyBelow' })
  }

  return {
    symbol,
    price,
    quantity,
    buyBelow,
    sellAbove,
  }
}

async function createTradingService(
  request: TradeRequest,
  env: Env & {
    SYMBOL_STATE?: DurableObjectNamespace<SymbolStateDO>
    PORTFOLIO_STATE?: DurableObjectNamespace<PortfolioStateDO>
    ENVIRONMENT?: string
  } & WebullClientEnv,
  universe: SymbolUniverse,
  global: LoadedGlobalConfig,
): Promise<TradingService> {
  // resolveAccessToken only reads DO/env state, so calling it eagerly from
  // decide() as well as execute() adds no broker network call.
  const execution = global.dryRun
    ? new MockExecution()
    : new WebullExecution(
        createWebullTradeClient(env, { accessToken: await resolveAccessToken(env) }),
      )

  return new TradingService(
    new FixedRuleStrategy(request.buyBelow, request.sellAbove),
    new DefaultRiskPolicy(),
    execution,
    {
      positionStore: env.SYMBOL_STATE ? new SymbolStateClient(env.SYMBOL_STATE) : undefined,
      portfolioStore: env.PORTFOLIO_STATE
        ? new PortfolioStateClient(env.PORTFOLIO_STATE)
        : undefined,
      inversePairs: universe.inversePairs,
      spreadLimits: {
        US: global.spreadLimitPctUs,
        JP: global.spreadLimitPctJp,
      },
      staleQuoteMs: global.staleQuoteMs,
      gapRejectPct: global.gapRejectPct,
      drawdownKillThreshold: global.drawdownKillThreshold,
      maxPortfolioExposurePct: global.maxPortfolioExposurePct,
      totalCapitalUsd: global.totalCapitalUsd,
      totalCapitalJpy: global.totalCapitalJpy,
      symbolCurrency: universe.symbolCurrency,
    },
  )
}

function toTradingConfig(
  request: TradeRequest,
  universe: SymbolUniverse,
  global: LoadedGlobalConfig,
  envTradingEnabled: string | undefined,
): TradingConfig {
  // Symbols missing from the universe fall back to a 4-digit-ticker
  // heuristic for JPY vs USD; RiskPolicy.allowedSymbols rejects them anyway,
  // so a wrong guess here only affects which notional ceiling is reported.
  const upperSymbol = request.symbol.toUpperCase()
  const currency = universe.symbolCurrency[upperSymbol] ?? (/^\d{4}$/.test(upperSymbol) ? 'JPY' : 'USD')
  const maxOrderNotional =
    currency === 'JPY' ? global.maxOrderNotionalJpy : global.maxOrderNotionalUsd
  return {
    dryRun: global.dryRun,
    tradingEnabled: resolveTradingEnabled(global.tradingEnabled, envTradingEnabled),
    allowedSymbols: universe.allowedSymbols,
    maxOrderNotional,
    symbolMaxNotional: universe.symbolMaxNotional,
    marketHoursCheck: global.marketHoursCheck,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return {}
}

function readString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return ''
}

function readSymbol(value: unknown): string {
  const symbol = readString(value).trim()

  if (symbol.length === 0) {
    throw new ValidationError('symbol must be a non-empty string', { field: 'symbol' })
  }

  return symbol
}

function readPositiveNumber(value: unknown, field: 'price' | 'quantity'): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }

  throw new ValidationError(`${field} must be a finite number greater than 0`, { field })
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  throw new ValidationError(`${field} must be a finite number`, { field })
}
