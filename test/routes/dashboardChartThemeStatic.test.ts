import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { CHART_THEME_CLIENT_SCRIPT_ETAG } from '../../src/routes/dashboard/charts/chartTheme'

// DB binding は不要 (静的アセット route は request に依存しない定数を返す)。
const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

describe('GET /dashboard/static/chart-theme.js (#ui-redesign)', () => {
  it('client script を text/javascript + 長寿命 Cache-Control + ETag で返す', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/static/chart-theme.js', {}, baseEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(res.headers.get('etag')).toBe(CHART_THEME_CLIENT_SCRIPT_ETAG)
    const body = await res.text()
    expect(body).toContain('window.wtChart')
    expect(body).toContain('window.wtTokens')
  })

  it('If-None-Match が一致すれば 304 (body 無し、同じ Cache-Control/ETag)', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/static/chart-theme.js',
      { headers: { 'if-none-match': CHART_THEME_CLIENT_SCRIPT_ETAG } },
      baseEnv,
    )
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(CHART_THEME_CLIENT_SCRIPT_ETAG)
    const body = await res.text()
    expect(body).toBe('')
  })

  it('If-None-Match が不一致なら 200 で本文を返す', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/static/chart-theme.js',
      { headers: { 'if-none-match': '"stale-etag"' } },
      baseEnv,
    )
    expect(res.status).toBe(200)
    expect((await res.text()).length).toBeGreaterThan(0)
  })

  it('layout はどのページでも chart-theme.js を読み込む', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', {}, baseEnv)
    const body = await res.text()
    expect(body).toContain('/dashboard/static/chart-theme.js')
  })
})
