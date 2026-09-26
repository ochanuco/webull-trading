import { describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_CONFIG_DEFAULTS,
  loadGlobalConfig,
} from '../../../src/infrastructure/db/globalConfigRepo'

describe('loadGlobalConfig — pre-0015 fallback: two-stage (legacy select preserves existing values; full defaults only if legacy also fails) (#216 3rd round)', () => {
  // Both the full-column and legacy-column select() paths throw.
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

  // Full select() throws; legacy (explicit-column) select() returns legacyRow.
  function fakeDbThrowingThenLegacy(
    message: string,
    legacyRow: Record<string, unknown>,
  ) {
    return {
      select(columns?: unknown) {
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

  it('preserves legacy row values and only fills VIX 3 fields plus session_window_gate_enabled (0036) from defaults (legacy fetch ok)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // dryRun/tradingEnabled deliberately differ from GLOBAL_CONFIG_DEFAULTS,
    // to prove it's the row value (not a coincidentally-matching default) that survives.
    const legacyRow = {
      id: 'default',
      dryRun: false,
      tradingEnabled: true,
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

    expect(result.vixWarningThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold)
    expect(result.vixCriticalThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold)
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)

    expect(result.sessionWindowGateEnabled).toBe(
      GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
    )

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_pre_0015_fallback')
    expect(logged.requestId).toBe('req-abc-123')
    warnSpy.mockRestore()
  })

  it('falls back to defaults when 0045 (extended_hours_gate_mode) is missing, guarding against loadGlobalConfig throwing and stalling the strategy cron (#714 review)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('no such column: extended_hours_gate_mode')
    const result = await loadGlobalConfig(db, 'req-abc-123')
    expect(result.extendedHoursGateMode).toBe(GLOBAL_CONFIG_DEFAULTS.extendedHoursGateMode)
    expect(result.dryRun).toBe(GLOBAL_CONFIG_DEFAULTS.dryRun)
    warnSpy.mockRestore()
  })

  it('returns full defaults and emits 2 warnings when legacy fetch also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('no such column: vix_warning_threshold')
    const result = await loadGlobalConfig(db, 'req-abc-123')
    expect(result).toEqual({ ...GLOBAL_CONFIG_DEFAULTS })
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

  // Regression guard: the previous regex `/no such column|vix_/i` matched any
  // error containing the substring `vix_` (e.g. a request id like
  // `vix_pipeline_xxx`), fail-opening to defaults instead of rethrowing.
  it('rethrows non-schema errors that incidentally contain "vix_"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbAllThrowing('connection refused while serving vix_pipeline_42')
    await expect(loadGlobalConfig(db)).rejects.toThrow(/connection refused/)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns full defaults when legacy fetch succeeds but row is absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = {
      select(columns?: unknown) {
        const isLegacy = columns !== undefined
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    if (isLegacy) return []
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
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const first = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(first.event).toBe('global_config_pre_0015_fallback')
    warnSpy.mockRestore()
  })
})

// 0015 only ALTER-added the VIX columns (no CHECK constraint until a
// table-rebuild migration), so loadGlobalConfig enforces the invariants at
// the application level instead: fail-closed to defaults + warn (#216 6th round).
describe('loadGlobalConfig — VIX validation (CHECK 制約 補完)', () => {
  // Full select() returns [row] (post-0015 path); tests mutate VIX fields on it.
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

  it('falls back to defaults when vixWarningThreshold = 0 (range violation), leaving non-VIX fields like tradingEnabled untouched', async () => {
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

  it('falls back when vixWarningSizeScale = 1.5 (range violation) — a single VIX field violation defaults all 3 VIX fields together', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({
      ...baseRow,
      vixWarningThreshold: 25,
      vixCriticalThreshold: 30,
      vixWarningSizeScale: 1.5,
    })
    const result = await loadGlobalConfig(db, 'req-vix-scale')
    expect(result.vixWarningSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale)
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

describe('loadGlobalConfig — news_shock schema-missing fallback (0042), same SELECT-fails-at-SQL-level trap as VIX (0015)', () => {
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

// Same compensating-control rationale as the VIX describe above (0042 is
// ALTER-only, no CHECK constraint). Enum fields (pairRegimeMode/newsShockMode/
// attentionStalePolicy) fall back via a separate enum path, not covered here.
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
      newsShockWarnSizeScale: 0.5,
    })
    const result = await loadGlobalConfig(db, 'req-news-ok')
    expect(result.newsShockMode).toBe('enforce')
    expect(result.newsShockWarnSizeScale).toBe(0.5)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to defaults when newsShockWarnSizeScale is out of [0,1]', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, newsShockWarnSizeScale: 3 })
    const result = await loadGlobalConfig(db, 'req-news-scale')
    expect(result.newsShockWarnSizeScale).toBe(GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('global_config_news_shock_validation_failed')
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

  it('falls back extendedHoursGateMode to "off" for an enum-invalid DB value (0045, #709 Phase 6)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, extendedHoursGateMode: 'bogus' })
    const result = await loadGlobalConfig(db)
    expect(result.extendedHoursGateMode).toBe('off')
    warnSpy.mockRestore()
  })

  it('honors extendedHoursGateMode="enforce" when explicitly set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, extendedHoursGateMode: 'enforce' })
    const result = await loadGlobalConfig(db)
    expect(result.extendedHoursGateMode).toBe('enforce')
    warnSpy.mockRestore()
  })

  it('falls back cashFallbackSellMode to "off" for an enum-invalid DB value (0046, #452 follow-up)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, cashFallbackSellMode: 'bogus' })
    const result = await loadGlobalConfig(db)
    expect(result.cashFallbackSellMode).toBe('off')
    warnSpy.mockRestore()
  })

  it('honors cashFallbackSellMode="enforce" when explicitly set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDbWithRow({ ...baseRow, cashFallbackSellMode: 'enforce' })
    const result = await loadGlobalConfig(db)
    expect(result.cashFallbackSellMode).toBe('enforce')
    warnSpy.mockRestore()
  })
})
