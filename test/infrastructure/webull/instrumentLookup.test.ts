import { describe, expect, it } from 'vitest'
import {
  INSTRUMENT_STATUS_LABELS,
  lookupInstrument,
} from '../../../src/infrastructure/webull/instrumentLookup'
import type { Env } from '../../../src/config/env'

const env = {
  WEBULL_APP_KEY: 'k'.repeat(32),
  WEBULL_APP_SECRET: 's'.repeat(32),
} as unknown as Env

// staging 実測 (2026-06-11, PR #474 probe) の USMV レコードそのまま。
const USMV_ROW = {
  name: 'iShares MSCI USA Min Vol Factor ETF',
  category: 'US_STOCK',
  symbol: 'USMV',
  status: 'OC',
  currency: 'USD',
  instrument_id: '913244629',
  exchange_code: 'BAT',
  shortable: true,
  fractionable: true,
  marginable: true,
  overnight_trading_supported: true,
  easy_to_borrow: false,
  lot_size: '1.0000000000',
  etf_leveraged_flag: 'NO',
  etf_leveraged_factor: '0',
}

function fetcherReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    })) as typeof fetch
}

describe('lookupInstrument (#475 instrument/stock/list v2)', () => {
  it('found: 実測レコードをドメイン型に正規化する', async () => {
    const result = await lookupInstrument(env, {
      symbol: 'usmv',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, [USMV_ROW]),
    })
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') return
    expect(result.instrument).toEqual({
      symbol: 'USMV',
      name: 'iShares MSCI USA Min Vol Factor ETF',
      status: 'OC',
      instrumentId: '913244629',
      exchangeCode: 'BAT',
      shortable: true,
      fractionable: true,
      marginable: true,
      overnightTradingSupported: true,
      easyToBorrow: false,
      lotSize: 1,
      etfLeveragedFactor: 0,
      inverseEtf: null,
    })
  })

  it('SOXS 型のレバレッジ field (factor=-3.0, inverse_etf) を数値/真偽に正規化する', async () => {
    const result = await lookupInstrument(env, {
      symbol: 'SOXS',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, [
        { ...USMV_ROW, symbol: 'SOXS', etf_leveraged_factor: '-3.0', inverse_etf: true },
      ]),
    })
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') return
    expect(result.instrument.etfLeveragedFactor).toBe(-3)
    expect(result.instrument.inverseEtf).toBe(true)
  })

  it('not_found: 200 + 空配列 (ZZZZ 実測パターン)', async () => {
    const result = await lookupInstrument(env, {
      symbol: 'ZZZZ',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, []),
    })
    expect(result.outcome).toBe('not_found')
  })

  it('not_found: symbol が一致しない行しか返らない場合も不存在扱い', async () => {
    const result = await lookupInstrument(env, {
      symbol: 'ZZZZ',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, [USMV_ROW]),
    })
    expect(result.outcome).toBe('not_found')
  })

  it('error: 非200 は判定材料にしない (404 = v1 routing 等)', async () => {
    const result = await lookupInstrument(env, {
      symbol: 'AAPL',
      category: 'US_STOCK',
      fetcher: fetcherReturning(404, { error_msg: '404 Route Not Found' }),
    })
    expect(result.outcome).toBe('error')
    if (result.outcome !== 'error') return
    expect(result.status).toBe(404)
  })

  it('error: 非 JSON / 非配列応答も error', async () => {
    const nonJson = await lookupInstrument(env, {
      symbol: 'AAPL',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, 'not json'),
    })
    expect(nonJson.outcome).toBe('error')
    const nonArray = await lookupInstrument(env, {
      symbol: 'AAPL',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, { rows: [] }),
    })
    expect(nonArray.outcome).toBe('error')
  })

  it('error: credentials 未設定', async () => {
    const result = await lookupInstrument({} as unknown as Env, {
      symbol: 'AAPL',
      category: 'US_STOCK',
      fetcher: fetcherReturning(200, []),
    })
    expect(result.outcome).toBe('error')
  })

  it('status enum のラベルは OC/CO/NT を網羅する', () => {
    expect(INSTRUMENT_STATUS_LABELS.OC).toContain('取引可')
    expect(INSTRUMENT_STATUS_LABELS.CO).toContain('清算')
    expect(INSTRUMENT_STATUS_LABELS.NT).toContain('取引不可')
  })
})
