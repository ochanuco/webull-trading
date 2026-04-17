import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { parseBooleanEnv, parseCsvEnv, parseNumberEnv } from '../config/env'
import { TradingService, type TradingConfig } from '../trading/application/TradingService'
import { MockExecution } from '../trading/execution/MockExecution'
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
  const service = createTradingService(request)
  return c.json(service.decide(request, readTradingConfig(c.env)))
}).post('/execute', async (c) => {
  const request = await parseTradeRequest(c.req.json())
  const service = createTradingService(request)
  return c.json(await service.executeTrade(request, readTradingConfig(c.env)))
})

async function parseTradeRequest(payload: Promise<unknown>): Promise<TradeRequest> {
  const body = asRecord(await payload)

  return {
    symbol: readString(body.symbol),
    price: readNumber(body.price),
    quantity: readNumber(body.quantity),
    buyBelow: readNumber(body.buyBelow),
    sellAbove: readNumber(body.sellAbove),
  }
}

function createTradingService(request: TradeRequest): TradingService {
  return new TradingService(
    new FixedRuleStrategy(request.buyBelow, request.sellAbove),
    new DefaultRiskPolicy(),
    new MockExecution(),
  )
}

function readTradingConfig(env: {
  DRY_RUN: string
  TRADING_ENABLED: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
}): TradingConfig {
  return {
    dryRun: parseBooleanEnv(env.DRY_RUN),
    tradingEnabled: parseBooleanEnv(env.TRADING_ENABLED),
    allowedSymbols: parseCsvEnv(env.ALLOWED_SYMBOLS),
    maxOrderNotional: parseNumberEnv(env.MAX_ORDER_NOTIONAL),
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

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return 0
}
