import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runQuoteFeed, type SnapshotClient } from '../../../src/trading/quotes/quoteScheduler'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import type { Env } from '../../../src/config/env'
import type { QuoteResult, WebullQuoteCategory } from '../../../src/infrastructure/quotes/WebullQuoteClient'

vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

interface PersistedQuote {
  symbol: string
  quote: { price: number; source: string; bid?: number; ask?: number }
}

function makeEnv(allowed: string[], extra: Record<string, unknown> = {}) {
  const persisted: PersistedQuote[] = []
  vi.mocked(loadSymbolUniverse).mockResolvedValue({
    allowedSymbols: allowed,
  } as unknown as Awaited<ReturnType<typeof loadSymbolUniverse>>)
  const env = {
    SYMBOL_STATE: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        setQuote: async (symbol: string, quote: PersistedQuote['quote']) => {
          void id
          persisted.push({ symbol, quote })
        },
      }),
    },
    ...extra,
  } as unknown as Env
  return { env, persisted }
}

function clientOf(
  source: string,
  handler: (symbols: string[], category: WebullQuoteCategory) => QuoteResult[] | Promise<QuoteResult[]>,
): SnapshotClient {
  return {
    source,
    getSnapshots: async (symbols, category) => handler(symbols, category),
  }
}

const quote = (symbol: string, price: number, bidAsk?: { bid: number; ask: number }): QuoteResult => ({
  symbol,
  price,
  asOf: '2026-06-11T00:00:00.000Z',
  ...(bidAsk ?? {}),
})

beforeEach(() => {
  vi.mocked(loadSymbolUniverse).mockReset()
})

describe('runQuoteFeed の QUOTE_SOURCE 選択 (#475)', () => {
  it("QUOTE_SOURCE 未設定は Yahoo (現行 default、fail-safe)", async () => {
    const { env } = makeEnv([])
    const summary = await runQuoteFeed({ env })
    expect(summary.source).toBe('yahoo-snapshot')
  })

  it("QUOTE_SOURCE=webull で webull-snapshot が primary", async () => {
    const { env } = makeEnv([], { QUOTE_SOURCE: 'webull' })
    const summary = await runQuoteFeed({ env })
    expect(summary.source).toBe('webull-snapshot')
  })

  it("QUOTE_SOURCE の未知値は Yahoo に倒す", async () => {
    const { env } = makeEnv([], { QUOTE_SOURCE: 'alpaca' })
    const summary = await runQuoteFeed({ env })
    expect(summary.source).toBe('yahoo-snapshot')
  })
})

describe('runQuoteFeed の Webull primary + Yahoo fallback (#475)', () => {
  it('US は Webull (bid/ask 付き)、JP は Yahoo fallback で取得し source を書き分ける', async () => {
    const { env, persisted } = makeEnv(['AAPL', 'SOXL', '1357'])
    const webull = clientOf('webull-snapshot', (symbols) =>
      symbols.map((s) => quote(s, 100, { bid: 99.9, ask: 100.1 })),
    )
    const yahoo = clientOf('yahoo-snapshot', (symbols) => symbols.map((s) => quote(s, 200)))

    const summary = await runQuoteFeed({ env, client: webull, fallbackClient: yahoo })

    expect(summary.errors).toEqual([])
    expect(summary.persisted).toBe(3)
    expect(summary.fallbackSymbols).toEqual(['1357'])
    const bySymbol = new Map(persisted.map((p) => [p.symbol, p.quote]))
    expect(bySymbol.get('AAPL')?.source).toBe('webull-snapshot')
    expect(bySymbol.get('AAPL')?.bid).toBe(99.9)
    expect(bySymbol.get('SOXL')?.source).toBe('webull-snapshot')
    // JP は Yahoo 経由 → spread guard は bid/ask 無しを仕様として扱える
    expect(bySymbol.get('1357')?.source).toBe('yahoo-snapshot')
    expect(bySymbol.get('1357')?.bid).toBeUndefined()
  })

  it('Webull の category fetch 失敗は同 group を Yahoo で再試行する (degraded but tradeable)', async () => {
    const { env, persisted } = makeEnv(['AAPL'])
    const webull = clientOf('webull-snapshot', () => {
      throw new Error('snapshot 500')
    })
    const yahoo = clientOf('yahoo-snapshot', (symbols) => symbols.map((s) => quote(s, 200)))

    const summary = await runQuoteFeed({ env, client: webull, fallbackClient: yahoo })

    expect(summary.errors.map((e) => e.message)).toContain('snapshot 500')
    expect(summary.persisted).toBe(1)
    expect(summary.fallbackSymbols).toEqual(['AAPL'])
    expect(persisted[0]?.quote.source).toBe('yahoo-snapshot')
  })

  it('Yahoo fallback まで失敗したら quote は更新せずエラー記録のみ (freshness guard に委ねる)', async () => {
    const { env, persisted } = makeEnv(['AAPL'])
    const webull = clientOf('webull-snapshot', () => {
      throw new Error('snapshot 500')
    })
    const yahoo = clientOf('yahoo-snapshot', () => {
      throw new Error('yahoo down')
    })

    const summary = await runQuoteFeed({ env, client: webull, fallbackClient: yahoo })

    expect(summary.persisted).toBe(0)
    expect(persisted).toEqual([])
    expect(summary.errors).toHaveLength(2)
    expect(summary.errors[1]!.message).toContain('fallback failed')
  })

  it('Yahoo primary (現行構成) は従来どおり JP も同居で取得し fallback 無し', async () => {
    const { env, persisted } = makeEnv(['AAPL', '1357'])
    const yahoo = clientOf('yahoo-snapshot', (symbols) => symbols.map((s) => quote(s, 200)))

    const summary = await runQuoteFeed({ env, client: yahoo })

    expect(summary.persisted).toBe(2)
    expect(summary.fallbackSymbols).toEqual([])
    expect(persisted.every((p) => p.quote.source === 'yahoo-snapshot')).toBe(true)
  })
})
