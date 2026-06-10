import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/infrastructure/db/symbolConfigRepo', async () => {
  const actual = await vi.importActual<typeof import('../../../src/infrastructure/db/symbolConfigRepo')>(
    '../../../src/infrastructure/db/symbolConfigRepo',
  )
  return { ...actual, deactivateSymbolForBrokerDeny: vi.fn() }
})
vi.mock('../../../src/infrastructure/db/configAuditLog', () => ({
  recordChange: vi.fn(async () => ({ recorded: true })),
}))

import { createTickerDenyGuard } from '../../../src/trading/risk/tickerDenyGuard'
import { deactivateSymbolForBrokerDeny } from '../../../src/infrastructure/db/symbolConfigRepo'
import { recordChange } from '../../../src/infrastructure/db/configAuditLog'

const fakeRow = (over: Record<string, unknown> = {}) => ({
  symbol: 'USMV',
  active: true,
  notes: null,
  ...over,
})

function makeDeps() {
  const notify = vi.fn(async () => undefined)
  return {
    deps: {
      db: {} as never,
      rawDb: {} as never,
      notifier: { notify },
      requestId: 'req-1',
      now: () => new Date('2026-06-11T00:00:00.000Z'),
    },
    notify,
  }
}

describe('createTickerDenyGuard (#460)', () => {
  beforeEach(() => {
    vi.mocked(deactivateSymbolForBrokerDeny).mockReset()
    vi.mocked(recordChange).mockClear()
  })

  it('deactivates the symbol, records audit (actor=cron) and notifies once', async () => {
    vi.mocked(deactivateSymbolForBrokerDeny).mockResolvedValue({
      before: fakeRow() as never,
      after: fakeRow({ active: false, notes: 'auto' }) as never,
    })
    const { deps, notify } = makeDeps()
    await createTickerDenyGuard(deps as never)('usmv')

    expect(deactivateSymbolForBrokerDeny).toHaveBeenCalledWith(
      deps.db,
      'USMV',
      expect.stringContaining('TICKER_IS_DENY'),
      '2026-06-11T00:00:00.000Z',
    )
    expect(recordChange).toHaveBeenCalledWith(
      deps.rawDb,
      expect.objectContaining({
        actor: 'cron:ticker-deny-guard',
        targetKey: 'symbol_config:USMV',
        requestId: 'req-1',
      }),
    )
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STATE_CHANGE', severity: 'warning', from: true, to: false }),
    )
  })

  it('is idempotent: already-inactive symbol → no audit, no notification', async () => {
    vi.mocked(deactivateSymbolForBrokerDeny).mockResolvedValue(null)
    const { deps, notify } = makeDeps()
    await createTickerDenyGuard(deps as never)('USMV')
    expect(recordChange).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('swallows its own failures (cron 本体を巻き込まない)', async () => {
    vi.mocked(deactivateSymbolForBrokerDeny).mockRejectedValue(new Error('D1 down'))
    const { deps } = makeDeps()
    await expect(createTickerDenyGuard(deps as never)('USMV')).resolves.toBeUndefined()
  })

  it('audit failure does not block the notification (best-effort 並走)', async () => {
    vi.mocked(deactivateSymbolForBrokerDeny).mockResolvedValue({
      before: fakeRow() as never,
      after: fakeRow({ active: false }) as never,
    })
    vi.mocked(recordChange).mockRejectedValue(new Error('audit table missing'))
    const { deps, notify } = makeDeps()
    await createTickerDenyGuard(deps as never)('USMV')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
