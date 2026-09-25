import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
import { loadRecentAudit } from '../../src/infrastructure/db/configAuditLog'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

// A malicious DB row that skips escapeHtml could submit the kill-switch / seed-cash POST
// forms on the operator's authenticated session. Each test seeds a payload into a
// different field and asserts only its escaped form reaches the rendered HTML.

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
    expect(body).not.toContain(scriptPayload)
    expect(body).not.toContain(imgPayload)
    expect(body).not.toContain(symbolPayload)
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
        // formatAuditJson parse→re-stringifies but falls back to raw on parse failure;
        // both branches must still escapeHtml the payload.
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
        // inversePairs is also a free-text DB column rendered via esc().
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
    // actor/endpoint filter echoes the query string into <input value="...">, the classic
    // attribute-context XSS surface.
    vi.mocked(loadRecentAudit).mockResolvedValue([])
    const app = createApp()
    const attackerActor = '" autofocus onfocus="alert(1)'
    const url = `/dashboard/audit?actor=${encodeURIComponent(attackerActor)}`
    const res = await app.request(url, { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toMatch(/value="" autofocus onfocus="alert\(1\)"/)
    expect(body).toContain('&quot; autofocus onfocus=&quot;alert(1)')
  })
})
