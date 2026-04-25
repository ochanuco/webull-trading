import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
}

const authHeader = { Authorization: `Basic ${btoa('admin:secret')}` }

function fakeSymbolStateNamespace(cooldownUntil: string | null = null) {
  const stub = {
    async getState(symbol: string) {
      return {
        symbol,
        position: { qty: 10, avgPrice: 100, openedAt: '2026-04-20T00:00:00.000Z' },
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil,
        settledCash: 0,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: { price: 105, asOf: '2026-04-23T00:00:00Z', fetchedAt: '2026-04-23T00:00:00Z', source: 'yahoo' },
        updatedAt: '2026-04-23T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

function fakePortfolioNamespace(portfolio: {
  dailyStartEquity: number
  dailyRealizedPnl: number
  tradingDisabledUntil: string | null
  updatedAt: string
}) {
  const stub = {
    async getPortfolio() {
      return portfolio
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown
}

describe('dashboard', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }))
  })
  afterEach(() => vi.resetAllMocks())

  it('401s without basic auth', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', {}, baseEnv)
    expect(res.status).toBe(401)
  })

  it('serves the index landing page', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<title>ダッシュボード')
    expect(body).toContain('/dashboard/positions')
  })

  it('renders positions page with DO state', async () => {
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SOXL')
    expect(body).toContain('100.00')
    expect(body).toContain('5.00%')
  })

  it('renders positions with "unavailable" when SYMBOL_STATE is missing', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('past cooldownUntil (epoch 0 from admin clear-cooldown) is shown as em-dash, not 1970', async () => {
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace('1970-01-01T00:00:00.000Z'),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).not.toContain('1970-01-01')
  })

  it('future cooldownUntil is shown in JST', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace(future),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).toMatch(/<span class="warn">[^<]*JST<\/span>/)
  })

  it('renders portfolio page', async () => {
    const env = {
      ...baseEnv,
      PORTFOLIO_STATE: fakePortfolioNamespace({
        dailyStartEquity: 10_000,
        dailyRealizedPnl: -150,
        tradingDisabledUntil: null,
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('dailyStartEquity')
    expect(body).toContain('-1.50%')
    // 2026-04-23T00:00:00Z → 2026-04-23 09:00:00 JST
    expect(body).toContain('2026-04-23 09:00:00 JST')
  })

  it('renders config page with global_config + symbol table', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('global_config')
    expect(body).toContain('SOXL')
  })

  it('escapes potentially-unsafe symbol names on config page', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['<script>'],
        symbolCurrency: { '<script>': 'USD' },
      }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).not.toContain('<script>')
    expect(body).toContain('&lt;script&gt;')
  })

  it('renders cron page with "unavailable" when DB is not bound', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('cron page requires basic auth', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron', {}, baseEnv)
    expect(res.status).toBe(401)
  })
})

import { formatQuoteAge } from '../../src/routes/dashboard'

describe('formatQuoteAge', () => {
  const now = new Date('2026-04-25T10:00:00.000Z')
  it('< 1 min → "just now"', () => {
    expect(formatQuoteAge('2026-04-25T09:59:30.000Z', now)).toBe('just now')
  })
  it('minutes', () => {
    expect(formatQuoteAge('2026-04-25T09:45:00.000Z', now)).toBe('15m前')
  })
  it('hours', () => {
    expect(formatQuoteAge('2026-04-25T07:00:00.000Z', now)).toBe('3h前')
  })
  it('days', () => {
    expect(formatQuoteAge('2026-04-23T10:00:00.000Z', now)).toBe('2d前')
  })
  it('future timestamp → "just now"', () => {
    expect(formatQuoteAge('2026-04-26T00:00:00.000Z', now)).toBe('just now')
  })
  it('invalid → "?"', () => {
    expect(formatQuoteAge('not-an-iso', now)).toBe('?')
  })
})
