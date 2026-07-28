import { describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_CONFIG_DEFAULTS,
  loadGlobalConfig,
} from '../../../src/infrastructure/db/globalConfigRepo'

/**
 * pre-0015 (= migration 適用前 / 適用 race) D1 では VIX 列が schema に無く、
 * `select` 自体が `Error('no such column: vix_warning_threshold')` で失敗する。
 * その場合に
 *   1. legacy 列だけを明示 select する path で既存 row 値を保持し
 *      VIX 3 項目だけ defaults で埋める (#216 3rd round)、
 *   2. legacy fetch も失敗するケースで初めて全 defaults に倒す
 * の 2 段階 fallback を検証する。
 */
describe('loadGlobalConfig — pre-0015 fallback', () => {
  /**
   * full select (1st call) は throw、explicit-column legacy select (2nd call) も throw。
   * 「row が無い / DB ごと壊れている」の double failure ケース。
   */
  function fakeDbAllThrowing(message: string) {
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

  /**
   * full select (引数なし) は throw、explicit-column select (引数あり = legacy path) は
   * `legacyRow` を返す。pre-0015 で legacy row が存在する正常 fallback ケース。
   */
  function fakeDbThrowingThenLegacy(
    message: string,
    legacyRow: Record<string, unknown>,
  ) {
    return {
      select(columns?: unknown) {
        // legacy path = `select({ id, dryRun, ... })` で columns 指定あり。
        // full path = `select()` で columns 指定なし。
        const isLegacy = columns !== undefined
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    if (isLegacy) return [legacyRow]
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

  it('preserves legacy row values and only fills VIX 3 fields from defaults (legacy fetch ok)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // legacy row: tradingEnabled は false (= 既存運用値) のまま保持されるべき。
    // defaults では tradingEnabled: false なので `tradingEnabled` の検証は別 field でも行う。
    const legacyRow = {
      id: 'default',
      dryRun: false, // defaults: true → legacy 値 false が保持されるか
      tradingEnabled: true, // defaults: false → legacy 値 true が保持されるか
      marketHoursCheck: true,
      maxOrderNotional: 500,
      maxOrderNotionalUsd: 5000,
      maxOrderNotionalJpy: 250000,
      totalCapitalUsd: 10000,
      totalCapitalJpy: 1500000,
      maxPortfolioExposurePct: 0.8,
      drawdownKillThreshold: -0.05,
      staleQuoteMs: 60000,
      gapRejectPct: 0.05,
      spreadLimitPctUs: 0.005,
      spreadLimitPctJp: 0.01,
      pullbackDefaultStopPct: -0.06,
      pullbackDefaultTakeProfitPct: 0.1,
      pullbackDefaultTimeStopDays: 15,
      pullbackDefaultPullbackMax: -0.04,
      pullbackDefaultPullbackMin: -0.08,
      pullbackDefaultMinReturn50d: 0.12,
      pullbackDefaultRequireAboveSma50: false,
      pullbackDefaultKAtr: 2.5,
      riskBasePerTradePct: 0.006,
      riskDdHalfThreshold: -0.07,
      riskDdHaltThreshold: -0.15,
    }
    const db = fakeDbThrowingThenLegacy(
      'no such column: vix_warning_threshold',
      legacyRow,
    )
    const result = await loadGlobalConfig(db, 'req-abc-123')

    // legacy row の値が保持されていること
    expect(result.dryRun).toBe(false)
    expect(result.tradingEnabled).toBe(true)
    expect(result.marketHoursCheck).toBe(true)
    expect(result.maxOrderNotional).toBe(500)
    expect(result.maxOrderNotionalUsd).toBe(5000)
    expect(result.maxOrderNotionalJpy).toBe(250000)
    expect(result.totalCapitalUsd).toBe(10000)
    expect(result.totalCapitalJpy).toBe(1500000)
    expect(result.maxPortfolioExposurePct).toBe(0.8)
    expect(result.drawdownKillThreshold).toBe(-0.05)
    expect(result.pullbackDefaultStopPct).toBe(-0.06)
    expect(result.pullbackDefaultRequireAboveSma50).toBe(false)

    // VIX 3 項目だけは defaults で埋められること
    expect(result.vixWarningThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold)
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)

    // 0036 列 (session_window_gate_enabled) も legacy path では default (false) に畳む
    expect(result.sessionWindowGateEnabled).toBe(
      GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
    )

    // pre_0015_fallback の 1 件だけ warn (legacy_load_failed は出ない)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_pre_0015_fallback')
    expect(logged.requestId).toBe('req-abc-123')
    warnSpy.mockRestore()
  })

  it('returns full defaults and emits 2 warnings when legacy fetch also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('no such column: vix_warning_threshold')
    const result = await loadGlobalConfig(db, 'req-abc-123')
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    // pre_0015_fallback + legacy_load_failed の 2 件 warn
    expect(warnSpy).toHaveBeenCalledTimes(2)
    const first = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    const second = JSON.parse(warnSpy.mock.calls[1]![0] as string)
    expect(first.event).toBe('global_config_pre_0015_fallback')
    expect(first.requestId).toBe('req-abc-123')
    expect(second.event).toBe('global_config_legacy_load_failed')
    expect(second.requestId).toBe('req-abc-123')
    warnSpy.mockRestore()
  })

  it('triggers fallback for vix_-prefixed "not found" error and reaches legacy_load_failed when legacy also throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('SQLITE_ERROR: vix_critical_threshold not found')
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(warnSpy).toHaveBeenCalledTimes(2)
    const first = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(first.event).toBe('global_config_pre_0015_fallback')
    expect(first.requestId).toBeNull()
    warnSpy.mockRestore()
  })

  it('triggers fallback for "does not exist" form', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('column vix_warning_size_scale does not exist')
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it('rethrows unrelated errors (fail-closed for non-schema issues)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('connection refused')
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
    const db = fakeDbAllThrowing('connection refused while serving vix_pipeline_42')
    await expect(loadGlobalConfig(db)).rejects.toThrow(/connection refused/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns full defaults when legacy fetch succeeds but row is absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // legacy 配列が空 = row 未 seed のレア case
    const db = {
      select(columns?: unknown) {
        const isLegacy = columns !== undefined
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    if (isLegacy) return [] // empty
                    throw new Error('no such column: vix_warning_threshold')
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof loadGlobalConfig>[0]
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    // pre_0015_fallback の 1 件のみ (legacy fetch は成功し row なしなので legacy_load_failed は出ない)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const first = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(first.event).toBe('global_config_pre_0015_fallback')
    warnSpy.mockRestore()
  })
})

/**
 * 0015 migration は ALTER TABLE ADD COLUMN しか流していないため CHECK 制約は
 * 未投入。table-rebuild migration で一括投入するまでの compensating control
 * として `loadGlobalConfig` 内で application-level validation を行う:
 *   - vixWarningThreshold / vixCriticalThreshold ∈ (0, 200]
 *   - vixWarningThreshold <= vixCriticalThreshold
 *   - vixWarningSizeScale ∈ [0, 1]
 * 違反時は **fail-closed = defaults fallback** + warn ログ。
 * CodeRabbit #216 6th round 対応。
 */
describe('loadGlobalConfig — VIX validation (CHECK 制約 補完)', () => {
  /**
   * full select (1st call) が `[row]` を返す (= post-0015 path)。VIX 列を含む
   * 完全な row。validation の対象は最終 return 直前なので、ここから不正値を
   * 挿入することで validateVixConfig の挙動を検証できる。
   */
  function fakeDbWithRow(row: Record<string, unknown>) {
    return {
      select(_columns?: unknown) {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [row]
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof loadGlobalConfig>[0]
  }

  // post-0015 row 用の baseline。検証ケースごとに VIX 3 列を上書きする。
  const baseRow = {
    id: 'default',
    dryRun: true,
    tradingEnabled: false,
    marketHoursCheck: false,
    maxOrderNotional: 100,
    maxOrderNotionalUsd: 2000,
    maxOrderNotionalJpy: 100000,
    totalCapitalUsd: null,
    totalCapitalJpy: null,
    maxPortfolioExposurePct: 0.6,
    drawdownKillThreshold: -0.02,
    staleQuoteMs: 900000,
    gapRejectPct: 0.03,
    spreadLimitPctUs: 0.0025,
    spreadLimitPctJp: 0.006,
    pullbackDefaultStopPct: -0.04,
    pullbackDefaultTakeProfitPct: 0.07,
    pullbackDefaultTimeStopDays: 10,
    pullbackDefaultPullbackMax: -0.03,
    pullbackDefaultPullbackMin: -0.06,
    pullbackDefaultMinReturn50d: 0.08,
    pullbackDefaultRequireAboveSma50: true,
    pullbackDefaultKAtr: 2.0,
    riskBasePerTradePct: 0.004,
    riskDdHalfThreshold: -0.05,
    riskDdHaltThreshold: -0.1,
  }

  it('passes through valid VIX values without warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 22.5,
      vixCriticalThreshold: 28.0,
      vixWarningSizeScale: 0.4,
    })
    const result = await loadGlobalConfig(db, 'req-vix-ok')
    expect(result.vixWarningThreshold).toBe(22.5)
    expect(result.vixCriticalThreshold).toBe(28.0)
    expect(result.vixWarningSizeScale).toBe(0.4)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to defaults when vixWarningThreshold = 0 (range violation)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 0,
      vixCriticalThreshold: 30,
      vixWarningSizeScale: 0.5,
    })
    const result = await loadGlobalConfig(db, 'req-vix-zero')
    expect(result.vixWarningThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold)
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)
    // 他の non-VIX 列は row 値が保持されること
    expect(result.tradingEnabled).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_vix_validation_failed')
    expect(logged.requestId).toBe('req-vix-zero')
    expect(Array.isArray(logged.violations)).toBe(true)
    expect(logged.violations.some((v: { field: string }) => v.field === 'vixWarningThreshold')).toBe(true)
    warnSpy.mockRestore()
  })

  it('falls back when warning > critical (order violation)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 30,
      vixCriticalThreshold: 25,
      vixWarningSizeScale: 0.5,
    })
    const result = await loadGlobalConfig(db, 'req-vix-order')
    expect(result.vixWarningThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold)
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_vix_validation_failed')
    expect(
      logged.violations.some((v: { field: string }) =>
        v.field === 'vixWarningThreshold/vixCriticalThreshold',
      ),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('falls back when vixWarningSizeScale = 1.5 (range violation)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 25,
      vixCriticalThreshold: 30,
      vixWarningSizeScale: 1.5,
    })
    const result = await loadGlobalConfig(db, 'req-vix-scale')
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)
    // 単独違反でも他 2 項目も defaults に倒される (compensating control の安全側)
    expect(result.vixWarningThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold)
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_vix_validation_failed')
    expect(
      logged.violations.some((v: { field: string }) => v.field === 'vixWarningSizeScale'),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('falls back when vixCriticalThreshold > 200 (range violation, upper bound)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 25,
      vixCriticalThreshold: 250,
      vixWarningSizeScale: 0.5,
    })
    const result = await loadGlobalConfig(db, 'req-vix-upper')
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(
      logged.violations.some((v: { field: string }) => v.field === 'vixCriticalThreshold'),
    ).toBe(true)
    warnSpy.mockRestore()
  })
})

/**
 * news-shock-gate PR 2: 0042 migration (`news_shock_*` / `attention_stale_policy`)
 * 未適用の環境でも VIX (0015) と同じ「SELECT が SQL レベルで落ちる」罠を踏む。
 * schema-missing regex を拡張したことの回帰ガード。
 */
describe('loadGlobalConfig — news_shock schema-missing fallback (0042)', () => {
  function fakeDbAllThrowing(message: string) {
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

  it('triggers the same fallback for "no such column: news_shock_mode"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('no such column: news_shock_mode')
    const result = await loadGlobalConfig(db, 'req-news-1')
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(result.newsShockMode).toBe('off')
    const first = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(first.event).toBe('global_config_pre_0015_fallback')
    warnSpy.mockRestore()
  })

  it('triggers the same fallback for "no such column: attention_stale_policy"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('no such column: attention_stale_policy')
    const result = await loadGlobalConfig(db)
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
    expect(result.attentionStalePolicy).toBe('fail_open')
    warnSpy.mockRestore()
  })

  it('still rethrows unrelated errors that do not mention a known missing column', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('connection refused')
    await expect(loadGlobalConfig(db)).rejects.toThrow(/connection refused/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

/**
 * news-shock-gate PR 2: `newsShockWarnRatio` / `newsShockBlockRatio` /
 * `newsShockWarnSizeScale` 等の application-level validation (0042 は ALTER
 * ADD COLUMN のみで CHECK 制約を持たないための compensating control)。
 * `pairRegimeMode` / `newsShockMode` / `attentionStalePolicy` は enum
 * fallback (別 code path) なのでここでは扱わない。
 */
describe('loadGlobalConfig — news shock validation (CHECK 制約 補完)', () => {
  function fakeDbWithRow(row: Record<string, unknown>) {
    return {
      select(_columns?: unknown) {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [row]
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof loadGlobalConfig>[0]
  }

  const baseRow = {
    id: 'default',
    dryRun: true,
    tradingEnabled: false,
    marketHoursCheck: false,
    maxOrderNotional: 100,
    maxOrderNotionalUsd: 2000,
    maxOrderNotionalJpy: 100000,
    totalCapitalUsd: null,
    totalCapitalJpy: null,
    maxPortfolioExposurePct: 0.6,
    drawdownKillThreshold: -0.02,
    staleQuoteMs: 900000,
    gapRejectPct: 0.03,
    spreadLimitPctUs: 0.0025,
    spreadLimitPctJp: 0.006,
    pullbackDefaultStopPct: -0.04,
    pullbackDefaultTakeProfitPct: 0.07,
    pullbackDefaultTimeStopDays: 10,
    pullbackDefaultPullbackMax: -0.03,
    pullbackDefaultPullbackMin: -0.06,
    pullbackDefaultMinReturn50d: 0.08,
    pullbackDefaultRequireAboveSma50: true,
    pullbackDefaultKAtr: 2.0,
    riskBasePerTradePct: 0.004,
    riskDdHalfThreshold: -0.05,
    riskDdHaltThreshold: -0.1,
    vixWarningThreshold: 25,
    vixCriticalThreshold: 30,
    vixWarningSizeScale: 0.5,
  }

  it('passes through valid news shock values without warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      newsShockMode: 'enforce',
      newsShockWarnRatio: 2.3,
      newsShockBlockRatio: 4.4,
      newsShockWarnSizeScale: 0.5,
    })
    const result = await loadGlobalConfig(db, 'req-news-ok')
    expect(result.newsShockMode).toBe('enforce')
    expect(result.newsShockWarnRatio).toBe(2.3)
    expect(result.newsShockBlockRatio).toBe(4.4)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to defaults when warnRatio > blockRatio (order violation)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      newsShockWarnRatio: 10,
      newsShockBlockRatio: 2,
    })
    const result = await loadGlobalConfig(db, 'req-news-order')
    expect(result.newsShockWarnRatio).toBe(GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio)
    expect(result.newsShockBlockRatio).toBe(GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_news_shock_validation_failed')
    expect(
      logged.violations.some(
        (v: { field: string }) => v.field === 'newsShockWarnRatio/newsShockBlockRatio',
      ),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  it('falls back to defaults when newsShockWarnSizeScale is out of [0,1]', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, newsShockWarnSizeScale: 3 })
    const result = await loadGlobalConfig(db, 'req-news-scale')
    expect(result.newsShockWarnSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('falls back to defaults when newsShockMinSamples is not a positive integer', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, newsShockMinSamples: -5 })
    const result = await loadGlobalConfig(db, 'req-news-samples')
    expect(result.newsShockMinSamples).toBe(GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples)
    warnSpy.mockRestore()
  })

  it('falls back newsShockMode to "off" for an enum-invalid DB value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, newsShockMode: 'bogus' })
    const result = await loadGlobalConfig(db)
    expect(result.newsShockMode).toBe('off')
    warnSpy.mockRestore()
  })

  it('falls back attentionStalePolicy to "fail_open" for an enum-invalid DB value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, attentionStalePolicy: 'bogus' })
    const result = await loadGlobalConfig(db)
    expect(result.attentionStalePolicy).toBe('fail_open')
    warnSpy.mockRestore()
  })

  it('honors attentionStalePolicy="block_buy" when explicitly set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, attentionStalePolicy: 'block_buy' })
    const result = await loadGlobalConfig(db)
    expect(result.attentionStalePolicy).toBe('block_buy')
    warnSpy.mockRestore()
  })
})
