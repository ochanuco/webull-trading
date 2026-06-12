import { describe, expect, it, vi } from 'vitest'
import { fetchTradableInstruments } from '../../../src/infrastructure/webull/tradableInstruments'
import type { Env } from '../../../src/config/env'

const env = {
  WEBULL_APP_KEY: 'k'.repeat(32),
  WEBULL_APP_SECRET: 's'.repeat(32),
} as unknown as Env

const noSleep = async (): Promise<void> => undefined

function row(symbol: string, securityId: string) {
  return {
    symbol,
    instrument_id: `9132${securityId}.000000`,
    security_id: securityId,
    name: `${symbol} Fund`,
    currency: 'USD',
    exchange_code: 'XNAS',
  }
}

/** 連続ページを返す fetcher。最後のページは hasNext=false。 */
function pagedFetcher(pages: { hasNext: boolean; instruments: unknown[] }[]): typeof fetch {
  let i = 0
  return (async () => {
    const page = pages[Math.min(i, pages.length - 1)]
    i += 1
    return new Response(JSON.stringify(page), { status: 200 })
  }) as typeof fetch
}

describe('fetchTradableInstruments (#460 tradable/list)', () => {
  it('複数ページを読み切って正規化・dedup する', async () => {
    const result = await fetchTradableInstruments(env, {
      sleep: noSleep,
      fetcher: pagedFetcher([
        { hasNext: true, instruments: [row('SOXL', '1001'), row('SOXS', '1002')] },
        // SOXL 重複 (last-write-wins) + 新規 TQQQ。hasNext=false で終端。
        { hasNext: false, instruments: [row('SOXL', '1001'), row('TQQQ', '1003')] },
      ]),
    })
    expect(result.outcome).toBe('ok')
    expect(result.complete).toBe(true)
    expect(result.pages).toBe(2)
    const symbols = result.instruments.map((i) => i.symbol).sort()
    expect(symbols).toEqual(['SOXL', 'SOXS', 'TQQQ'])
    const soxl = result.instruments.find((i) => i.symbol === 'SOXL')
    // instrument_id の末尾 .000000 を除去している。
    expect(soxl?.instrumentId).toBe('91321001')
  })

  it('symbol を大文字正規化する', async () => {
    const result = await fetchTradableInstruments(env, {
      sleep: noSleep,
      fetcher: pagedFetcher([{ hasNext: false, instruments: [row('vug', '2001')] }]),
    })
    expect(result.instruments[0]?.symbol).toBe('VUG')
  })

  it('429 を踏んだら backoff して同ページを再試行する', async () => {
    let call = 0
    const fetcher = (async () => {
      call += 1
      if (call === 1) return new Response('{"error_code":"TOO_MANY_REQUESTS"}', { status: 429 })
      return new Response(JSON.stringify({ hasNext: false, instruments: [row('SOXL', '1')] }), {
        status: 200,
      })
    }) as typeof fetch
    const sleep = vi.fn(noSleep)
    const result = await fetchTradableInstruments(env, { sleep, fetcher })
    expect(result.outcome).toBe('ok')
    expect(result.complete).toBe(true)
    expect(result.instruments).toHaveLength(1)
    // 429 backoff の sleep が少なくとも 1 回呼ばれた。
    expect(sleep).toHaveBeenCalled()
  })

  it('非200 (404 等) は error + 部分結果を返す', async () => {
    const fetcher = (async () =>
      new Response('{"error_msg":"404 Route Not Found"}', { status: 404 })) as typeof fetch
    const result = await fetchTradableInstruments(env, { sleep: noSleep, fetcher })
    expect(result.outcome).toBe('error')
    expect(result.complete).toBe(false)
    expect(result.status).toBe(404)
  })

  it('credentials 未設定なら即 error', async () => {
    const result = await fetchTradableInstruments({} as Env, { sleep: noSleep })
    expect(result.outcome).toBe('error')
    expect(result.error).toContain('credentials')
  })
})
