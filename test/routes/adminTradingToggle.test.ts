import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { applyTradingToggle } from '../../src/infrastructure/db/tradingToggleRepo'

vi.mock('../../src/infrastructure/db/tradingToggleRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradingToggleRepo')>(
    '../../src/infrastructure/db/tradingToggleRepo',
  )
  return {
    ...actual,
    applyTradingToggle: vi.fn(),
  }
})

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}

const unauthEnv = {}

const authHeader = {}

describe('POST /admin/trading/toggle', () => {
  beforeEach(() => {
    vi.mocked(applyTradingToggle).mockResolvedValue({
      before: false,
      after: true,
      historyId: 1,
    })
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, reason: 'manual unlock' }),
      },
      { ...unauthEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(401)
    expect(applyTradingToggle).not.toHaveBeenCalled()
  })

  it('400s when body is missing reason', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true }),
      },
      { ...baseEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(400)
    expect(applyTradingToggle).not.toHaveBeenCalled()
  })

  it('400s when enabled is missing or non-boolean', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: 'maybe', reason: 'r' }),
      },
      { ...baseEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(400)
  })

  it('400s when DB binding is missing', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true, reason: 'r' }),
      },
      baseEnv,
    )
    expect(res.status).toBe(400)
  })

  it('200s and forwards JSON body to applyTradingToggle (CLI path)', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true, reason: 'maintenance done' }),
      },
      { ...baseEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      before: boolean | null
      after: boolean
      effective: boolean
      envOverrideActive: boolean
      historyId: number | null
    }
    expect(body).toEqual({
      before: false,
      after: true,
      effective: true,
      envOverrideActive: false,
      historyId: 1,
    })
    expect(applyTradingToggle).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyTradingToggle).mock.calls[0]![1]).toMatchObject({
      enabled: true,
      actor: 'admin',
      reason: 'maintenance done',
    })
  })

  // #276 invariant: env=false が DB=true を上書きする (より制限的が勝つ)。
  // toggle 自体は成功して DB が true になっても、レスポンスの `effective` は
  // false で operator に「env override が効いてる」を視認させる。
  it('reports effective=false and envOverrideActive=true when env TRADING_ENABLED=false', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true, reason: 'try unlock' }),
      },
      { ...baseEnv, DB: {} as unknown as D1Database, TRADING_ENABLED: 'false' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      after: boolean
      effective: boolean
      envOverrideActive: boolean
    }
    expect(body.after).toBe(true) // DB は ON に書いた
    expect(body.effective).toBe(false) // が effective は env で OFF
    expect(body.envOverrideActive).toBe(true)
  })

  // dashboard 経由は application/x-www-form-urlencoded で来る。`enabled` は
  // 'true' / 'false' 文字列。submit 後 303 redirect で /dashboard に戻す。
  it('accepts form-encoded body and redirects to /dashboard (303)', async () => {
    const app = createApp()
    const form = new URLSearchParams({ enabled: 'false', reason: 'panic stop' })
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...authHeader,
        },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard')
    expect(applyTradingToggle).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyTradingToggle).mock.calls[0]![1]).toMatchObject({
      enabled: false,
      reason: 'panic stop',
    })
  })
})
