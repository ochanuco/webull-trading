import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../app'
import { parseBooleanEnv, parseCsvEnv, parseNumberEnv, parseSymbolNotionalMap } from '../config/env'
import { createWebullHttpClient, type WebullClientEnv } from '../infrastructure/webull/WebullHttpClient'
import { TradingService, type TradingConfig } from '../trading/application/TradingService'
import { MockExecution } from '../trading/execution/MockExecution'
import { WebullExecution } from '../trading/execution/WebullExecution'
import { DefaultRiskPolicy } from '../trading/risk/DefaultRiskPolicy'
import { FixedRuleStrategy } from '../trading/strategy/strategies/FixedRuleStrategy'

interface TradeRequest {
  symbol: string
  price: number
  quantity: number
  buyBelow: number
  sellAbove: number
}

export const trade = new Hono<AppBindings>().post('/decide', async (c) => {
  const request = await parseTradeRequest(c.req.json())
  const service = createTradingService(request, c.env)
  return c.json(service.decide(request, readTradingConfig(c.env)))
}).post('/execute', async (c) => {
  const request = await parseTradeRequest(c.req.json())
  const service = createTradingService(request, c.env)
  return c.json(await service.executeTrade(request, readTradingConfig(c.env)))
})

async function parseTradeRequest(payload: Promise<unknown>): Promise<TradeRequest> {
  const body = asRecord(await payload)
  const symbol = readSymbol(body.symbol)
  const price = readPositiveNumber(body.price, 'price')
  const quantity = readPositiveNumber(body.quantity, 'quantity')
  const buyBelow = readFiniteNumber(body.buyBelow, 'buyBelow')
  const sellAbove = readFiniteNumber(body.sellAbove, 'sellAbove')

  if (buyBelow >= sellAbove) {
    throw new HTTPException(400, { message: 'buyBelow must be less than sellAbove' })
  }

  return {
    symbol,
    price,
    quantity,
    buyBelow,
    sellAbove,
  }
}

export function createTradingService(
  request: TradeRequest,
  env: {
    DRY_RUN?: string
  } & WebullClientEnv,
): TradingService {
  const execution = parseBooleanEnv(env.DRY_RUN, true)
    ? new MockExecution()
    : new WebullExecution(createWebullHttpClient(env))

  return new TradingService(
    new FixedRuleStrategy(request.buyBelow, request.sellAbove),
    new DefaultRiskPolicy(),
    execution,
  )
}

function readTradingConfig(env: {
  DRY_RUN?: string
  TRADING_ENABLED?: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
  SYMBOL_MAX_NOTIONAL?: string
  MARKET_HOURS_CHECK?: string
}): TradingConfig {
  return {
    dryRun: parseBooleanEnv(env.DRY_RUN, true),
    tradingEnabled: parseBooleanEnv(env.TRADING_ENABLED, false),
    allowedSymbols: parseCsvEnv(env.ALLOWED_SYMBOLS).map((symbol) => symbol.toUpperCase()),
    maxOrderNotional: parseNumberEnv(env.MAX_ORDER_NOTIONAL, 'MAX_ORDER_NOTIONAL'),
    symbolMaxNotional: parseSymbolNotionalMap(env.SYMBOL_MAX_NOTIONAL),
    marketHoursCheck: parseBooleanEnv(env.MARKET_HOURS_CHECK, false),
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
    throw new HTTPException(400, { message: 'symbol must be a non-empty string' })
  }

  return symbol
}

function readPositiveNumber(value: unknown, field: 'price' | 'quantity'): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }

  throw new HTTPException(400, { message: `${field} must be a finite number greater than 0` })
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  throw new HTTPException(400, { message: `${field} must be a finite number` })
}
