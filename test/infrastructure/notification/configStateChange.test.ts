import { describe, expect, it, vi } from 'vitest'
import {
  classifySeverity,
  diffConfigState,
  notifyConfigStateChanges,
  type WatchedConfig,
} from '../../../src/infrastructure/notification/configStateChange'
import type {
  Notifier,
  NotificationEvent,
} from '../../../src/infrastructure/notification/Notifier'

const baseCurrent: WatchedConfig = {
  dryRun: true,
  tradingEnabled: false,
  marketHoursCheck: false,
  drawdownKillThreshold: -0.02,
}

describe('classifySeverity', () => {
  it('dry_run true → false is critical', () => {
    expect(classifySeverity('dryRun', true, false)).toBe('critical')
  })
  it('dry_run false → true is info', () => {
    expect(classifySeverity('dryRun', false, true)).toBe('info')
  })
  it('trading_enabled false → true is critical', () => {
    expect(classifySeverity('tradingEnabled', false, true)).toBe('critical')
  })
  it('trading_enabled true → false is info', () => {
    expect(classifySeverity('tradingEnabled', true, false)).toBe('info')
  })
  it('drawdown_kill_threshold loosening (closer to 0) is critical', () => {
    expect(classifySeverity('drawdownKillThreshold', -0.05, -0.02)).toBe('critical')
  })
  it('drawdown_kill_threshold tightening (further from 0) is info', () => {
    expect(classifySeverity('drawdownKillThreshold', -0.02, -0.05)).toBe('info')
  })
})

describe('diffConfigState', () => {
  it('returns empty when no previous snapshots exist (initial run)', () => {
    const changes = diffConfigState(baseCurrent, new Map())
    expect(changes).toEqual([])
  })

  it('returns empty when values match the snapshots', () => {
    const previous = new Map<string, string>([
      ['dryRun', JSON.stringify(true)],
      ['tradingEnabled', JSON.stringify(false)],
      ['marketHoursCheck', JSON.stringify(false)],
      ['drawdownKillThreshold', JSON.stringify(-0.02)],
    ])
    const changes = diffConfigState(baseCurrent, previous)
    expect(changes).toEqual([])
  })

  it('detects dry_run true → false as critical', () => {
    const previous = new Map<string, string>([['dryRun', JSON.stringify(true)]])
    const current: WatchedConfig = { ...baseCurrent, dryRun: false }
    const changes = diffConfigState(current, previous)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      field: 'dryRun',
      from: true,
      to: false,
      severity: 'critical',
    })
  })

  it('detects trading_enabled false → true as critical', () => {
    const previous = new Map<string, string>([['tradingEnabled', JSON.stringify(false)]])
    const current: WatchedConfig = { ...baseCurrent, tradingEnabled: true }
    const changes = diffConfigState(current, previous)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      field: 'tradingEnabled',
      from: false,
      to: true,
      severity: 'critical',
    })
  })

  it('detects multiple changes in one tick', () => {
    const previous = new Map<string, string>([
      ['dryRun', JSON.stringify(true)],
      ['tradingEnabled', JSON.stringify(false)],
    ])
    const current: WatchedConfig = { ...baseCurrent, dryRun: false, tradingEnabled: true }
    const changes = diffConfigState(current, previous)
    expect(changes).toHaveLength(2)
    const fields = changes.map((c) => c.field).sort()
    expect(fields).toEqual(['dryRun', 'tradingEnabled'])
  })
})

describe('notifyConfigStateChanges', () => {
  it('emits one STATE_CHANGE event per detected change', () => {
    const calls: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(event) {
        calls.push(event)
      },
    }
    notifyConfigStateChanges(
      notifier,
      [
        {
          field: 'dryRun',
          from: true,
          to: false,
          severity: 'critical',
        },
      ],
      'req-1',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      type: 'STATE_CHANGE',
      field: 'dryRun',
      from: true,
      to: false,
      severity: 'critical',
      note: 'requestId=req-1',
    })
  })

  it('does not throw when notifier rejects (fire-and-forget)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier: Notifier = {
      async notify() {
        throw new Error('webhook down')
      },
    }
    expect(() =>
      notifyConfigStateChanges(
        notifier,
        [
          {
            field: 'dryRun',
            from: true,
            to: false,
            severity: 'critical',
          },
        ],
        undefined,
      ),
    ).not.toThrow()
    warnSpy.mockRestore()
  })
})
