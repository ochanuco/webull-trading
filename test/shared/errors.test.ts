import { describe, expect, it } from 'vitest'
import {
  BrokerAuthError,
  BrokerClientError,
  BrokerRateLimitError,
  BrokerRequestError,
  BrokerServerError,
  TradingError,
  ValidationError,
  isSellQtyExceedError,
  WEBULL_SELL_QTY_EXCEED_CODE,
} from '../../src/shared/errors'

describe('shared errors', () => {
  it('ValidationError exposes trading error metadata', () => {
    const error = new ValidationError('symbol must be a non-empty string', { field: 'symbol' })

    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toBeInstanceOf(TradingError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      code: 'validation_error',
      status: 400,
      field: 'symbol',
      message: 'symbol must be a non-empty string',
    })
  })

  it('BrokerRequestError exposes trading error metadata', () => {
    const cause = new Error('network down')
    const error = new BrokerRequestError('Webull order placement failed', 'placeOrder', { cause })

    expect(error).toBeInstanceOf(BrokerRequestError)
    expect(error).toBeInstanceOf(TradingError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      code: 'broker_request_error',
      status: 502,
      operation: 'placeOrder',
      cause,
      message: 'Webull order placement failed',
    })
  })
})

describe('isSellQtyExceedError', () => {
  it('matches BrokerClientError 417 with the SELL_QTY_EXCEED code in message', () => {
    const err = new BrokerClientError(
      `Webull request failed permanently with status 417 body=${JSON.stringify({
        code: WEBULL_SELL_QTY_EXCEED_CODE,
        msg: 'available_qty=4 < requested_qty=8',
      })}`,
      'POST /openapi/account/orders/place',
      { brokerStatus: 417 },
    )
    expect(isSellQtyExceedError(err)).toBe(true)
  })

  it('rejects BrokerClientError 417 without the SELL_QTY_EXCEED code', () => {
    const err = new BrokerClientError(
      'Webull request failed permanently with status 417 body={"code":"OAUTH_OPENAPI_OTHER_ERROR"}',
      'POST /openapi/account/orders/place',
      { brokerStatus: 417 },
    )
    expect(isSellQtyExceedError(err)).toBe(false)
  })

  it('rejects BrokerClientError with the right code but different status', () => {
    const err = new BrokerClientError(
      `Webull request failed permanently with status 400 body=${JSON.stringify({
        code: WEBULL_SELL_QTY_EXCEED_CODE,
      })}`,
      'POST /openapi/account/orders/place',
      { brokerStatus: 400 },
    )
    expect(isSellQtyExceedError(err)).toBe(false)
  })

  it('rejects BrokerAuthError / BrokerRateLimitError / BrokerServerError', () => {
    const auth = new BrokerAuthError('401', 'op', { brokerStatus: 401 })
    const rate = new BrokerRateLimitError('429', 'op', { brokerStatus: 429 })
    const server = new BrokerServerError('503', 'op', { brokerStatus: 503 })
    expect(isSellQtyExceedError(auth)).toBe(false)
    expect(isSellQtyExceedError(rate)).toBe(false)
    expect(isSellQtyExceedError(server)).toBe(false)
  })

  it('rejects non-broker errors', () => {
    expect(isSellQtyExceedError(new Error('boom'))).toBe(false)
    expect(isSellQtyExceedError('plain string')).toBe(false)
    expect(isSellQtyExceedError(null)).toBe(false)
    expect(isSellQtyExceedError(undefined)).toBe(false)
  })
})
