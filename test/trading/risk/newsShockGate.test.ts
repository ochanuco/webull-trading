import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEWS_SHOCK_CONFIG,
  evaluateNewsShockGate,
  sanitizeNewsShockConfig,
  type NewsShockGateConfig,
  type NewsShockGateInput,
  type NewsShockToneObservation,
  type NewsShockVolumeObservation,
} from '../../../src/trading/risk/newsShockGate'

/**
 * Tests for the news shock gate (issue #196 follow-up, PR 2)。
 *
 * 観点:
 *   - 境界値 (normal / warning / critical) と ratio の `>` 厳密不等号
 *   - tone AND 条件: 満たさなければ critical に昇格しない (warning 止まり)
 *   - stale (maxAgeMin 超過) / minSamples 不足 は fail-open (unknown, sizeScale=1.0)
 *   - `attentionStalePolicy='block_buy'` で unknown が block (sizeScale=0) になる
 *   - config 破損時は default へ倒れる (defensive sanitize)
 *   - この module は fetch を一切呼ばない (pure function — 呼び出しテストは
 *     runStrategyCron.test.ts の回帰ガードで担保)
 */

const ASOF = '2026-04-25T12:00:00.000Z'
const ASOF_MS = Date.parse(ASOF)

/** baseline (7日) 全域に均等分布する 200 点の volume 観測を作る。全点 value=1。 */
function makeBaselineVolumes(count = 200, value = 1): NewsShockVolumeObservation[] {
  const spanMs = 7 * 24 * 60 * 60_000
  const stepMs = spanMs / count
  const out: NewsShockVolumeObservation[] = []
  for (let i = 0; i < count; i++) {
    // 直近 (i=count-1) が asOf ちょうどにならないよう少し手前に置く。window (2h)
    // 用の spike は呼び出し側で別途 asOf ちょうどに追加する。
    out.push({ bucketAt: new Date(ASOF_MS - spanMs + i * stepMs).toISOString(), value })
  }
  return out
}

function withSpike(base: NewsShockVolumeObservation[], spike: number): NewsShockVolumeObservation[] {
  return [...base, { bucketAt: ASOF, value: spike }]
}

describe('evaluateNewsShockGate — happy paths', () => {
  it('returns normal when ratio is at 1.0x (no spike)', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('news_shock_normal: 1.0x')
    expect(decision.ratio).toBe(1)
    expect(decision.asOf).toBe(ASOF)
  })

  it('returns normal exactly at the warn threshold (boundary uses strict >)', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 2.3),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
  })

  it('returns warning between warn (excl.) and block (incl.) thresholds', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 2.8),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
    expect(decision.reason).toBe('news_shock_warning: 2.8x (size x0.5)')
    expect(decision.ratio).toBe(2.8)
  })

  it('returns warning at the block boundary (=== block → still warning)', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 4.4),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('returns critical when ratio exceeds block AND tone dropped enough', () => {
    const tones: NewsShockToneObservation[] = [
      { bucketAt: new Date(ASOF_MS - 24 * 60 * 60_000).toISOString(), value: 0 },
      { bucketAt: new Date(ASOF_MS - 12 * 60 * 60_000).toISOString(), value: 0 },
      { bucketAt: ASOF, value: -2.3 },
    ]
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 5.1),
      toneObservations: tones,
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('critical')
    expect(decision.sizeScale).toBe(0)
    expect(decision.reason).toBe('news_shock_critical: 5.1x tone-2.3 (block)')
    expect(decision.ratio).toBe(5.1)
    expect(decision.toneDrop).toBeCloseTo(2.3, 5)
  })
})

describe('evaluateNewsShockGate — tone AND condition', () => {
  it('does not escalate to critical when tone data is unavailable (requireTone=true default)', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 5.1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
    expect(decision.reason).toBe('news_shock_warning: 5.1x (size x0.5)')
    expect(decision.toneDrop).toBeNull()
  })

  it('does not escalate to critical when tone dropped less than toneDropThreshold', () => {
    const tones: NewsShockToneObservation[] = [
      { bucketAt: new Date(ASOF_MS - 24 * 60 * 60_000).toISOString(), value: 0 },
      { bucketAt: ASOF, value: -0.5 }, // drop = 0.5 < default threshold 1.5
    ]
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 5.1),
      toneObservations: tones,
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('escalates to critical without tone data when requireTone=false', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, requireTone: false }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 5.1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('critical')
    expect(decision.sizeScale).toBe(0)
    expect(decision.reason).toBe('news_shock_critical: 5.1x (block)')
    expect(decision.toneDrop).toBeNull()
  })
})

describe('evaluateNewsShockGate — fail-open (stale / insufficient baseline)', () => {
  it('falls back to unknown/normal when there are no observations at all', () => {
    const input: NewsShockGateInput = { volumeObservations: [], toneObservations: [], asOf: ASOF }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('news_shock_unavailable_fallback_normal')
    expect(decision.ratio).toBeNull()
  })

  it('falls back to unknown/normal when the latest observation is older than maxAgeMin', () => {
    const staleBucket = new Date(ASOF_MS - 200 * 60_000).toISOString() // 200min > default 90min
    const input: NewsShockGateInput = {
      volumeObservations: [{ bucketAt: staleBucket, value: 1 }],
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('news_shock_unavailable_fallback_normal')
  })

  it('reports insufficient_baseline with the actual/expected sample count when below minSamples', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(83), 1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('news_shock_insufficient_baseline: 84/200')
  })

  it('treats a degenerate (zero) baseline median as insufficient/unknown, not a divide-by-zero', () => {
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199, 0), 0),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toMatch(/^news_shock_insufficient_baseline:/)
    expect(Number.isFinite(decision.ratio)).toBe(false)
  })

  it('falls back to unknown when the latest observation passes maxAgeMin but misses the narrower window', () => {
    // windowMin=30 < maxAgeMin(default 90)。observation is 60min old: passes
    // staleness (<=90) but falls outside the 30min window → defensive unknown.
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, windowMin: 30 }
    const input: NewsShockGateInput = {
      volumeObservations: [
        ...makeBaselineVolumes(200),
        { bucketAt: new Date(ASOF_MS - 60 * 60_000).toISOString(), value: 1 },
      ],
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
  })

  it('blocks BUY (sizeScale=0) on unknown when attentionStalePolicy=block_buy', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, attentionStalePolicy: 'block_buy' }
    const input: NewsShockGateInput = { volumeObservations: [], toneObservations: [], asOf: ASOF }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(0)
    expect(decision.reason).toBe('news_shock_unavailable_fallback_normal')
  })

  it('blocks BUY on insufficient_baseline too when attentionStalePolicy=block_buy', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, attentionStalePolicy: 'block_buy' }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(83), 1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(0)
  })
})

describe('evaluateNewsShockGate — defensive config sanitize', () => {
  it('falls back to defaults when warnRatio is NaN', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnRatio: Number.NaN }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 2.8),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('warning') // default warnRatio=2.3 kicks in
  })

  it('falls back to defaults when thresholds are inverted (warn > block)', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnRatio: 10, blockRatio: 2 }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 2.8),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    // defaults (2.3 / 4.4) restored → 2.8x falls in warning band.
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('clamps invalid warnSizeScale to default (0.5)', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: 3 }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(199), 2.8),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.sizeScale).toBe(0.5)
  })

  it('falls back to default minSamples when given a non-positive value', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, minSamples: -5 }
    const input: NewsShockGateInput = {
      volumeObservations: withSpike(makeBaselineVolumes(83), 1),
      toneObservations: [],
      asOf: ASOF,
    }
    const decision = evaluateNewsShockGate(input, config)
    // default minSamples=200 restored → 84 samples still insufficient.
    expect(decision.reason).toBe('news_shock_insufficient_baseline: 84/200')
  })

  it('falls back to default attentionStalePolicy when given an unrecognized value', () => {
    const config = {
      ...DEFAULT_NEWS_SHOCK_CONFIG,
      attentionStalePolicy: 'bogus',
    } as unknown as NewsShockGateConfig
    const input: NewsShockGateInput = { volumeObservations: [], toneObservations: [], asOf: ASOF }
    const decision = evaluateNewsShockGate(input, config)
    // default 'fail_open' restored → sizeScale stays 1.0, not blocked.
    expect(decision.sizeScale).toBe(1.0)
  })
})

/**
 * `sanitizeNewsShockConfig` の直接単体テスト (CodeRabbit PR #619 review)。
 * `runStrategyCron.loadNewsShockDecision` が `sinceIso` を計算する前に
 * この関数を呼んで sanitize 済みの値を使うようになったため、呼び出し側の
 * 契約 (「返り値の各 field は必ず有限/範囲内/順序が正しい」) を独立に保証する。
 * `evaluateNewsShockGate` 経由の間接テストは上の describe 群で既にカバー
 * 済みだが、export された関数そのものの入出力契約はここで直接固定する。
 */
describe('sanitizeNewsShockConfig', () => {
  it('returns the input unchanged when everything is already valid', () => {
    const sane = sanitizeNewsShockConfig(DEFAULT_NEWS_SHOCK_CONFIG)
    expect(sane).toEqual(DEFAULT_NEWS_SHOCK_CONFIG)
  })

  it('replaces NaN baselineDays with the default (the exact regression this test guards)', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, baselineDays: Number.NaN }
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.baselineDays).toBe(DEFAULT_NEWS_SHOCK_CONFIG.baselineDays)
    expect(Number.isFinite(sane.baselineDays)).toBe(true)
    // The whole point: sinceIso computed from this value must not blow up.
    expect(() => new Date(Date.now() - sane.baselineDays * 24 * 60 * 60_000).toISOString()).not.toThrow()
  })

  it('replaces non-finite / non-integer baselineDays variants (Infinity, 0, negative, float) with the default', () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -3, 2.5]) {
      const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, baselineDays: bad }
      const sane = sanitizeNewsShockConfig(config)
      expect(sane.baselineDays).toBe(DEFAULT_NEWS_SHOCK_CONFIG.baselineDays)
    }
  })

  it('replaces a non-number (string from a bad DB write) baselineDays with the default', () => {
    const config = {
      ...DEFAULT_NEWS_SHOCK_CONFIG,
      baselineDays: 'not-a-number' as unknown as number,
    } as NewsShockGateConfig
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.baselineDays).toBe(DEFAULT_NEWS_SHOCK_CONFIG.baselineDays)
  })

  it('resets both warnRatio and blockRatio to defaults when out of range', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnRatio: Number.NaN, blockRatio: -1 }
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.warnRatio).toBe(DEFAULT_NEWS_SHOCK_CONFIG.warnRatio)
    expect(sane.blockRatio).toBe(DEFAULT_NEWS_SHOCK_CONFIG.blockRatio)
  })

  it('resets both warnRatio and blockRatio to defaults when their order is reversed', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnRatio: 10, blockRatio: 2 }
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.warnRatio).toBe(DEFAULT_NEWS_SHOCK_CONFIG.warnRatio)
    expect(sane.blockRatio).toBe(DEFAULT_NEWS_SHOCK_CONFIG.blockRatio)
    expect(sane.warnRatio).toBeLessThanOrEqual(sane.blockRatio)
  })

  it('clamps warnSizeScale outside [0,1] to the default', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: bad }
      const sane = sanitizeNewsShockConfig(config)
      expect(sane.warnSizeScale).toBe(DEFAULT_NEWS_SHOCK_CONFIG.warnSizeScale)
    }
  })

  it('replaces non-positive-integer minSamples/windowMin/maxAgeMin with defaults', () => {
    const config: NewsShockGateConfig = {
      ...DEFAULT_NEWS_SHOCK_CONFIG,
      minSamples: Number.NaN,
      windowMin: -10,
      maxAgeMin: 0,
    }
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.minSamples).toBe(DEFAULT_NEWS_SHOCK_CONFIG.minSamples)
    expect(sane.windowMin).toBe(DEFAULT_NEWS_SHOCK_CONFIG.windowMin)
    expect(sane.maxAgeMin).toBe(DEFAULT_NEWS_SHOCK_CONFIG.maxAgeMin)
  })

  it('replaces an unrecognized attentionStalePolicy with the default', () => {
    const config = {
      ...DEFAULT_NEWS_SHOCK_CONFIG,
      attentionStalePolicy: 'bogus',
    } as unknown as NewsShockGateConfig
    const sane = sanitizeNewsShockConfig(config)
    expect(sane.attentionStalePolicy).toBe(DEFAULT_NEWS_SHOCK_CONFIG.attentionStalePolicy)
  })

  it('is idempotent (sanitizing an already-sanitized config is a no-op)', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, baselineDays: Number.NaN, warnRatio: -5 }
    const once = sanitizeNewsShockConfig(config)
    const twice = sanitizeNewsShockConfig(once)
    expect(twice).toEqual(once)
  })
})
