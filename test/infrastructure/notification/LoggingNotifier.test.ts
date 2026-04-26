import { describe, expect, it, vi } from 'vitest'
import {
  LoggingNotifier,
  pickSeverity,
} from '../../../src/infrastructure/notification/LoggingNotifier'
import type {
  Notifier,
  NotificationEvent,
} from '../../../src/infrastructure/notification/Notifier'

/**
 * D1 binding を最小限 mock する: drizzle-orm の `insert(...).values(...)` を
 * 通すだけで良い。createDb → drizzle(d1) は drizzle-orm/d1 が呼ぶので、
 * ここでは prepare → first/all を呼ばない経路 (insert のみ) をスタブする。
 */
function fakeD1(opts: { onInsert?: () => void; throwOnInsert?: Error } = {}): D1Database {
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} as never }),
    run: async () => {
      if (opts.throwOnInsert) throw opts.throwOnInsert
      opts.onInsert?.()
      return { success: true, meta: {} as never }
    },
    raw: async () => [],
  }
  const db = {
    prepare: () => stmt,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 } as never),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database
  return db
}

function fakeInner(): { notifier: Notifier; calls: NotificationEvent[] } {
  const calls: NotificationEvent[] = []
  return {
    notifier: {
      async notify(event) {
        calls.push(event)
      },
    },
    calls,
  }
}

describe('LoggingNotifier', () => {
  it('forwards event to inner Notifier and INSERTs into D1', async () => {
    const inner = fakeInner()
    let inserted = false
    const db = fakeD1({ onInsert: () => (inserted = true) })
    const lg = new LoggingNotifier({
      inner: inner.notifier,
      db,
      formatMessage: () => 'fmt',
    })

    await lg.notify({
      type: 'TRADE',
      side: 'BUY',
      symbol: 'AAPL',
      qty: 1,
      price: 100,
      mode: 'DRY_RUN',
    })

    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0]?.type).toBe('TRADE')
    expect(inserted).toBe(true)
  })

  it('still resolves when inner Notifier throws (silent fallback)', async () => {
    const innerThrowing: Notifier = {
      async notify() {
        throw new Error('webhook down')
      },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeD1()
    const lg = new LoggingNotifier({
      inner: innerThrowing,
      db,
      formatMessage: () => 'fmt',
    })

    await expect(
      lg.notify({ type: 'ERROR', message: 'x', severity: 'critical' }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still resolves when D1 INSERT throws (silent fallback)', async () => {
    const inner = fakeInner()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeD1({ throwOnInsert: new Error('D1 timeout') })
    const lg = new LoggingNotifier({
      inner: inner.notifier,
      db,
      formatMessage: () => 'fmt',
    })

    await expect(
      lg.notify({ type: 'ERROR', message: 'x', severity: 'warning' }),
    ).resolves.toBeUndefined()
    // 内部で warn が出る (DB 失敗の log)
    expect(warnSpy).toHaveBeenCalled()
    // inner notifier は呼ばれている
    expect(inner.calls).toHaveLength(1)
    warnSpy.mockRestore()
  })
})

describe('pickSeverity', () => {
  it('maps TRADE → info', () => {
    expect(
      pickSeverity({
        type: 'TRADE',
        side: 'BUY',
        symbol: 'X',
        qty: 1,
        price: 1,
        mode: 'DRY_RUN',
      }),
    ).toBe('info')
  })
  it('takes ERROR.severity, defaulting to warning', () => {
    expect(pickSeverity({ type: 'ERROR', message: 'm' })).toBe('warning')
    expect(pickSeverity({ type: 'ERROR', message: 'm', severity: 'critical' })).toBe('critical')
  })
  it('takes STATE_CHANGE.severity', () => {
    expect(
      pickSeverity({
        type: 'STATE_CHANGE',
        field: 'dryRun',
        from: true,
        to: false,
        severity: 'critical',
      }),
    ).toBe('critical')
  })
})
