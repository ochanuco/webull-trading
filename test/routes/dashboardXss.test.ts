import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
import { loadRecentAudit } from '../../src/infrastructure/db/configAuditLog'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

/**
 * #284 — XSS audit for dashboard. Every DB-derived string interpolated into
 * server-rendered HTML must pass through `escapeHtml`. Otherwise a malicious
 * row (planted by an upstream bug, or a compromised JP/US broker payload that
 * lands in `cause` / `message` / `notes` / `before_json`) can submit the
 * kill-switch / seed-cash POST forms on the operator's authenticated session.
 *
 * Each test seeds a different XSS payload into a different field and asserts
 * the literal payload (raw `<script>` / `<img onerror=…>` / `"><svg …>`) is
 * NOT present in the rendered HTML — only its escaped form.
 */

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/notification/notificationEmitLog', () => ({
  loadRecentAlerts: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/configAuditLog', () => ({
  loadRecentAudit: vi.fn(),
}))

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}
const authHeader = {}

describe('dashboard XSS (#284)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  it('escapes <script> payload in alerts message / cause / symbol', async () => {
    const scriptPayload = '<script>alert(1)</script>'
    const imgPayload = '<img src=x onerror=alert(2)>'
    const symbolPayload = '"><svg onload=alert(3)>'
    vi.mocked(loadRecentAlerts).mockResolvedValue([
      {
        id: 1,
        timestamp: '2026-04-23T00:00:00.000Z',
        requestId: 'req-1',
        eventType: 'ERROR',
        severity: 'critical',
        symbol: symbolPayload,
        cause: imgPayload,
        message: scriptPayload,
      },
    ])
    const app = createApp()
    const res = await app.request(
      '/dashboard/alerts',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // 生の <script> / <img onerror=…> / "><svg…> はどれも HTML に直で出てはいけない。
    expect(body).not.toContain(scriptPayload)
    expect(body).not.toContain(imgPayload)
    expect(body).not.toContain(symbolPayload)
    // 代わりに escape 済みの形が含まれること (= payload が table 行として
    // 表示されているが inert になっている、を確認)。
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('&lt;img src=x onerror=alert(2)&gt;')
  })

  it('escapes <img onerror> payload inside audit before_json / after_json', async () => {
    const beforePayload = '<img onerror=alert(1)>'
    const afterPayload = '</script><script>alert(2)</script>'
    const actorPayload = '"><script>alert(3)</script>'
    vi.mocked(loadRecentAudit).mockResolvedValue([
      {
        id: 1,
        timestamp: '2026-04-23T00:00:00.000Z',
        actor: actorPayload,
        endpoint: '/admin/symbols/SOXL/seed-cash',
        targetKey: 'symbol=SOXL',
        // before/after は JSON 文字列で DB に入る (admin route 側で stringify)。
        // formatAuditJson は parse→re-stringify するが、parse 失敗時は raw を返す。
        // どちらの分岐でも payload 文字列は最終的に escapeHtml で中和される必要がある。
        beforeJson: JSON.stringify({ notes: beforePayload }),
        afterJson: JSON.stringify({ notes: afterPayload }),
        requestId: 'req-1',
      },
    ])
    const app = createApp()
    const res = await app.request(
      '/dashboard/audit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(beforePayload)
    expect(body).not.toContain('<script>alert(2)</script>')
    expect(body).not.toContain('<script>alert(3)</script>')
    // formatAuditJson が壊れて parse failure に倒れた場合の raw fallback も
    // escape されることを確認するため、エスケープ済みの形が body に居ること
    // (parse 成功でも失敗でも esc は通る)。
    expect(body).toContain('&lt;img onerror=alert(1)&gt;')
  })

  it('escapes free-text payload in symbol_config notes (config page)', async () => {
    const notesPayload = '<svg onload=alert(1)>'
    const bucketPayload = '"><iframe src=javascript:alert(2)>'
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        symbolCurrency: { SOXL: 'USD' },
        symbolNotes: { SOXL: notesPayload },
        // inversePairs 値は esc() で出力される自由テキスト相当 (DB 列値)。
        inversePairs: { SOXL: bucketPayload },
      }),
    )
    const app = createApp()
    const res = await app.request(
      '/dashboard/config',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(notesPayload)
    expect(body).not.toContain(bucketPayload)
    expect(body).toContain('&lt;svg onload=alert(1)&gt;')
    expect(body).toContain('&quot;&gt;&lt;iframe src=javascript:alert(2)&gt;')
  })

  it('escapes attribute-break payload in audit filter form (echoed query)', async () => {
    // actor / endpoint filter は query string をそのまま <input value="..."> に
    // echo するので attribute-context XSS の最たる surface。`" ` で attribute を
    // 早期 close されると onfocus= が混入できる。
    vi.mocked(loadRecentAudit).mockResolvedValue([])
    const app = createApp()
    const attackerActor = '" autofocus onfocus="alert(1)'
    const url = `/dashboard/audit?actor=${encodeURIComponent(attackerActor)}`
    const res = await app.request(url, { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    // 生の `" autofocus onfocus="alert(1)` (= attribute break + 新 attribute) が
    // value="..." の **内側** に出てはいけない。`&quot;` でクオートが中和される。
    expect(body).not.toMatch(/value="" autofocus onfocus="alert\(1\)"/)
    expect(body).toContain('&quot; autofocus onfocus=&quot;alert(1)')
  })
})
