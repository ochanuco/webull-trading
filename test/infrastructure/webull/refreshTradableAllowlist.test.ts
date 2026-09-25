import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../../src/config/env'
import { refreshTradableAllowlist } from '../../../src/infrastructure/webull/refreshTradableAllowlist'
import type {
  FetchTradableInstrumentsResult,
  TradableInstrumentEntry,
} from '../../../src/infrastructure/webull/tradableInstruments'

const { fetchTradableInstruments } = vi.hoisted(() => ({
  fetchTradableInstruments: vi.fn<
    (
      env: Env,
      input: Parameters<typeof import('../../../src/infrastructure/webull/tradableInstruments').fetchTradableInstruments>[1],
    ) => Promise<FetchTradableInstrumentsResult>
  >(),
}))
const { upsertTradablePage, finalizeTradableDisappearance } = vi.hoisted(() => ({
  upsertTradablePage: vi.fn<(db: unknown, entries: TradableInstrumentEntry[], watermarkIso: string) => Promise<number>>(),
  finalizeTradableDisappearance: vi.fn<(db: unknown, watermarkIso: string, nowIso: string) => Promise<string[]>>(),
}))

vi.mock('../../../src/infrastructure/webull/tradableInstruments', () => ({ fetchTradableInstruments }))
vi.mock('../../../src/infrastructure/db/tradableInstrumentsRepo', () => ({
  upsertTradablePage,
  finalizeTradableDisappearance,
}))

const env = { DB: {} } as unknown as Env

function entry(symbol: string): TradableInstrumentEntry {
  return { symbol, instrumentId: '1', name: symbol, currency: 'USD', exchangeCode: 'XNAS' }
}

beforeEach(() => {
  vi.clearAllMocks()
  upsertTradablePage.mockImplementation(async (_db, entries) => entries.length)
  finalizeTradableDisappearance.mockResolvedValue([])
})

describe('refreshTradableAllowlist', () => {
  it('returns ok:false without touching fetch/repo when env.DB is unset', async () => {
    const result = await refreshTradableAllowlist({} as Env, 'wm1')
    expect(result).toMatchObject({ ok: false, done: false, error: expect.stringContaining('DB') })
    expect(fetchTradableInstruments).not.toHaveBeenCalled()
  })

  it('on a complete sweep, checks disappearance with the same watermark used for every onPage upsert', async () => {
    fetchTradableInstruments.mockImplementation(async (_env, input) => {
      await input?.onPage?.([entry('SOXL')], 0)
      await input?.onPage?.([entry('TQQQ')], 1)
      return { outcome: 'ok', instruments: [entry('SOXL'), entry('TQQQ')], complete: true, pages: 2 }
    })

    const result = await refreshTradableAllowlist(env, 'wm1')

    expect(upsertTradablePage).toHaveBeenCalledTimes(2)
    expect(upsertTradablePage.mock.calls.map((c) => c[2])).toEqual(['wm1', 'wm1'])
    expect(finalizeTradableDisappearance).toHaveBeenCalledWith(expect.anything(), 'wm1', expect.any(String))
    expect(result).toMatchObject({ ok: true, done: true, upserted: 2, pages: 2, nextCursor: null })
  })

  it('skips the disappearance sweep on a partial fetch (done=false), even though pages upserted', async () => {
    fetchTradableInstruments.mockImplementation(async (_env, input) => {
      await input?.onPage?.([entry('SOXL')], 0)
      return { outcome: 'ok', instruments: [entry('SOXL')], complete: false, pages: 1, nextCursor: 'CURSOR1' }
    })

    const result = await refreshTradableAllowlist(env, 'wm1', { maxPages: 1 })

    expect(finalizeTradableDisappearance).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, done: false, upserted: 1, nextCursor: 'CURSOR1', disappeared: 0 })
  })

  it('forwards opts.maxPages and opts.startCursor to fetchTradableInstruments for a resumed chunk', async () => {
    fetchTradableInstruments.mockResolvedValue({ outcome: 'ok', instruments: [], complete: false, pages: 0, nextCursor: 'C2' })

    await refreshTradableAllowlist(env, 'wm1', { startCursor: 'C1', maxPages: 15 })

    expect(fetchTradableInstruments).toHaveBeenCalledWith(env, expect.objectContaining({ startCursor: 'C1', maxPages: 15 }))
  })

  it('never checks disappearance on a fetch that errored with zero instruments, so an empty sweep cannot mark every symbol gone', async () => {
    fetchTradableInstruments.mockResolvedValue({
      outcome: 'error',
      instruments: [],
      complete: false,
      pages: 0,
      error: 'network down',
    })

    const result = await refreshTradableAllowlist(env, 'wm1')

    expect(finalizeTradableDisappearance).not.toHaveBeenCalled()
    expect(upsertTradablePage).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, done: false, error: 'network down' })
  })

  it('reports the partial-fetch error while still surfacing pages upserted before the failure', async () => {
    fetchTradableInstruments.mockImplementation(async (_env, input) => {
      await input?.onPage?.([entry('SOXL')], 0)
      return {
        outcome: 'error',
        instruments: [entry('SOXL')],
        complete: false,
        pages: 1,
        error: '429 backoff 上限超過',
      }
    })

    const result = await refreshTradableAllowlist(env, 'wm1')

    expect(finalizeTradableDisappearance).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, done: false, upserted: 1, error: '429 backoff 上限超過' })
  })
})
