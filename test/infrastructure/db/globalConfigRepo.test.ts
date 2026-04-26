import { describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_CONFIG_DEFAULTS,
  loadGlobalConfig,
} from '../../../src/infrastructure/db/globalConfigRepo'

/**
 * pre-0015 (= migration 適用前 / 適用 race) D1 では VIX 列が schema に無く、
 * `select` 自体が `Error('no such column: vix_warning_threshold')` で失敗する。
 * その場合に defaults へ fallback して cron 全停止を避けることを確認する。
 */
describe('loadGlobalConfig — pre-0015 fallback', () => {
  function fakeDbThrowing(message: string) {
    return {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    throw new Error(message)
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof loadGlobalConfig>[0]
  }

  it('returns defaults when select fails with "no such column" error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbThrowing('no such column: vix_warning_threshold')
    const result = await loadGlobalConfig(db, 'req-abc-123')
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_pre_0015_fallback')
    expect(logged.message).toMatch(/no such column/)
    expect(logged.requestId).toBe('req-abc-123')
    warnSpy.mockRestore()
  })

  it('returns defaults when select fails with vix_-prefixed column error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbThrowing('SQLITE_ERROR: vix_critical_threshold not found')
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.requestId).toBeNull()
    warnSpy.mockRestore()
  })

  it('returns defaults when select fails with "does not exist" form', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbThrowing('column vix_warning_size_scale does not exist')
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    warnSpy.mockRestore()
  })

  it('rethrows unrelated errors (fail-closed for non-schema issues)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbThrowing('connection refused')
    await expect(loadGlobalConfig(db)).rejects.toThrow(/connection refused/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  /**
   * Regression guard: the previous regex `/no such column|vix_/i` happily
   * matched any error string that contained the substring `vix_` (e.g. a
   * connection error mentioning a request id like `vix_pipeline_xxx`),
   * fail-opening to defaults. The tightened regex must NOT match here.
   */
  it('rethrows non-schema errors that incidentally contain "vix_"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbThrowing('connection refused while serving vix_pipeline_42')
    await expect(loadGlobalConfig(db)).rejects.toThrow(/connection refused/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
