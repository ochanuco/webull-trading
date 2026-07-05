import { describe, expect, it } from 'vitest'
import { usdEquityFromBalance } from '../../../src/infrastructure/webull/usdEquityFromBalance'
import type { WebullAccountBalanceDto } from '../../../src/infrastructure/webull/dto'

describe('usdEquityFromBalance', () => {
  it('sums cash_balance + market_value for the USD entry (currency normalized)', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [
        { currency: 'jpy', cash_balance: '100000', market_value: '0' },
        { currency: ' usd ', cash_balance: '500.5', market_value: '994.5' },
      ],
    }
    expect(usdEquityFromBalance(balance)).toBe(1495)
  })

  it('returns null when account_currency_assets is missing', () => {
    expect(usdEquityFromBalance({})).toBeNull()
  })

  it('returns null when account_currency_assets is empty', () => {
    expect(usdEquityFromBalance({ account_currency_assets: [] })).toBeNull()
  })

  it('returns null when there is no USD entry', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'JPY', cash_balance: '100000', market_value: '0' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('returns null when market_value is missing (v1 balance shape)', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'USD', cash_balance: '1500' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('returns null when cash_balance is non-numeric (NaN)', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'USD', cash_balance: 'not-a-number', market_value: '100' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('returns null when market_value is negative', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'USD', cash_balance: '100', market_value: '-1' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('returns null when cash_balance is negative', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'USD', cash_balance: '-1', market_value: '100' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('returns null when the USD total is exactly 0 (treated as unseeded fallback)', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'USD', cash_balance: '0', market_value: '0' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })

  it('ignores JPY-only accounts even with a large balance', () => {
    const balance: WebullAccountBalanceDto = {
      account_currency_assets: [{ currency: 'JPY', cash_balance: '70388', market_value: '0' }],
    }
    expect(usdEquityFromBalance(balance)).toBeNull()
  })
})
