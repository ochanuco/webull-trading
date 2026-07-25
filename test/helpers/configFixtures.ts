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
    sessionWindowGateEnabled: false,
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
    pullbackDefaultStopPct: -0.04,
    pullbackDefaultTakeProfitPct: 0.07,
    pullbackDefaultTimeStopDays: 10,
    pullbackDefaultPullbackMax: -0.03,
    pullbackDefaultPullbackMin: -0.06,
    pullbackDefaultMinReturn50d: 0.08,
    pullbackDefaultRequireAboveSma50: true,
    pullbackDefaultKAtr: 2.0,
    pullbackDefaultMaxSma50DeviationPct: 0.6,
    pullbackDefaultMaxAtrRatio: 1.5,
    pullbackDefaultMaxStopToTpRatio: 2.0,
    riskBasePerTradePct: 0.004,
    riskDdHalfThreshold: -0.05,
    riskDdHaltThreshold: -0.10,
    vixWarningThreshold: 25.0,
    vixCriticalThreshold: 30.0,
    vixWarningSizeScale: 0.5,
    cashFallbackOrdersEnabled: false,
    pairRegimeMode: 'off',
    pairRegimeThetaBullEnter: 0.03,
    pairRegimeThetaBullExit: 0.01,
    pairRegimeThetaBearEnter: -0.04,
    pairRegimeThetaBearExit: -0.015,
    source: 'd1',
    ...overrides,
  }
}

export function makeSymbolUniverse(overrides: Partial<SymbolUniverse> = {}): SymbolUniverse {
  return {
    allowedSymbols: ['SOXL', 'SOXS'],
    inactiveSymbols: [],
    symbolMaxNotional: {},
    symbolCurrency: { SOXL: 'USD', SOXS: 'USD' },
    symbolMarket: { SOXL: 'US', SOXS: 'US' },
    symbolName: {},
    symbolNotes: {},
    symbolTimeStopDaysOverride: {},
    symbolKAtrOverride: {},
    symbolBudgetAllocPct: {},
    symbolLotSize: { SOXL: 1, SOXS: 1 },
    symbolStopPctOverride: {},
    symbolTakeProfitPctOverride: {},
    symbolIntradayOnly: {},
    symbolRole: {},
    symbolPullbackMaxOverride: {},
    symbolPullbackMinOverride: {},
    symbolMinReturn50dOverride: {},
    symbolMaxAtrRatioOverride: {},
    symbolMaxSma50DeviationPctOverride: {},
    symbolRequireAboveSma50Override: {},
    symbolEntryRequired: {},
    symbolAlwaysActive: {},
    symbolCashFallback: {},
    inversePairs: {},
    pairRegimes: [],
    source: 'd1',
    ...overrides,
  }
}
