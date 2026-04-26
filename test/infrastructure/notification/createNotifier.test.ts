import { describe, expect, it } from 'vitest'
import type { Env } from '../../../src/config/env'
import { createNotifier } from '../../../src/infrastructure/notification/createNotifier'
import { LoggingNotifier } from '../../../src/infrastructure/notification/LoggingNotifier'
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
  it('returns NoopNotifier when no webhook URLs and no DB are configured', () => {
    const n = createNotifier(makeEnv())
    expect(n).toBeInstanceOf(NoopNotifier)
  })

  it('returns NoopNotifier when both URLs are blank strings and no DB', () => {
    const n = createNotifier(
      makeEnv({ SLACK_WEBHOOK_URL: '   ', DISCORD_WEBHOOK_URL: '' }),
    )
    expect(n).toBeInstanceOf(NoopNotifier)
  })

  it('returns WebhookNotifier when only Slack is set (no DB)', () => {
    const n = createNotifier(makeEnv({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }))
    expect(n).toBeInstanceOf(WebhookNotifier)
  })

  it('returns WebhookNotifier when only Discord is set (no DB)', () => {
    const n = createNotifier(makeEnv({ DISCORD_WEBHOOK_URL: 'https://discord.test/webhooks/abc' }))
    expect(n).toBeInstanceOf(WebhookNotifier)
  })

  it('returns WebhookNotifier when both are set (no DB)', () => {
    const n = createNotifier(
      makeEnv({
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        DISCORD_WEBHOOK_URL: 'https://discord.test/webhooks/abc',
      }),
    )
    expect(n).toBeInstanceOf(WebhookNotifier)
  })

  // #141: env.DB あり = LoggingNotifier で wrap される (D1 ログ用)
  it('returns LoggingNotifier wrapping NoopNotifier when only DB is bound (#141)', () => {
    const n = createNotifier(makeEnv({ DB: {} as D1Database }))
    expect(n).toBeInstanceOf(LoggingNotifier)
  })

  it('returns LoggingNotifier wrapping WebhookNotifier when DB + URLs are set (#141)', () => {
    const n = createNotifier(
      makeEnv({
        DB: {} as D1Database,
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
      }),
    )
    expect(n).toBeInstanceOf(LoggingNotifier)
  })
})
