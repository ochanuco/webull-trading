import { describe, expect, it, vi } from 'vitest'
import { resolveAccessToken } from '../../../src/infrastructure/webull/resolveAccessToken'
import type { Env } from '../../../src/config/env'
import type { WebullTokenState } from '../../../src/trading/state/WebullTokenStateDO'

/**
 * Fake `DurableObjectNamespace<WebullTokenStateDO>` for tests. Wraps a
 * single-shot state value with a `getState()` stub so we can exercise the
 * resolver without spinning up a real DO runtime.
 */
function makeNamespace(state: WebullTokenState | null, throws?: Error) {
  const stub = { getState: vi.fn(async () => { if (throws) throw throws; return state }) }
  return {
    idFromName: vi.fn(() => 'id-stub'),
    get: vi.fn(() => stub),
  } as unknown as Env['WEBULL_TOKEN_STATE']
}

describe('resolveAccessToken', () => {
  // #21 Phase B: a NORMAL DO token is the runtime source of truth; env (Phase A) is bootstrap-only fallback.
  it('returns DO token when DO state is NORMAL (env fallback is ignored)', async () => {
    const env = {
      WEBULL_TOKEN_STATE: makeNamespace({
        token: 'do-token',
        expires: 9_999_999_999,
        status: 'NORMAL',
        fetchedAt: '2026-05-20T00:00:00Z',
        lastAttemptAt: '2026-05-20T00:00:00Z',
        lastSuccessAt: '2026-05-20T00:00:00Z',
      }),
      WEBULL_ACCESS_TOKEN: 'env-token-should-be-ignored',
    } as unknown as Env

    expect(await resolveAccessToken(env)).toBe('do-token')
  })

  // Lets a production cutover run on env first and backfill the DO state later.
  it('falls back to env when DO state is null', async () => {
    const env = {
      WEBULL_TOKEN_STATE: makeNamespace(null),
      WEBULL_ACCESS_TOKEN: 'env-bootstrap',
    } as unknown as Env

    expect(await resolveAccessToken(env)).toBe('env-bootstrap')
  })

  // PENDING/INVALID/EXPIRED are "don't use this" signals, not just "unset" —
  // env fallback still applies (it's a separate credential, not a stand-in for the DO token).
  it.each(['PENDING', 'INVALID', 'EXPIRED'] as const)(
    'returns env fallback when DO state is %s (does not silently emit stale token)',
    async (status) => {
      const env = {
        WEBULL_TOKEN_STATE: makeNamespace({
          token: 'stale-token',
          expires: 1_700_000_000,
          status,
          fetchedAt: '2026-05-20T00:00:00Z',
          lastAttemptAt: '2026-05-20T00:00:00Z',
          lastSuccessAt: null,
        }),
        WEBULL_ACCESS_TOKEN: 'env-fallback',
      } as unknown as Env

      expect(await resolveAccessToken(env)).toBe('env-fallback')
    },
  )

  it('returns env when DO binding is not configured', async () => {
    const env = {
      WEBULL_ACCESS_TOKEN: 'env-only',
    } as unknown as Env

    expect(await resolveAccessToken(env)).toBe('env-only')
  })

  it('returns undefined when neither DO nor env is set', async () => {
    const env = {} as unknown as Env
    expect(await resolveAccessToken(env)).toBeUndefined()
  })

  it('treats whitespace-only env as unset', async () => {
    const env = { WEBULL_ACCESS_TOKEN: '   ' } as unknown as Env
    expect(await resolveAccessToken(env)).toBeUndefined()
  })

  // A broken DO binding shouldn't halt every broker call — fall back to env and
  // let the broker itself reject with 401 if the token turns out bad.
  it('falls back to env when DO stub throws (with warn log)', async () => {
    const env = {
      WEBULL_TOKEN_STATE: makeNamespace(null, new Error('do offline')),
      WEBULL_ACCESS_TOKEN: 'env-after-do-fail',
    } as unknown as Env

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await resolveAccessToken(env)).toBe('env-after-do-fail')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
