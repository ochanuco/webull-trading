import { describe, expect, it } from 'vitest'
import { NoopNotifier } from '../../../src/infrastructure/notification/NoopNotifier'

describe('NoopNotifier', () => {
  it('resolves without doing anything for TRADE events', async () => {
    const n = new NoopNotifier()
    await expect(
      n.notify({ type: 'TRADE', side: 'BUY', symbol: 'AAPL', qty: 1, price: 1, mode: 'DRY_RUN' }),
    ).resolves.toBeUndefined()
  })

  it('resolves without doing anything for ERROR events', async () => {
    const n = new NoopNotifier()
    await expect(n.notify({ type: 'ERROR', message: 'oops' })).resolves.toBeUndefined()
  })
})
