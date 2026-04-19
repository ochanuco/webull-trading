import type { LoadedGlobalConfig } from '../../src/infrastructure/db/globalConfigLoader'
import type { SymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'

/**
 * Default snapshot matching the legacy test env (DRY_RUN=true, TRADING_ENABLED=true,
 * MAX_ORDER_NOTIONAL=100 相当)。route / integration テストで D1 loader を vi.mock
 * する際のベースラインとして使う。
 */
export function makeGlobalConfigSnapshot(
  overrides: Partial<LoadedGlobalConfig> = {},
): LoadedGlobalConfig {
  return {
    dryRun: true,
    tradingEnabled: true,
    marketHoursCheck: false,
    maxOrderNotional: 100,
    maxOrderNotionalUsd: 100,
    maxOrderNotionalJpy: 100000,
    totalCapitalUsd: null,
    totalCapitalJpy: null,
    maxPortfolioExposurePct: 0.6,
    drawdownKillThreshold: -0.02,
    staleQuoteMs: 900_000,
    gapRejectPct: 0.03,
    spreadLimitPctUs: 0.0025,
    spreadLimitPctJp: 0.006,
    bridgeRunMode: 'auto',
    source: 'd1',
    ...overrides,
  }
}

export function makeSymbolUniverse(overrides: Partial<SymbolUniverse> = {}): SymbolUniverse {
  return {
    allowedSymbols: ['SOXL', 'SOXS'],
    symbolMaxNotional: {},
    symbolCurrency: { SOXL: 'USD', SOXS: 'USD' },
    inversePairs: {},
    source: 'd1',
    ...overrides,
  }
}
