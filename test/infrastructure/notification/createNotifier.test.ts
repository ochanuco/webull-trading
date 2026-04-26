import { describe, expect, it } from 'vitest'
import type { Env } from '../../../src/config/env'
import { createNotifier } from '../../../src/infrastructure/notification/createNotifier'
import { NoopNotifier } from '../../../src/infrastructure/notification/NoopNotifier'
import { WebhookNotifier } from '../../../src/infrastructure/notification/WebhookNotifier'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BASIC_AUTH_USER: 'u',
    BASIC_AUTH_PASSWORD: 'p',
    SYMBOL_STATE: undefined as never,
    ...overrides,
  } as Env
}

describe('createNotifier', () => {
  it('returns NoopNotifier when no webhook URLs are configured', () => {
    const n = createNotifier(makeEnv())
    expect(n).toBeInstanceOf(NoopNotifier)
  })

  it('returns NoopNotifier when both URLs are blank strings', () => {
    const n = createNotifier(
      makeEnv({ SLACK_WEBHOOK_URL: '   ', DISCORD_WEBHOOK_URL: '' }),
    )
    expect(n).toBeInstanceOf(NoopNotifier)
  })

  it('returns WebhookNotifier when only Slack is set', () => {
    const n = createNotifier(makeEnv({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }))
    expect(n).toBeInstanceOf(WebhookNotifier)
  })

  it('returns WebhookNotifier when only Discord is set', () => {
    const n = createNotifier(makeEnv({ DISCORD_WEBHOOK_URL: 'https://discord.test/webhooks/abc' }))
    expect(n).toBeInstanceOf(WebhookNotifier)
  })

  it('returns WebhookNotifier when both are set', () => {
    const n = createNotifier(
      makeEnv({
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        DISCORD_WEBHOOK_URL: 'https://discord.test/webhooks/abc',
      }),
    )
    expect(n).toBeInstanceOf(WebhookNotifier)
  })
})
