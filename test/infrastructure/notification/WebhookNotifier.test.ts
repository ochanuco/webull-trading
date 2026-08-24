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
  it('renders BUY as a neutral trade and marks DRY_RUN explicitly', async () => {
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
    expect(body.text).toBe('⚪ AAPL 買付\n5株 @ $200.12\n\n🧪 DRY RUN')
  })

  it('renders profitable SELL in green with realized PnL and net return', async () => {
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

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toHaveProperty('content')
    expect(body).not.toHaveProperty('text')
    expect(body.content).toBe('🟢 SOXL 売却\n10株 @ $30.00\n\n実現損益: $+12.50 (+4.3%)\n\n🧪 DRY RUN')
  })

  it('renders losing LIVE SELL in red without LIVE label', () => {
    const notifier = new WebhookNotifier({})
    const text = notifier.formatMessage({
      type: 'TRADE',
      side: 'SELL',
      symbol: 'TQQQ',
      qty: 2,
      price: 68.06,
      realizedPnl: -13.77,
      mode: 'LIVE',
    })

    expect(text).toBe('🔴 TQQQ 売却\n2株 @ $68.06\n\n実現損益: $-13.77 (-9.2%)')
    expect(text).not.toContain('LIVE')
  })

  it('renders break-even SELL with a neutral icon', () => {
    const notifier = new WebhookNotifier({})
    const text = notifier.formatMessage({
      type: 'TRADE',
      side: 'SELL',
      symbol: 'QQQ',
      qty: 1,
      price: 500,
      realizedPnl: 0,
      mode: 'LIVE',
    })

    expect(text).toContain('⚪ QQQ 売却')
    expect(text).toContain('実現損益: $0.00 (0.0%)')
  })

  it('does not append dashboard links to TRADE notifications', () => {
    const notifier = new WebhookNotifier({ dashboardBaseUrl: 'https://dash.example.com/' })
    const text = notifier.formatMessage({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 1,
      price: 100,
      mode: 'LIVE',
    })

    expect(text).not.toContain('/dashboard/charts')
  })

  it('prefers the STATE_CHANGE headline over the generic from→to text when present', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'STATE_CHANGE',
      field: 'news_shock_regime',
      from: 'normal',
      to: 'warning',
      severity: 'warning',
      headline: 'ニュース報道量が急増 (平時の2.8倍) — observe中のため発注は変更しません',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toBe('⚠️ ニュース報道量が急増 (平時の2.8倍) — observe中のため発注は変更しません')
  })

  it('passes an abort signal so a hung webhook cannot pin the isolate', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({ type: 'ERROR', message: 'boom' })

    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
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

  it('does nothing when both webhook URLs are missing', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: '', discordUrl: undefined, fetchImpl: fn })
    await notifier.notify({ type: 'ERROR', message: 'oops' })
    expect(calls).toHaveLength(0)
  })

  it('resolves silently when fetch rejects', async () => {
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

  it('resolves silently on non-OK HTTP status', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 })) as unknown as typeof fetch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier = new WebhookNotifier({ discordUrl: 'https://discord.test/webhooks/abc', fetchImpl })

    await expect(notifier.notify({ type: 'ERROR', symbol: 'AAPL', message: 'boom' })).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('keeps dashboard links for symbol-specific ERROR notifications', () => {
    const notifier = new WebhookNotifier({ dashboardBaseUrl: 'https://dash.example.com/' })
    const text = notifier.formatMessage({
      type: 'ERROR',
      symbol: 'AAPL',
      message: 'boom',
    })

    expect(text).toContain('https://dash.example.com/dashboard/charts?tab=symbol&symbol=AAPL')
  })

  it('trims leading/trailing whitespace from webhook URLs', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({
      slackUrl: '  https://hooks.slack.test/x  \n',
      discordUrl: '\thttps://discord.test/webhooks/abc ',
      dashboardBaseUrl: '  https://dash.example.com/  ',
      fetchImpl: fn,
    })

    await notifier.notify({ type: 'ERROR', symbol: 'AAPL', message: 'boom' })

    const urls = calls.map((c) => c.url).sort()
    expect(urls).toEqual([
      'https://discord.test/webhooks/abc',
      'https://hooks.slack.test/x',
    ])
    const slackCall = calls.find((c) => c.url === 'https://hooks.slack.test/x')
    const slackBody = JSON.parse(String(slackCall?.init.body))
    expect(slackBody.text).toContain('https://dash.example.com/dashboard/charts?tab=symbol&symbol=AAPL')
  })

  it('renders ERROR with severity=critical using a critical icon and CRITICAL label', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'ERROR',
      message: 'cron skipped: portfolio_halted',
      cause: 'portfolio_halted',
      severity: 'critical',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('🚨')
    expect(body.text).toContain('CRITICAL')
    expect(body.text).toContain('portfolio_halted')
  })

  it('renders ERROR with default severity=warning', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'ERROR',
      symbol: 'NVDA',
      message: 'upstream 500',
      cause: 'bar fetch',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('⚠️')
    expect(body.text).toContain('cron error')
    expect(body.text).not.toContain('CRITICAL')
  })

  it('renders STATE_CHANGE event with critical icon and field/from/to', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'STATE_CHANGE',
      field: 'dryRun',
      from: true,
      to: false,
      severity: 'critical',
      note: 'requestId=abc',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('🚨')
    expect(body.text).toContain('state change: dryRun true → false')
    expect(body.text).toContain('requestId=abc')
  })

  it('renders STATE_CHANGE with info severity using ℹ️ icon', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'STATE_CHANGE',
      field: 'tradingEnabled',
      from: true,
      to: false,
      severity: 'info',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('ℹ️')
    expect(body.text).toContain('state change: tradingEnabled true → false')
  })

  it('renders SUMMARY with the given severity icon and the raw multi-line message', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'SUMMARY',
      kind: 'news_shock_daily_summary',
      message: 'news shock gate 日次サマリ (mode=observe): 合成 regime=warning\n- trump_macro: normal\n- market_selloff: warning',
      severity: 'warning',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('⚠️')
    expect(body.text).toContain('合成 regime=warning')
    expect(body.text).toContain('market_selloff')
  })

  it('renders SUMMARY with default severity=info when severity is omitted', async () => {
    const { fn, calls } = makeFetch()
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x', fetchImpl: fn })

    await notifier.notify({
      type: 'SUMMARY',
      kind: 'news_shock_daily_summary',
      message: '合成 regime=normal',
    })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.text).toContain('ℹ️')
    expect(body.text).toContain('合成 regime=normal')
  })

  it('formatMessage is exposed for LoggingNotifier reuse (#141)', () => {
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.test/x' })
    const text = notifier.formatMessage({
      type: 'ERROR',
      message: 'reconcile fails',
      cause: 'reconcile_fills',
      severity: 'critical',
    })
    expect(text).toContain('🚨')
    expect(text).toContain('CRITICAL')
    expect(text).toContain('reconcile fails')
  })
})
