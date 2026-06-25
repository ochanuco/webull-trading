import { describe, expect, it } from 'vitest'
import {
  toWebullPlaceOrderRequest,
  type PlaceOrderSchemaVersion,
} from '../../../src/infrastructure/webull/mapper'
import type { OrderIntent } from '../../../src/trading/domain/OrderIntent'

const intent: OrderIntent = {
  symbol: 'SOXL',
  side: 'BUY',
  quantity: 4,
  price: 12.5,
  notional: 50,
  clientOrderId: 'coid-test',
}

const sellIntent: OrderIntent = {
  ...intent,
  side: 'SELL',
}

// #251 / #256: Place Order body schema version の差分テスト。
// v1 (default / 現挙動) と v2 (新 OpenAPI docs) の body shape を検証。
describe('toWebullPlaceOrderRequest', () => {
  describe('v1 (default / 現挙動)', () => {
    it('produces the legacy shape with limit_price + support_trading_session=N + no combo_type', () => {
      const body = toWebullPlaceOrderRequest(intent, 'v1', 'acct-1')
      expect(body.account_id).toBeUndefined() // v1 は body に account_id 載せない
      expect(body.new_orders).toHaveLength(1)
      const order = body.new_orders[0]
      expect(order.client_order_id).toBe('coid-test')
      expect(order.symbol).toBe('SOXL')
      expect(order.market).toBe('US')
      expect(order.order_type).toBe('MARKET')
      expect(order.limit_price).toBe('12.500') // safety cap として送る
      expect(order.support_trading_session).toBe('N')
      expect(order.combo_type).toBeUndefined()
      expect(order.side).toBe('BUY')
      expect(order.open_or_close).toBe('OPEN')
      expect(order.quantity).toBe('4')
    })

    it('default schema=v1 (引数省略) でも v1 shape', () => {
      const body = toWebullPlaceOrderRequest(intent)
      expect(body.account_id).toBeUndefined()
      expect(body.new_orders[0].support_trading_session).toBe('N')
      expect(body.new_orders[0].limit_price).toBe('12.500')
      expect(body.new_orders[0].combo_type).toBeUndefined()
    })

    it('SELL intent sets open_or_close=CLOSE to prevent 417 CASH_ACCOUNT_NOT_ALLOW_SELL_SHORT', () => {
      const body = toWebullPlaceOrderRequest(sellIntent, 'v1', 'acct-1')
      expect(body.new_orders[0].side).toBe('SELL')
      expect(body.new_orders[0].open_or_close).toBe('CLOSE')
    })
  })

  describe('v2 (新 OpenAPI docs / opt-in)', () => {
    it('moves account_id to body, sets combo_type=NORMAL + session=CORE, omits limit_price for MARKET', () => {
      const body = toWebullPlaceOrderRequest(intent, 'v2', 'acct-1')
      expect(body.account_id).toBe('acct-1') // v2 は body 側
      expect(body.new_orders).toHaveLength(1)
      const order = body.new_orders[0]
      expect(order.combo_type).toBe('NORMAL')
      expect(order.support_trading_session).toBe('CORE')
      expect(order.limit_price).toBeUndefined() // MARKET では送らない
      expect(order.client_order_id).toBe('coid-test')
      expect(order.symbol).toBe('SOXL')
    })

    it('omits account_id from body if not provided', () => {
      const body = toWebullPlaceOrderRequest(intent, 'v2')
      expect(body.account_id).toBeUndefined()
      expect(body.new_orders[0].combo_type).toBe('NORMAL')
    })
  })

  describe('JP symbol', () => {
    it('infers market=JP for 4-digit TSE codes (both v1 and v2)', () => {
      const jpIntent: OrderIntent = { ...intent, symbol: '7203' }
      const v1 = toWebullPlaceOrderRequest(jpIntent, 'v1' as PlaceOrderSchemaVersion)
      const v2 = toWebullPlaceOrderRequest(jpIntent, 'v2' as PlaceOrderSchemaVersion)
      expect(v1.new_orders[0].market).toBe('JP')
      expect(v2.new_orders[0].market).toBe('JP')
    })
  })
})
