import { describe, expect, it } from 'vitest'
import {
  logExit,
  logFill,
  logPostSubmit,
  logPreSubmit,
  logTradeDecision,
  logTradeIntent,
  setTradeJournalSink,
  type TradeJournalRecord,
} from '../../../src/infrastructure/logger/tradeJournal'
import type { OrderIntent } from '../../../src/trading/domain/OrderIntent'

const intent: OrderIntent = {
  symbol: 'SOXL',
  side: 'BUY',
  quantity: 2,
  price: 9,
  notional: 18,
  clientOrderId: 'coid-1',
}

function captureLines(): { lines: TradeJournalRecord[]; restore: () => void } {
  const lines: TradeJournalRecord[] = []
  const restore = setTradeJournalSink((line) => {
    lines.push(JSON.parse(line))
  })
  return { lines, restore }
}

describe('tradeJournal', () => {
  it('decision carries strategy name, signal, and risk fields', () => {
    const { lines, restore } = captureLines()
    try {
      logTradeDecision({
        requestId: 'req-1',
        symbol: 'SOXL',
        strategyName: 'FixedRuleStrategy',
        signal: {
          action: 'BUY',
          symbol: 'SOXL',
          quantity: 2,
          price: 9,
          reason: 'under threshold',
          generatedAtIso: '2026-04-18T07:00:00Z',
        },
        riskDecision: { allowed: true, reasons: [] },
      })
    } finally {
      restore()
    }

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      trade_event_type: 'decision',
      request_id: 'req-1',
      symbol: 'SOXL',
      strategy_name: 'FixedRuleStrategy',
      signal_action: 'BUY',
      risk_allowed: true,
    })
  })

  it('intent / pre_submit / post_submit share the same client_order_id', () => {
    const { lines, restore } = captureLines()
    try {
      logTradeIntent({ requestId: 'req-1', clientOrderId: intent.clientOrderId, intent })
      logPreSubmit({ requestId: 'req-1', clientOrderId: intent.clientOrderId, intent })
      logPostSubmit({
        requestId: 'req-1',
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        result: { mode: 'LIVE', submitted: true, brokerOrderId: 'ord-1' },
        latencyMs: 123,
      })
    } finally {
      restore()
    }

    const ids = new Set(lines.map((l) => l.client_order_id))
    expect(ids).toEqual(new Set(['coid-1']))
    const types = lines.map((l) => l.trade_event_type)
    expect(types).toEqual(['intent', 'pre_submit', 'post_submit'])
    expect(lines[2]).toMatchObject({ order_id: 'ord-1', mode: 'LIVE', submitted: true, latency_ms: 123 })
  })

  it('post_submit captures error class and truncates message', () => {
    const { lines, restore } = captureLines()
    const long = 'x'.repeat(300)
    try {
      logPostSubmit({
        requestId: 'req-2',
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        error: new Error(long),
      })
    } finally {
      restore()
    }

    expect(lines[0]?.error_class).toBe('Error')
    expect(lines[0]?.error_message?.length).toBe(200)
  })

  it('fill + exit correlate via client_order_id', () => {
    const { lines, restore } = captureLines()
    try {
      logFill({
        clientOrderId: 'coid-1',
        orderId: 'ord-1',
        symbol: 'SOXL',
        filledQty: 2,
        filledPrice: 9.01,
        status: 'FILLED',
      })
      logExit({
        clientOrderId: 'coid-1',
        orderId: 'ord-1',
        symbol: 'SOXL',
        realizedPnl: 1.02,
        holdDays: 3,
        exitReason: 'TP',
      })
    } finally {
      restore()
    }

    expect(lines[0]).toMatchObject({
      trade_event_type: 'fill',
      client_order_id: 'coid-1',
      filled_qty: 2,
      filled_price: 9.01,
    })
    expect(lines[1]).toMatchObject({
      trade_event_type: 'exit',
      client_order_id: 'coid-1',
      realized_pnl: 1.02,
      hold_days: 3,
      exit_reason: 'TP',
    })
  })
})
