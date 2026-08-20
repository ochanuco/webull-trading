import { describe, expect, it } from 'vitest'
import type { DailyBar } from '../../../src/trading/strategy/indicators'
import {
  avgNonNull,
  classifyLiveExitReason,
  classifyRoundTrips,
  classifySkipReason,
  computeDrawdown,
  computeExitReasonStats,
  computeForwardReturns,
  computePreEntryRunup,
  computeSkipOutcome,
  computeTurnover,
  crossTabSlExitsWithExtendedHours,
  dedupSkipSignalsByDay,
  pairRoundTrips,
  resolveFillSide,
  sumEstimatedCost,
  type ClassifiedRoundTrip,
  type LifecycleFill,
  type RoundTrip,
  type SkipSignal,
} from '../../../src/trading/analysis/lifecycleMetrics'

function fill(overrides: Partial<LifecycleFill> = {}): LifecycleFill {
  return {
    symbol: 'SOXL',
    side: 'BUY',
    qty: 1,
    price: 100,
    at: '2026-06-01T14:00:00.000Z',
    clientOrderId: null,
    realizedPnl: null,
    estimatedCost: null,
    ...overrides,
  }
}

function bar(date: string, close: number, high = close, low = close, open = close): DailyBar {
  return { date, open, high, low, close }
}

describe('resolveFillSide', () => {
  it('pre_submit の side をそのまま採用', () => {
    expect(resolveFillSide('BUY', null)).toBe('BUY')
    expect(resolveFillSide('SELL', null)).toBe('SELL')
  })
  it('pre_submit 欠損時は realizedPnl の有無で推測', () => {
    expect(resolveFillSide(null, 5)).toBe('SELL')
    expect(resolveFillSide(null, null)).toBe('BUY')
  })
})

describe('pairRoundTrips', () => {
  it('BUY → SELL の 1 往復を組む', () => {
    const trips = pairRoundTrips([
      fill({ side: 'BUY', at: '2026-06-01T14:00:00.000Z', price: 100, clientOrderId: 'buy-1' }),
      fill({
        side: 'SELL',
        at: '2026-06-05T14:00:00.000Z',
        price: 107,
        realizedPnl: 7,
        clientOrderId: 'sell-1',
      }),
    ])
    expect(trips).toEqual<RoundTrip[]>([
      {
        symbol: 'SOXL',
        entryAt: '2026-06-01T14:00:00.000Z',
        exitAt: '2026-06-05T14:00:00.000Z',
        entryPrice: 100,
        exitPrice: 107,
        qty: 1,
        realizedPnl: 7,
        exitClientOrderId: 'sell-1',
      },
    ])
  })

  it('連続 BUY (部分約定 / position add) は最初の BUY を開始点にする', () => {
    const trips = pairRoundTrips([
      fill({ side: 'BUY', at: '2026-06-01T14:00:00.000Z', price: 100 }),
      fill({ side: 'BUY', at: '2026-06-02T14:00:00.000Z', price: 98 }),
      fill({ side: 'SELL', at: '2026-06-05T14:00:00.000Z', price: 103, realizedPnl: 4 }),
    ])
    expect(trips).toHaveLength(1)
    expect(trips[0]!.entryAt).toBe('2026-06-01T14:00:00.000Z')
  })

  it('末尾の未決済 BUY はスキップする', () => {
    const trips = pairRoundTrips([
      fill({ side: 'BUY', at: '2026-06-01T14:00:00.000Z', price: 100 }),
      fill({ side: 'SELL', at: '2026-06-05T14:00:00.000Z', price: 107, realizedPnl: 7 }),
      fill({ side: 'BUY', at: '2026-06-10T14:00:00.000Z', price: 110 }),
    ])
    expect(trips).toHaveLength(1)
    expect(trips[0]!.exitAt).toBe('2026-06-05T14:00:00.000Z')
  })

  it('BUY 先行の無い SELL (手動売却の残骸) は区間にしない', () => {
    const trips = pairRoundTrips([
      fill({ side: 'SELL', at: '2026-06-01T14:00:00.000Z', price: 100, realizedPnl: 3 }),
      fill({ side: 'BUY', at: '2026-06-02T14:00:00.000Z', price: 98 }),
      fill({ side: 'SELL', at: '2026-06-05T14:00:00.000Z', price: 95, realizedPnl: -3 }),
    ])
    expect(trips).toHaveLength(1)
    expect(trips[0]!.entryAt).toBe('2026-06-02T14:00:00.000Z')
  })

  it('複数銘柄混在の入力を symbol ごとに独立して突合し、exitAt 昇順で返す', () => {
    const trips = pairRoundTrips([
      fill({ symbol: 'SOXL', side: 'BUY', at: '2026-06-01T14:00:00.000Z', price: 10 }),
      fill({ symbol: 'TQQQ', side: 'BUY', at: '2026-06-01T14:05:00.000Z', price: 20 }),
      fill({ symbol: 'TQQQ', side: 'SELL', at: '2026-06-02T14:00:00.000Z', price: 22, realizedPnl: 2 }),
      fill({ symbol: 'SOXL', side: 'SELL', at: '2026-06-03T14:00:00.000Z', price: 11, realizedPnl: 1 }),
    ])
    expect(trips.map((t) => t.symbol)).toEqual(['TQQQ', 'SOXL'])
  })
})

describe('classifyLiveExitReason', () => {
  it('実文言サンプル (PullbackUptrendStrategy.ts / pullbackScheduler.ts) を全カテゴリに分類する', () => {
    expect(classifyLiveExitReason('take-profit hit: pnl 0.0700 >= 0.07')).toBe('TP')
    expect(
      classifyLiveExitReason('stop-loss hit: pnl -0.0400 <= -0.0400 (pct, dist 4.00)'),
    ).toBe('SL')
    expect(classifyLiveExitReason('time-stop hit: held 10d >= 10d')).toBe('TIME_STOP')
    expect(
      classifyLiveExitReason('pair regime flip: zone=bear against held bull side (score below threshold)'),
    ).toBe('REGIME_FLIP')
    expect(classifyLiveExitReason('intraday-only: force-close before US market close')).toBe(
      'INTRADAY_CLOSE',
    )
    expect(
      classifyLiveExitReason('cash allocation rebalance: buy 3 toward active weight (#452)'),
    ).toBe('REBALANCE')
  })

  it('未知の形式は OTHER、reason 欠損 (join できない) は UNKNOWN', () => {
    expect(classifyLiveExitReason('some future exit route')).toBe('OTHER')
    expect(classifyLiveExitReason(null)).toBe('UNKNOWN')
    expect(classifyLiveExitReason(undefined)).toBe('UNKNOWN')
  })
})

describe('classifyRoundTrips', () => {
  it('exitClientOrderId → reason lookup でカテゴリを付与する', () => {
    const trips: RoundTrip[] = [
      {
        symbol: 'SOXL',
        entryAt: '2026-06-01T14:00:00.000Z',
        exitAt: '2026-06-05T14:00:00.000Z',
        entryPrice: 100,
        exitPrice: 107,
        qty: 1,
        realizedPnl: 7,
        exitClientOrderId: 'sell-1',
      },
      {
        symbol: 'SOXL',
        entryAt: '2026-07-01T14:00:00.000Z',
        exitAt: '2026-07-05T14:00:00.000Z',
        entryPrice: 100,
        exitPrice: 95,
        qty: 1,
        realizedPnl: -5,
        exitClientOrderId: null,
      },
    ]
    const reasonMap = new Map([['sell-1', 'take-profit hit: pnl 0.07 >= 0.07']])
    const classified = classifyRoundTrips(trips, reasonMap)
    expect(classified[0]!.exitReasonCategory).toBe('TP')
    expect(classified[1]!.exitReasonCategory).toBe('UNKNOWN')
  })
})

describe('computeExitReasonStats', () => {
  it('カテゴリ別の勝率/平均利益/平均損失/期待値を集計する', () => {
    const trips: ClassifiedRoundTrip[] = [
      trip({ realizedPnl: 10, exitReasonCategory: 'TP' }),
      trip({ realizedPnl: 6, exitReasonCategory: 'TP' }),
      trip({ realizedPnl: -4, exitReasonCategory: 'SL' }),
      trip({ realizedPnl: null, exitReasonCategory: 'SL' }), // 欠損は除外
    ]
    const stats = computeExitReasonStats(trips)
    expect(stats).toEqual([
      { category: 'TP', count: 2, wins: 2, losses: 0, winRate: 1, avgWin: 8, avgLoss: 0, expectancy: 8 },
      { category: 'SL', count: 1, wins: 0, losses: 1, winRate: 0, avgWin: 0, avgLoss: -4, expectancy: -4 },
    ])
  })

  function trip(overrides: Partial<ClassifiedRoundTrip>): ClassifiedRoundTrip {
    return {
      symbol: 'SOXL',
      entryAt: '2026-06-01T14:00:00.000Z',
      exitAt: '2026-06-05T14:00:00.000Z',
      entryPrice: 100,
      exitPrice: 100,
      qty: 1,
      realizedPnl: null,
      exitClientOrderId: null,
      exitReasonCategory: 'OTHER',
      ...overrides,
    }
  }
})

describe('computeForwardReturns', () => {
  const bars: DailyBar[] = [
    bar('2026-06-01', 100),
    bar('2026-06-02', 102, 105),
    bar('2026-06-03', 101, 103),
    bar('2026-06-04', 104, 106),
    bar('2026-06-05', 103, 104),
    bar('2026-06-08', 108, 110),
  ]

  it('exit bar から +1/+3/+5/+10 の return を計算する (bar 不足分は null)', () => {
    const result = computeForwardReturns({ exitAt: '2026-06-01T14:00:00.000Z' }, bars)
    expect(result.r1).toBeCloseTo((102 - 100) / 100)
    expect(result.r3).toBeCloseTo((104 - 100) / 100)
    expect(result.r5).toBeCloseTo((108 - 100) / 100)
    expect(result.r10).toBeNull() // bars に 10 本先が無い
  })

  it('post-exit MFE は取得できた bar 範囲で best-effort に計算する', () => {
    const result = computeForwardReturns({ exitAt: '2026-06-01T14:00:00.000Z' }, bars)
    // 2026-06-08 の high=110 が最大上振れ ((110-100)/100)
    expect(result.postExitMfe10).toBeCloseTo((110 - 100) / 100)
  })

  it('exit 日以降の bar が無いときは全て null', () => {
    const result = computeForwardReturns({ exitAt: '2026-07-01T14:00:00.000Z' }, bars)
    expect(result).toEqual({ r1: null, r3: null, r5: null, r10: null, postExitMfe10: null })
  })
})

describe('computePreEntryRunup', () => {
  const bars: DailyBar[] = [
    bar('2026-05-25', 90),
    bar('2026-05-26', 92),
    bar('2026-05-27', 93),
    bar('2026-05-28', 94),
    bar('2026-05-29', 95),
    bar('2026-06-01', 100),
  ]

  it('entry bar と 5 本前の bar を比較する', () => {
    const runup = computePreEntryRunup({ entryAt: '2026-06-01T14:00:00.000Z' }, bars)
    expect(runup).toBeCloseTo((100 - 90) / 90)
  })

  it('entry 前に 5 本の bar が無ければ null', () => {
    const shortBars = bars.slice(-3)
    const runup = computePreEntryRunup({ entryAt: '2026-06-01T14:00:00.000Z' }, shortBars)
    expect(runup).toBeNull()
  })
})

describe('classifySkipReason', () => {
  it('prefix ベースで軽量 4 分類する', () => {
    expect(classifySkipReason('portfolio_halted: kill switch')).toBe('HALT')
    expect(classifySkipReason('drawdown_kill: -6.5%')).toBe('HALT')
    expect(classifySkipReason('sizing rejected: missing-lot-size')).toBe('SIZING')
    expect(classifySkipReason('risk: vix_critical: 38.2')).toBe('RISK')
    expect(classifySkipReason('pair_regime: zone=bear blocks bull entry')).toBe('RISK')
    expect(classifySkipReason('insufficient bars for indicators')).toBe('OTHER')
    expect(classifySkipReason(null)).toBe('OTHER')
  })
})

describe('dedupSkipSignalsByDay', () => {
  it('(symbol, UTC 日付) ごとに最初の 1 件だけ残す', () => {
    const signals: SkipSignal[] = [
      { symbol: 'SOXL', at: '2026-06-01T13:05:00.000Z', reason: 'risk: a' },
      { symbol: 'SOXL', at: '2026-06-01T13:20:00.000Z', reason: 'risk: b' },
      { symbol: 'TQQQ', at: '2026-06-01T13:20:00.000Z', reason: 'risk: c' },
      { symbol: 'SOXL', at: '2026-06-02T13:05:00.000Z', reason: 'risk: d' },
    ]
    const deduped = dedupSkipSignalsByDay(signals)
    expect(deduped).toEqual([
      { symbol: 'SOXL', at: '2026-06-01T13:05:00.000Z', reason: 'risk: a' },
      { symbol: 'TQQQ', at: '2026-06-01T13:20:00.000Z', reason: 'risk: c' },
      { symbol: 'SOXL', at: '2026-06-02T13:05:00.000Z', reason: 'risk: d' },
    ])
  })
})

describe('computeSkipOutcome', () => {
  const bars: DailyBar[] = [
    bar('2026-06-01', 100),
    bar('2026-06-02', 102, 106, 98),
    bar('2026-06-03', 99, 101, 90),
  ]

  it('見送り後の 10 営業日 MFE/MAE を計算する', () => {
    const outcome = computeSkipOutcome({ symbol: 'SOXL', at: '2026-06-01T13:00:00.000Z', reason: null }, bars)
    expect(outcome.mfe10).toBeCloseTo((106 - 100) / 100)
    expect(outcome.mae10).toBeCloseTo((90 - 100) / 100)
  })

  it('SKIP 日の bar が見つからないときは両方 null', () => {
    const outcome = computeSkipOutcome({ symbol: 'SOXL', at: '2026-07-01T13:00:00.000Z', reason: null }, bars)
    expect(outcome).toEqual({ mfe10: null, mae10: null })
  })
})

describe('avgNonNull', () => {
  it('null を除いた平均と件数を返す', () => {
    expect(avgNonNull([1, null, 3, null])).toEqual({ n: 2, avg: 2 })
  })
  it('全部 null なら n=0 / avg=null', () => {
    expect(avgNonNull([null, null])).toEqual({ n: 0, avg: null })
  })
})

describe('computeDrawdown', () => {
  it('exit 時刻順の累積 realizedPnl から peak→trough の最大下落を計算する', () => {
    const trips: RoundTrip[] = [
      rt('2026-06-01', 10),
      rt('2026-06-02', 5),
      rt('2026-06-03', -8),
      rt('2026-06-04', -6),
      rt('2026-06-05', 20),
    ]
    // 累積: 10, 15, 7, 1, 21 → peak=15 (06-02) → trough=1 (06-04) → DD=14
    const dd = computeDrawdown(trips)
    expect(dd).toEqual({ maxDrawdownUsd: 14, peakUsd: 15, troughUsd: 1 })
  })

  it('realizedPnl が全部 null なら DD=0', () => {
    const trips: RoundTrip[] = [rt('2026-06-01', null)]
    expect(computeDrawdown(trips)).toEqual({ maxDrawdownUsd: 0, peakUsd: 0, troughUsd: 0 })
  })

  function rt(exitDate: string, realizedPnl: number | null): RoundTrip {
    return {
      symbol: 'SOXL',
      entryAt: `${exitDate}T10:00:00.000Z`,
      exitAt: `${exitDate}T14:00:00.000Z`,
      entryPrice: 100,
      exitPrice: 100,
      qty: 1,
      realizedPnl,
      exitClientOrderId: null,
    }
  }
})

describe('computeTurnover', () => {
  it('BUY/SELL notional を集計し、equity があれば ratio を出す', () => {
    const fills: LifecycleFill[] = [
      fill({ side: 'BUY', qty: 2, price: 100 }),
      fill({ side: 'SELL', qty: 2, price: 110 }),
    ]
    const result = computeTurnover(fills, 1000)
    expect(result.buyNotionalUsd).toBe(200)
    expect(result.sellNotionalUsd).toBe(220)
    expect(result.totalNotionalUsd).toBe(420)
    expect(result.turnoverRatio).toBeCloseTo(0.42)
  })

  it('avgEquity が null なら ratio も null', () => {
    const result = computeTurnover([fill({ side: 'BUY', qty: 1, price: 100 })], null)
    expect(result.turnoverRatio).toBeNull()
  })
})

describe('sumEstimatedCost', () => {
  it('estimated_cost の合計を出す (null は無視)', () => {
    const fills: LifecycleFill[] = [
      fill({ estimatedCost: 0.5 }),
      fill({ estimatedCost: null }),
      fill({ estimatedCost: 0.25 }),
    ]
    expect(sumEstimatedCost(fills)).toBeCloseTo(0.75)
  })
})

describe('crossTabSlExitsWithExtendedHours', () => {
  it('symbol + NY 日付で status を突き合わせる', () => {
    // 2026-06-01T13:00:00Z は NY で 2026-06-01 (夏時間 UTC-4)
    const slExits = [
      { symbol: 'SOXL', exitAt: '2026-06-01T13:00:00.000Z' },
      { symbol: 'SOXL', exitAt: '2026-06-01T14:00:00.000Z' },
      { symbol: 'TQQQ', exitAt: '2026-06-01T13:00:00.000Z' },
    ]
    const statusMap = new Map([['SOXL|2026-06-01', 'WARNING']])
    const result = crossTabSlExitsWithExtendedHours(slExits, statusMap)
    expect(result).toEqual({ WARNING: 2, NO_OBSERVATION: 1 })
  })
})

describe('pairRoundTrips input-order robustness (#712 review)', () => {
  it('sorts fills by at per symbol so out-of-order input pairs correctly', () => {
    // SELL 行が入力配列で BUY より先に来ても、at 順に並べ直してペアになる
    const fills: LifecycleFill[] = [
      fill({ side: 'SELL', price: 110, at: '2026-06-05T14:00:00.000Z', realizedPnl: 10 }),
      fill({ side: 'BUY', price: 100, at: '2026-06-01T14:00:00.000Z' }),
    ]
    const trips = pairRoundTrips(fills)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.entryPrice).toBe(100)
    expect(trips[0]!.exitPrice).toBe(110)
  })
})

describe('computeTurnover invalid-value guard (#712 review)', () => {
  it('excludes fills with non-positive or non-finite price/qty', () => {
    const fills: LifecycleFill[] = [
      fill({ side: 'BUY', price: 100, qty: 2 }),
      fill({ side: 'BUY', price: 0, qty: 5 }),
      fill({ side: 'BUY', price: -100, qty: -5 }),
      fill({ side: 'SELL', price: Number.NaN, qty: 1 }),
      fill({ side: 'SELL', price: 110, qty: 0 }),
    ]
    const result = computeTurnover(fills, null)
    expect(result.buyNotionalUsd).toBe(200)
    expect(result.sellNotionalUsd).toBe(0)
    expect(result.totalNotionalUsd).toBe(200)
  })
})
