import { describe, expect, it, vi } from 'vitest'
import { WebhookNotifier } from '../../../src/infrastructure/notification/WebhookNotifier'

function okResponse(): Response {
  return new Response('ok', { status: 200 })
}

function makeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return okResponse()
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('WebhookNotifier', () => {
  it('POSTs Slack-shape body when only slackUrl is set', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 5,
      price: 200.123,
      mode: 'DRY_RUN',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://hooks.slack.test/x')
    expect(calls[0]?.init.method).toBe('POST')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toHaveProperty('text')
    expect(body.text).toContain('BUY AAPL')
    expect(body.text).toContain('qty=5')
    expect(body.text).toContain('200.12')
    expect(body.text).toContain('DRY_RUN')
  })

  it('POSTs Discord-shape body when only discordUrl is set', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      discordUrl: 'https://discord.test/webhooks/abc',
      fetchImpl: fn,
    })

    await notifier.notify({
      type: 'TRADE',
      side: 'SELL',
      symbol: 'SOXL',
      qty: 10,
      price: 30,
      realizedPnl: 12.5,
      mode: 'DRY_RUN',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://discord.test/webhooks/abc')
    const body = JSON.parse(String(calls[0]?.init.body))
    // Discord uses `content` (not `text`).
    expect(body).toHaveProperty('content')
    expect(body).not.toHaveProperty('text')
    expect(body.content).toContain('SELL SOXL')
    expect(body.content).toContain('pnl=+12.50')
  })

  it('POSTs to both targets when both URLs are set', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      slackUrl: 'https://hooks.slack.test/x',
      discordUrl: 'https://discord.test/webhooks/abc',
      fetchImpl: fn,
    })

    await notifier.notify({
      type: 'ERROR',
      symbol: 'NVDA',
      message: 'upstream 500',
      cause: 'bar fetch',
    })

    const urls = calls.map((c) => c.url).sort()
    expect(urls).toEqual([
      'https://discord.test/webhooks/abc',
      'https://hooks.slack.test/x',
    ])
  })

  it('does nothing (no fetch) when both URLs are missing/empty', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: '', discordUrl: undefined, fetchImpl: fn })
    await notifier.notify({ type: 'ERROR', message: 'oops' })
    expect(calls).toHaveLength(0)
  })

  it('resolves silently when fetch rejects (network failure)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl })

    await expect(
      notifier.notify({
        type: 'TRADE',
        side: 'BUY',
        symbol: 'AAPL',
        qty: 1,
        price: 100,
        mode: 'DRY_RUN',
      }),
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('resolves silently on non-OK HTTP status (4xx/5xx)', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 })) as unknown as typeof fetch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier = new WebhookNotifier({
      discordUrl: 'https://discord.test/webhooks/abc',
      fetchImpl,
    })

    await expect(
      notifier.notify({ type: 'ERROR', symbol: 'AAPL', message: 'boom' }),
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('appends dashboard link when DASHBOARD_BASE_URL is set', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      slackUrl: 'https://hooks.slack.test/x',
      dashboardBaseUrl: 'https://dash.example.com/',
      fetchImpl: fn,
    })

    await notifier.notify({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 1,
      price: 100,
      mode: 'DRY_RUN',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    // trailing slash should be stripped, link should target chart UI.
    expect(body.text).toContain('https://dash.example.com/dashboard/charts?tab=symbol&symbol=AAPL')
  })

  it('trims leading/trailing whitespace from URLs before POSTing', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      slackUrl: '  https://hooks.slack.test/x  \n',
      discordUrl: '\thttps://discord.test/webhooks/abc ',
      dashboardBaseUrl: '  https://dash.example.com/  ',
      fetchImpl: fn,
    })

    await notifier.notify({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 1,
      price: 100,
      mode: 'DRY_RUN',
    })

    const urls = calls.map((c) => c.url).sort()
    expect(urls).toEqual([
      'https://discord.test/webhooks/abc',
      'https://hooks.slack.test/x',
    ])
    // dashboard link も trim 済みの base から組み立てられること。
    const slackCall = calls.find((c) => c.url === 'https://hooks.slack.test/x')
    const slackBody = JSON.parse(String(slackCall?.init.body))
    expect(slackBody.text).toContain('https://dash.example.com/dashboard/charts?tab=symbol&symbol=AAPL')
  })

  it('omits dashboard link when DASHBOARD_BASE_URL is unset', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      slackUrl: 'https://hooks.slack.test/x',
      fetchImpl: fn,
    })

    await notifier.notify({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 1,
      price: 100,
      mode: 'DRY_RUN',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).not.toContain('/dashboard/charts')
  })
})
