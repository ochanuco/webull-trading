import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { DEFAULT_POSTHOG_HOST, telemetryDisabledJs, telemetryHost, telemetryJs } from '../../src/routes/dashboard/telemetry'

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}

describe('telemetryHost', () => {
  it('falls back to the default host when unset', () => {
    expect(telemetryHost(undefined)).toBe(DEFAULT_POSTHOG_HOST)
  })

  it('falls back to the default host for a non-https origin', () => {
    expect(telemetryHost('http://evil.example.com')).toBe(DEFAULT_POSTHOG_HOST)
  })

  it('falls back to the default host for an unparseable value', () => {
    expect(telemetryHost('not a url')).toBe(DEFAULT_POSTHOG_HOST)
  })

  it('keeps an https override', () => {
    expect(telemetryHost('https://eu.i.posthog.com')).toBe('https://eu.i.posthog.com')
  })
})

describe('telemetryJs', () => {
  it('embeds the key, host, and SPA-aware init options', () => {
    const js = telemetryJs({ key: 'phc_test', host: DEFAULT_POSTHOG_HOST, distinctId: null })
    expect(js).toContain('posthog.init("phc_test"')
    expect(js).toContain('"api_host":"https://us.i.posthog.com"')
    expect(js).toContain('"capture_pageview":"history_change"')
    expect(js).toContain('"capture_pageleave":true')
    expect(js).toContain('"autocapture":true')
    expect(js).toContain('"person_profiles":"identified_only"')
    expect(js).toContain('"session_recording":{"maskAllInputs":true}')
    expect(js).not.toContain('posthog.identify')
  })

  it('identifies the distinct id when present', () => {
    const js = telemetryJs({ key: 'phc_test', host: DEFAULT_POSTHOG_HOST, distinctId: 'operator@example.com' })
    expect(js).toContain('posthog.identify("operator@example.com")')
  })
})

describe('GET /dashboard/assets/telemetry.js', () => {
  it('serves the disabled no-op JS when POSTHOG_KEY is unset', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/assets/telemetry.js', {}, baseEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(telemetryDisabledJs)
  })

  it('serves the enabled JS with key/host/identify when POSTHOG_KEY is set', async () => {
    const env = { ...baseEnv, POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com' }
    const app = createApp()
    const res = await app.request(
      '/dashboard/assets/telemetry.js',
      { headers: { 'Cf-Access-Authenticated-User-Email': 'operator@example.com' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('posthog.init("phc_test"')
    expect(body).toContain('"api_host":"https://eu.i.posthog.com"')
    expect(body).toContain('posthog.identify("operator@example.com")')
  })

  it('falls back to the default host when POSTHOG_HOST is non-https', async () => {
    const env = { ...baseEnv, POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'http://evil.example.com' }
    const app = createApp()
    const res = await app.request('/dashboard/assets/telemetry.js', {}, env)
    const body = await res.text()
    expect(body).toContain(`"api_host":"${DEFAULT_POSTHOG_HOST}"`)
  })

  it('sets Cache-Control: no-store since the response embeds the user email', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/assets/telemetry.js',
      {},
      { ...baseEnv, POSTHOG_KEY: 'phc_test' },
    )
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/assets/telemetry.js', {}, {})
    expect(res.status).toBe(401)
  })
})

describe('dashboard layout', () => {
  it('includes the deferred telemetry script tag', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', {}, baseEnv)
    const body = await res.text()
    expect(body).toContain('<script src="/dashboard/assets/telemetry.js" defer></script>')
  })
})
