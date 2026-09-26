import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEWS_SHOCK_CONFIG,
  evaluateNewsShockGate,
  sanitizeNewsShockConfig,
  type NewsShockGateConfig,
  type NewsShockGateInput,
  type NewsShockHeadlineRow,
} from '../../../src/trading/risk/newsShockGate'

// News shock gate (jev source swap): pure function, no fetch — call-site wiring is
// covered separately by runStrategyCron.test.ts's regression guard.

const NOW = new Date('2026-09-27T12:00:00.000Z')

function headlineRow(overrides: Partial<NewsShockHeadlineRow> = {}): NewsShockHeadlineRow {
  return {
    evaluatedAt: NOW.toISOString(),
    status: 'ok',
    shock: 0.1,
    direction: 'risk_on',
    ...overrides,
  }
}

describe('evaluateNewsShockGate — regime thresholds', () => {
  it('returns normal below the warning threshold (0.5)', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.49 }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.shock).toBe(0.49)
  })

  it('returns warning exactly at the 0.5 boundary (inclusive)', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.5, direction: 'mixed' }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('returns warning (not critical) at shock>=0.8 when direction is not risk_off', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.85, direction: 'mixed' }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('returns warning (not critical) at shock>=0.8 with risk_on direction', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.99, direction: 'risk_on' }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('warning')
  })

  it('returns critical exactly at the 0.8 boundary (inclusive) with risk_off', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.8, direction: 'risk_off' }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('critical')
    expect(decision.sizeScale).toBe(0)
    expect(decision.reason).toContain('shock=0.80')
    expect(decision.reason).toContain('direction=risk_off')
    expect(decision.reason).toContain('(block)')
  })

  it('returns critical above 0.8 with risk_off', () => {
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.94, direction: 'risk_off' }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('critical')
    expect(decision.shock).toBe(0.94)
    expect(decision.direction).toBe('risk_off')
  })

  it('uses warnSizeScale from config for the warning regime', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: 0.25 }
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.6 }), now: NOW }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.sizeScale).toBe(0.25)
    expect(decision.reason).toContain('size x0.25')
  })
})

describe('evaluateNewsShockGate — unknown (missing/stale/non-ok data)', () => {
  it('returns unknown when there is no row at all', () => {
    const input: NewsShockGateInput = { row: null, now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.shock).toBeNull()
    expect(decision.direction).toBeNull()
    expect(decision.rowEvaluatedAt).toBeNull()
    expect(decision.reason).toBe('news_shock_unavailable_no_row')
  })

  it('returns unknown when the row is older than 45 minutes (stale, exclusive boundary)', () => {
    const staleAt = new Date(NOW.getTime() - 46 * 60_000).toISOString()
    const input: NewsShockGateInput = { row: headlineRow({ evaluatedAt: staleAt, shock: 0.9 }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.reason).toContain('news_shock_unavailable_stale')
    expect(decision.rowEvaluatedAt).toBe(staleAt)
  })

  it('treats exactly 45 minutes old as still fresh (boundary is exclusive: only strictly older is stale)', () => {
    const at45 = new Date(NOW.getTime() - 45 * 60_000).toISOString()
    const input: NewsShockGateInput = { row: headlineRow({ evaluatedAt: at45, shock: 0.1 }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('normal')
  })

  it('returns unknown when the row status is not ok (e.g. fetch_error)', () => {
    const input: NewsShockGateInput = { row: headlineRow({ status: 'fetch_error', shock: null }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.reason).toBe('news_shock_unavailable_status: fetch_error')
  })

  it('returns unknown when status is ok but shock is null (defensive: malformed row)', () => {
    const input: NewsShockGateInput = { row: headlineRow({ status: 'ok', shock: null }), now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.regime).toBe('unknown')
    expect(decision.reason).toBe('news_shock_unavailable_no_shock')
  })

  it('blocks BUY (sizeScale=0) on unknown when attentionStalePolicy=block_buy', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, attentionStalePolicy: 'block_buy' }
    const input: NewsShockGateInput = { row: null, now: NOW }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.regime).toBe('unknown')
    expect(decision.sizeScale).toBe(0)
  })

  it('keeps sizeScale=1.0 on unknown with the default fail_open policy', () => {
    const input: NewsShockGateInput = { row: null, now: NOW }
    const decision = evaluateNewsShockGate(input, DEFAULT_NEWS_SHOCK_CONFIG)
    expect(decision.sizeScale).toBe(1.0)
  })
})

describe('evaluateNewsShockGate — defensive config sanitize', () => {
  it('clamps invalid warnSizeScale to the default (0.5)', () => {
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: 3 }
    const input: NewsShockGateInput = { row: headlineRow({ shock: 0.6 }), now: NOW }
    const decision = evaluateNewsShockGate(input, config)
    expect(decision.sizeScale).toBe(0.5)
  })

  it('falls back to default attentionStalePolicy when given an unrecognized value', () => {
    const config = {
      ...DEFAULT_NEWS_SHOCK_CONFIG,
      attentionStalePolicy: 'bogus',
    } as unknown as NewsShockGateConfig
    const input: NewsShockGateInput = { row: null, now: NOW }
    const decision = evaluateNewsShockGate(input, config)
    // default 'fail_open' restored → sizeScale stays 1.0, not blocked.
    expect(decision.sizeScale).toBe(1.0)
  })
})

describe('sanitizeNewsShockConfig', () => {
  it('returns the input unchanged when everything is already valid', () => {
    const sane = sanitizeNewsShockConfig(DEFAULT_NEWS_SHOCK_CONFIG)
    expect(sane).toEqual(DEFAULT_NEWS_SHOCK_CONFIG)
  })

  it('clamps warnSizeScale outside [0,1] to the default', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: bad }
      const sane = sanitizeNewsShockConfig(config)
      expect(sane.warnSizeScale).toBe(DEFAULT_NEWS_SHOCK_CONFIG.warnSizeScale)
    }
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
    const config: NewsShockGateConfig = { ...DEFAULT_NEWS_SHOCK_CONFIG, warnSizeScale: -5 }
    const once = sanitizeNewsShockConfig(config)
    const twice = sanitizeNewsShockConfig(once)
    expect(twice).toEqual(once)
  })
})
