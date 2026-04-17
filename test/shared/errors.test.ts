import { describe, expect, it } from 'vitest'
import { BrokerRequestError, TradingError, ValidationError } from '../../src/shared/errors'

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
