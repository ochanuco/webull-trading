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
    expect(body).toContain('Webull 取扱')
    expect(body).toContain('id="bp-instrument-pill"')
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

  it('選択 → 実行フロー: 実行ボタン / 発注前検証 checkbox / chip は選択のみ (#461)', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/broker-probe', {}, baseEnv as never)
    const body = await res.text()
    expect(body).toContain('id="probe-submit"')
    expect(body).toContain('id="probe-preview-check"')
    expect(body).toContain('発注なし')
    expect(body).toContain('previewVariants')
    // chip クリックは選択のみ (setSelection)、通信は submit ボタンから
    expect(body).toContain('function setSelection(')
    expect(body).toMatch(/data-symbol="AAPL" data-category="US_STOCK"/)
  })
})
