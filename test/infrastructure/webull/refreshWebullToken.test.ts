import { describe, expect, it, vi } from 'vitest'
import { refreshWebullToken } from '../../../src/infrastructure/webull/refreshWebullToken'
import type { Env } from '../../../src/config/env'
import type {
  WebullAccessTokenDto,
  WebullTokenClient,
} from '../../../src/infrastructure/webull/WebullTokenClient'
import type { WebullTokenState } from '../../../src/trading/state/WebullTokenStateDO'

/** Fake DO namespace + stub backed by a mutable record. */
function makeStateNamespace(initial: WebullTokenState | null) {
  let state: WebullTokenState | null = initial
  const stub = {
    getState: vi.fn(async () => state),
    seedToken: vi.fn(async () => state!),
    recordRefresh: vi.fn(async (result: Parameters<typeof stub['recordRefresh']>[0]) => {
      const now = result.nowIso ?? '2026-05-20T00:00:00.000Z'
      if (result.success) {
        state = {
          token: result.token,
          expires: result.expires,
          status: result.status,
          fetchedAt: state && state.token === result.token ? state.fetchedAt : now,
          lastAttemptAt: now,
          lastSuccessAt: now,
        }
      } else if (state) {
        state = { ...state, lastAttemptAt: now }
      }
      return state
    }) as unknown as (
      result:
        | { success: true; token: string; expires: number; status: 'NORMAL'; nowIso?: string }
        | { success: false; nowIso?: string },
    ) => Promise<WebullTokenState | null>,
  }
  return {
    namespace: {
      idFromName: vi.fn(() => 'id-stub'),
      get: vi.fn(() => stub),
    } as unknown as Env['WEBULL_TOKEN_STATE'],
    stub,
    getState: () => state,
  }
}

function fakeTokenClient(returns: WebullAccessTokenDto | Error): WebullTokenClient {
  return {
    createToken: vi.fn(async () => {
      if (returns instanceof Error) throw returns
      return returns
    }),
    checkToken: vi.fn(async () => {
      throw new Error('not implemented')
    }),
  } as unknown as WebullTokenClient
}

const NORMAL: WebullAccessTokenDto = {
  token: 'tok-new',
  // ms epoch — exact value doesn't matter, we only check expires > now + 7d.
  expires: new Date('2026-12-31T00:00:00Z').getTime(),
  status: 'NORMAL',
}

describe('refreshWebullToken', () => {
  it('skips silently when no DO binding is configured (Phase A only env)', async () => {
    const env = { WEBULL_APP_KEY: 'k', WEBULL_APP_SECRET: 's' } as unknown as Env
    const result = await refreshWebullToken(env)
    expect(result.refreshed).toBe(false)
    expect(result.skippedReason).toMatch(/binding/)
  })

  it('skips when current NORMAL state has plenty of time left (not due yet)', async () => {
    const { namespace } = makeStateNamespace({
      token: 'tok-old',
      // 30 days from "now" in the test
      expires: new Date('2026-06-19T00:00:00Z').getTime(),
      status: 'NORMAL',
      fetchedAt: '2026-05-19T00:00:00Z',
      lastAttemptAt: '2026-05-19T00:00:00Z',
      lastSuccessAt: '2026-05-19T00:00:00Z',
    })
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient(NORMAL)
    const result = await refreshWebullToken(env, {
      now: () => new Date('2026-05-20T00:00:00Z'),
      tokenClient,
    })

    expect(result.refreshed).toBe(false)
    expect(result.skippedReason).toMatch(/not due yet/)
    expect(tokenClient.createToken).not.toHaveBeenCalled()
  })

  it('refreshes when expires is within the 7-day window', async () => {
    const { namespace, stub } = makeStateNamespace({
      token: 'tok-old',
      // 3 days away — inside the refresh window
      expires: new Date('2026-05-23T00:00:00Z').getTime(),
      status: 'NORMAL',
      fetchedAt: '2026-05-19T00:00:00Z',
      lastAttemptAt: '2026-05-19T00:00:00Z',
      lastSuccessAt: '2026-05-19T00:00:00Z',
    })
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient(NORMAL)
    const result = await refreshWebullToken(env, {
      now: () => new Date('2026-05-20T00:00:00Z'),
      tokenClient,
    })

    expect(result.refreshed).toBe(true)
    expect(tokenClient.createToken).toHaveBeenCalledWith('tok-old')
    expect(stub.recordRefresh).toHaveBeenCalled()
  })

  it('refreshes immediately when DO is empty (no prior state at all)', async () => {
    const { namespace } = makeStateNamespace(null)
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient(NORMAL)
    const result = await refreshWebullToken(env, { tokenClient })

    expect(result.refreshed).toBe(true)
    // createToken was called with undefined (no existing token to pass)
    expect(tokenClient.createToken).toHaveBeenCalledWith(undefined)
  })

  it('records a failed attempt when createToken returns non-NORMAL status', async () => {
    const { namespace, stub } = makeStateNamespace({
      token: 'tok-old',
      expires: new Date('2026-05-23T00:00:00Z').getTime(),
      status: 'NORMAL',
      fetchedAt: '2026-05-19T00:00:00Z',
      lastAttemptAt: '2026-05-19T00:00:00Z',
      lastSuccessAt: '2026-05-19T00:00:00Z',
    })
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient({ token: 'pending-tok', expires: 0, status: 'PENDING' })
    const result = await refreshWebullToken(env, {
      now: () => new Date('2026-05-20T00:00:00Z'),
      tokenClient,
    })

    expect(result.refreshed).toBe(false)
    expect(result.failureReason).toMatch(/PENDING/)
    // existing token is preserved, only lastAttemptAt bumps.
    expect(stub.recordRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    )
  })

  it('records a failed attempt when createToken throws (network / broker error)', async () => {
    const { namespace } = makeStateNamespace({
      token: 'tok-old',
      expires: new Date('2026-05-23T00:00:00Z').getTime(),
      status: 'NORMAL',
      fetchedAt: '2026-05-19T00:00:00Z',
      lastAttemptAt: '2026-05-19T00:00:00Z',
      lastSuccessAt: '2026-05-19T00:00:00Z',
    })
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient(new Error('broker 500'))
    const result = await refreshWebullToken(env, {
      now: () => new Date('2026-05-20T00:00:00Z'),
      tokenClient,
    })

    expect(result.refreshed).toBe(false)
    expect(result.failureReason).toMatch(/broker 500/)
  })

  it('refreshes when force=true even with plenty of time left', async () => {
    const { namespace } = makeStateNamespace({
      token: 'tok-old',
      expires: new Date('2027-01-01T00:00:00Z').getTime(),
      status: 'NORMAL',
      fetchedAt: '2026-05-19T00:00:00Z',
      lastAttemptAt: '2026-05-19T00:00:00Z',
      lastSuccessAt: '2026-05-19T00:00:00Z',
    })
    const env = {
      WEBULL_TOKEN_STATE: namespace,
      WEBULL_APP_KEY: 'k',
      WEBULL_APP_SECRET: 's',
    } as unknown as Env

    const tokenClient = fakeTokenClient(NORMAL)
    const result = await refreshWebullToken(env, {
      now: () => new Date('2026-05-20T00:00:00Z'),
      tokenClient,
      force: true,
    })

    expect(result.refreshed).toBe(true)
  })

  it('rejects when app key / secret missing', async () => {
    const { namespace } = makeStateNamespace(null)
    const env = { WEBULL_TOKEN_STATE: namespace } as unknown as Env
    const result = await refreshWebullToken(env)
    expect(result.refreshed).toBe(false)
    expect(result.failureReason).toMatch(/WEBULL_APP_KEY/)
  })
})
