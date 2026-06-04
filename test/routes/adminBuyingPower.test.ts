import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import * as readClientMod from '../../src/infrastructure/webull/WebullReadClient'
import * as tokenMod from '../../src/infrastructure/webull/resolveAccessToken'

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /admin/buying-power (#415)', () => {
  it('401s without Access JWT', async () => {
    const res = await createApp().request(
      '/admin/buying-power',
      {},
      { DRY_RUN: 'true', TRADING_ENABLED: 'false' },
    )
    expect(res.status).toBe(401)
  })

  it('returns parsed per-currency buying power (status ok)', async () => {
    vi.spyOn(tokenMod, 'resolveAccessToken').mockResolvedValue('tok')
    vi.spyOn(readClientMod, 'createWebullReadClient').mockReturnValue({
      async getAccountBalance() {
        return {
          total_asset_currency: 'JPY',
          total_cash_balance: '100000',
          account_currency_assets: [
            { currency: 'JPY', cash_balance: '100000', buying_power: '100000' },
            { currency: 'USD', cash_balance: '3.50', buying_power: '500.00' },
          ],
        }
      },
    } as never)
    const res = await createApp().request('/admin/buying-power', { headers: {} }, baseEnv)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.baseCurrency).toBe('JPY')
    expect(body.totalCash).toBe(100000)
    expect(body.byCurrency).toEqual([
      { currency: 'JPY', buyingPower: 100000, cash: 100000 },
      { currency: 'USD', buyingPower: 500, cash: 3.5 },
    ])
  })

  it('fail-safe: status unavailable (still 200) when balance fetch throws', async () => {
    vi.spyOn(tokenMod, 'resolveAccessToken').mockResolvedValue('tok')
    vi.spyOn(readClientMod, 'createWebullReadClient').mockReturnValue({
      async getAccountBalance() {
        throw new Error('boom 500')
      },
    } as never)
    const res = await createApp().request('/admin/buying-power', { headers: {} }, baseEnv)
    expect(res.status).toBe(200) // 常に 200、成否は status フィールドで判定 (ページを壊さない)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('unavailable')
    expect(String(body.reason)).toContain('boom 500')
  })
})
