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
  // #21 Phase B: DO 由来の NORMAL token が runtime の正源。Phase A の env は
  // bootstrap 用 fallback。両方 set されてれば DO 側を優先するのが本 helper の
  // 中核挙動。
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

  // DO に何も入ってないとき (= Phase A 初回起動 / 投入前) は env fallback で動く。
  // production cutover を「先に env で動かす → 後で DO 投入」の流れにできる。
  it('falls back to env when DO state is null', async () => {
    const env = {
      WEBULL_TOKEN_STATE: makeNamespace(null),
      WEBULL_ACCESS_TOKEN: 'env-bootstrap',
    } as unknown as Env

    expect(await resolveAccessToken(env)).toBe('env-bootstrap')
  })

  // INVALID / EXPIRED な state は「使うべきでない」シグナルなので env にも fallback
  // しない (現在の token を強制的に "無し" 扱いにする)。INVALID_TOKEN を broker が
  // 返してから operator が気付けるよう、わざと auth header を欠落させる。
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

  // DO call が throw した場合は env にフォールバックして broker call を試行させる。
  // DO bind が壊れてるからといって全 broker call を止めると過剰反応 → fail-safe
  // のレイヤーが多重化されてる事を尊重 (token なら broker 側で 401)。
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
