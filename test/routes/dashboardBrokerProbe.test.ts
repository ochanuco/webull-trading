import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'

// universe ロードは DB 無しで null fallback するので mock 不要 (UI は AAPL
// control のみで描画される)。このテストは #461 のカード UI の存在確認。
const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

describe('/dashboard/broker-probe カード UI (#461)', () => {
  it('判定カード (Webull 取扱 / quote / 買付余力) と詳細セクションを描画する', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/broker-probe', {}, baseEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    // instrument 照会の判定カード + 近似である旨の注記 (#460 への参照)
    expect(body).toContain('Webull 取扱')
    expect(body).toContain('id="bp-instrument-pill"')
    expect(body).toContain('取扱有無の近似')
    expect(body).toContain('#460')
    // quote / 買付余力カード
    expect(body).toContain('id="bp-quote-pill"')
    expect(body).toContain('id="bp-yahoo-pill"')
    expect(body).toContain('id="probe-buying-power"')
    // 詳細 (drift / raw / meta) は collapsible に格納され情報は落ちていない
    expect(body).toContain('id="probe-drift-table"')
    expect(body).toContain('id="bp-instrument-raw"')
    expect(body).toContain('id="probe-meta"')
    // 自動 probe は URL クエリがある時だけ (PR #250 方針) — script 内の分岐が残っている
    expect(body).toContain("qs.has('symbol') && qs.has('category')")
    // CodeRabbit #462: XSS escape helper / 失敗時リセット / alt-category 候補
    expect(body).toContain('function escHtml(')
    expect(body).toContain('function resetProbeView(')
    expect(body).toContain('instrumentStockTrade')
  })

  it('control の AAPL chip と再 probe ボタンがある', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/broker-probe', {}, baseEnv)
    const body = await res.text()
    expect(body).toMatch(/data-symbol="AAPL" data-category="US_STOCK"/)
    expect(body).toContain('id="probe-refresh"')
  })
})
