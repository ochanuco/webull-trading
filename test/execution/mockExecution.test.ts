import { describe, expect, it } from 'vitest'
import { MockExecution } from '../../src/trading/execution/MockExecution'

describe('MockExecution', () => {
  it('returns a dry-run execution result with a mock broker order id', async () => {
    const execution = new MockExecution()

    const result = await execution.execute({
      symbol: 'SOXL',
      side: 'BUY',
      quantity: 2,
      price: 10,
      notional: 20,
    })

    expect(result.mode).toBe('DRY_RUN')
    expect(result.submitted).toBe(true)
    expect(result.brokerOrderId).toMatch(/^mock-/)
  })
})
