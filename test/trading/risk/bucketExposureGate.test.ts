import { describe, expect, it } from 'vitest'
import { decideBucketGate } from '../../../src/trading/risk/bucketExposureGate'

describe('decideBucketGate', () => {
  it('allows when bucket tag is undefined (unclassified symbol)', () => {
    const r = decideBucketGate({ bucket: undefined, currentExposure: 999, addNotional: 1000, cap: 500 })
    expect(r.allowed).toBe(true)
  })

  it('allows when cap is undefined (bucket 未管理扱い)', () => {
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: 100, cap: undefined }).allowed).toBe(true)
  })

  it('rejects fail-closed when cap is invalid (<=0 / non-finite)', () => {
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: 100, cap: 0 }).allowed).toBe(false)
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: 100, cap: -5 }).allowed).toBe(false)
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: 100, cap: Number.NaN }).allowed).toBe(false)
  })

  it('rejects fail-closed when addNotional is invalid', () => {
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: 0, cap: 500 }).allowed).toBe(false)
    expect(decideBucketGate({ bucket: 'semi', currentExposure: 1000, addNotional: -100, cap: 500 }).allowed).toBe(false)
  })

  it('allows when projected total stays at or under cap', () => {
    const r = decideBucketGate({ bucket: 'semi', currentExposure: 400, addNotional: 100, cap: 500 })
    expect(r.allowed).toBe(true)
    expect(r.newExposure).toBe(500)
  })

  it('rejects when projected total exceeds cap', () => {
    const r = decideBucketGate({ bucket: 'semi', currentExposure: 400, addNotional: 200, cap: 500 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/bucket cap: semi/)
  })


  it('returns fresh newExposure so caller can chain decisions', () => {
    const first = decideBucketGate({ bucket: 'semi', currentExposure: 0, addNotional: 200, cap: 500 })
    expect(first.newExposure).toBe(200)
    const second = decideBucketGate({ bucket: 'semi', currentExposure: first.newExposure!, addNotional: 200, cap: 500 })
    expect(second.newExposure).toBe(400)
    const third = decideBucketGate({ bucket: 'semi', currentExposure: second.newExposure!, addNotional: 200, cap: 500 })
    expect(third.allowed).toBe(false) // 400 + 200 > 500
  })
})
