import { describe, expect, it, vi } from 'vitest'
import {
  atomicallyUpdateVixRegimeSnapshot,
  classifyVixRegimeSeverity,
  detectAndNotifyVixRegimeChange,
  loadVixRegimeSnapshot,
  persistVixRegimeSnapshot,
} from '../../../src/infrastructure/notification/vixRegimeChange'
import type {
  Notifier,
  NotificationEvent,
} from '../../../src/infrastructure/notification/Notifier'
import type { VixRegimeFilterDecision } from '../../../src/trading/risk/vixRegimeFilter'

// Tests for VIX regime change detection (#196 3/3).

describe('classifyVixRegimeSeverity', () => {
  it('first observation (from=null) is info', () => {
    expect(classifyVixRegimeSeverity(null, 'warning')).toBe('info')
    expect(classifyVixRegimeSeverity(null, 'critical')).toBe('info')
    expect(classifyVixRegimeSeverity(null, 'normal')).toBe('info')
  })
  it('normal → warning is warning', () => {
    expect(classifyVixRegimeSeverity('normal', 'warning')).toBe('warning')
  })
  it('normal → critical is critical', () => {
    expect(classifyVixRegimeSeverity('normal', 'critical')).toBe('critical')
  })
  it('warning → critical is critical (escalation)', () => {
    expect(classifyVixRegimeSeverity('warning', 'critical')).toBe('critical')
  })
  it('warning → normal is info (relief)', () => {
    expect(classifyVixRegimeSeverity('warning', 'normal')).toBe('info')
  })
  it('critical → warning is info', () => {
    expect(classifyVixRegimeSeverity('critical', 'warning')).toBe('info')
  })
  it('critical → normal is info', () => {
    expect(classifyVixRegimeSeverity('critical', 'normal')).toBe('info')
  })
})

// Minimal spy driving drizzle's select/delete/insert against a single
// `config_state_snapshot` row. `corruptInitial: true` injects a row whose
// value fails to parse (self-heal test fixture, CodeRabbit #216 5th).
function fakeDb(
  initialRegime: string | null,
  options: { corruptInitial?: boolean } = {},
): {
  db: D1Database
  inserts: Array<{ key: string; value: string }>
  getStored: () => { key: string; value: string } | null
} {
  let stored: { key: string; value: string } | null = options.corruptInitial
    ? { key: 'vix_regime', value: '@@not-json@@' }
    : initialRegime !== null
      ? { key: 'vix_regime', value: JSON.stringify(initialRegime) }
      : null
  const inserts: Array<{ key: string; value: string }> = []

  // drizzle's `select({ value: ... })` field form goes through `.raw()`
  // (array result), not `.all()`, so both must be stubbed. SQL is lowercased
  // before matching since callers mix raw uppercase prepare() calls
  // (atomicallyUpdateVixRegimeSnapshot) with drizzle-generated lowercase SQL.
  const prepare = (sqlOriginal: string): unknown => {
    const sql = sqlOriginal.toLowerCase()
    return {
      bind(...args: unknown[]) {
        return {
          async all() {
            if (sql.includes('select')) {
              if (stored) return { results: [stored] }
              return { results: [] }
            }
            return { results: [] }
          },
          async raw() {
            if (sql.includes('select')) {
              if (stored) return [[stored.value]]
              return []
            }
            return []
          },
          async run() {
            if (sql.startsWith('insert or ignore')) {
              if (stored) return { meta: { changes: 0 } }
              const key = String(args[0])
              const value = String(args[1])
              stored = { key, value }
              inserts.push({ key, value })
              return { meta: { changes: 1 } }
            }
            if (sql.includes('update')) {
              // Branches on bind count: 5 args = CAS update (WHERE key=? AND
              // value=?, #216 4th); 4 args = self-heal update (WHERE key=? only, #216 5th).
              const newValue = String(args[0])
              const expectedKey = String(args[3])
              if (args.length >= 5) {
                const expectedOldValue = String(args[4])
                if (
                  stored &&
                  stored.key === expectedKey &&
                  stored.value === expectedOldValue
                ) {
                  stored = { key: expectedKey, value: newValue }
                  inserts.push({ key: expectedKey, value: newValue })
                  return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
              }
              if (stored && stored.key === expectedKey) {
                stored = { key: expectedKey, value: newValue }
                inserts.push({ key: expectedKey, value: newValue })
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 0 } }
            }
            if (sql.includes('delete')) {
              stored = null
              return { meta: { changes: 1 } }
            }
            if (sql.includes('insert')) {
              const key = String(args[0])
              const value = String(args[1])
              stored = { key, value }
              inserts.push({ key, value })
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          },
          async first() {
            if (sql.includes('select')) {
              return stored
            }
            return stored
          },
        }
      },
    }
  }

  const db = {
    prepare,
    async batch(_stmts: unknown[]) {
      return []
    },
  } as unknown as D1Database
  return { db, inserts, getStored: () => stored }
}

function makeNotifier(): { notifier: Notifier; calls: NotificationEvent[] } {
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

function decision(
  regime: 'normal' | 'warning' | 'critical',
  vix: number | null = null,
): VixRegimeFilterDecision {
  return {
    regime,
    sizeScale: regime === 'critical' ? 0 : regime === 'warning' ? 0.5 : 1.0,
    reason:
      regime === 'critical'
        ? `vix_critical: ${vix ?? '?'} (block)`
        : regime === 'warning'
          ? `vix_warning: ${vix ?? '?'} (size x0.5)`
          : `vix_normal: ${vix ?? '?'}`,
    vix,
  }
}

describe('detectAndNotifyVixRegimeChange — dedup / first-run', () => {
  it('does not emit on first observation (no previous snapshot)', async () => {
    // Only the db:undefined noop path is unit-tested here: faking drizzle's
    // internal SQL well enough for a full D1 round trip would be brittle;
    // that path is left to a wrangler-dev integration test (POC scope trade-off).
    const { notifier, calls } = makeNotifier()
    const result = await detectAndNotifyVixRegimeChange({
      db: undefined,
      notifier,
      current: decision('warning', 27.3),
    })
    expect(calls).toHaveLength(0)
    expect(result.emitted).toBe(false)
    expect(result.from).toBeNull()
    expect(result.to).toBe('warning')
  })
})

// D1 fake whose prepare() always throws, so select/delete/insert all die at
// the prepare phase — used to check load/persist failure warn logs carry requestId.
function brokenDb(): D1Database {
  return {
    prepare(_sql: string) {
      throw new Error('boom: db unavailable')
    },
    async batch() {
      return []
    },
  } as unknown as D1Database
}

describe('loadVixRegimeSnapshot — failure logging', () => {
  it('logs warn with requestId when snapshot load throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await loadVixRegimeSnapshot(brokenDb(), 'req-abc-123')
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('vix_regime_snapshot_load_failed')
    expect(logged.requestId).toBe('req-abc-123')
    expect(logged.message).toMatch(/boom/)
    warnSpy.mockRestore()
  })

  it('logs requestId=null when not provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await loadVixRegimeSnapshot(brokenDb())
    expect(result).toBeNull()
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.requestId).toBeNull()
    warnSpy.mockRestore()
  })
})

describe('persistVixRegimeSnapshot — failure logging', () => {
  it('logs warn with requestId when persist throws (fail-silent)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await persistVixRegimeSnapshot(brokenDb(), 'warning', 'req-xyz-456', new Date())
    expect(warnSpy).toHaveBeenCalled()
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('vix_regime_snapshot_persist_failed')
    expect(logged.requestId).toBe('req-xyz-456')
    warnSpy.mockRestore()
  })
})

describe('detectAndNotifyVixRegimeChange — sync throw from notify', () => {
  it('still persists snapshot when notify() throws synchronously', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, inserts } = fakeDb('normal')
    // A synchronously-throwing notifier — a bare .catch() on the call wouldn't reach this.
    const throwingNotifier: Notifier = {
      notify(_event) {
        throw new Error('boom: sync notify failure')
      },
    }
    const result = await detectAndNotifyVixRegimeChange({
      db,
      notifier: throwingNotifier,
      current: decision('warning', 27.3),
      requestId: 'req-sync-throw',
    })
    expect(result.from).toBe('normal')
    expect(result.to).toBe('warning')
    expect(result.emitted).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.key).toBe('vix_regime')
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
    const failedLogs = warnSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && entry.event === 'vix_regime_change_notify_failed',
      )
    expect(failedLogs.length).toBeGreaterThanOrEqual(1)
    expect(failedLogs[0]!.requestId).toBe('req-sync-throw')
    warnSpy.mockRestore()
  })

  it('still persists snapshot when notify() rejects asynchronously', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, inserts } = fakeDb('normal')
    const rejectingNotifier: Notifier = {
      async notify(_event) {
        throw new Error('boom: async notify rejection')
      },
    }
    const result = await detectAndNotifyVixRegimeChange({
      db,
      notifier: rejectingNotifier,
      current: decision('critical', 32.1),
      requestId: 'req-async-reject',
    })
    expect(result.emitted).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('critical'))
    warnSpy.mockRestore()
  })
})

describe('atomicallyUpdateVixRegimeSnapshot — CAS race safety (CodeRabbit #216 4th)', () => {
  it('returns updated=false when the regime did not change (no-op)', async () => {
    const { db, inserts } = fakeDb('warning')
    const result = await atomicallyUpdateVixRegimeSnapshot(
      db,
      'warning',
      new Date('2026-04-25T00:00:00.000Z'),
      'req-noop',
    )
    expect(result.previous).toBe('warning')
    expect(result.updated).toBe(false)
    expect(inserts).toHaveLength(0)
  })

  it('returns updated=true with previous=null on first observation', async () => {
    const { db, inserts } = fakeDb(null)
    const result = await atomicallyUpdateVixRegimeSnapshot(
      db,
      'warning',
      new Date('2026-04-25T00:00:00.000Z'),
      'req-first',
    )
    expect(result.previous).toBeNull()
    expect(result.updated).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
  })

  it('only one of two parallel callers wins CAS for the same next regime; the loser reads back the value the winner just wrote', async () => {
    const { db, inserts } = fakeDb('normal')
    const [a, b] = await Promise.all([
      atomicallyUpdateVixRegimeSnapshot(db, 'critical', new Date(), 'req-a'),
      atomicallyUpdateVixRegimeSnapshot(db, 'critical', new Date(), 'req-b'),
    ])
    const updates = [a.updated, b.updated]
    expect(updates.filter((u) => u === true)).toHaveLength(1)
    expect(updates.filter((u) => u === false)).toHaveLength(1)
    const loser = a.updated ? b : a
    const winner = a.updated ? a : b
    expect(winner.previous).toBe('normal')
    expect(loser.previous).toBe('critical')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('critical'))
  })

  it('self-heals a corrupted snapshot row by overwriting with next (previous=null, so the caller skips notify) (CodeRabbit #216 5th)', async () => {
    const { db, inserts, getStored } = fakeDb(null, { corruptInitial: true })
    const result = await atomicallyUpdateVixRegimeSnapshot(
      db,
      'warning',
      new Date('2026-04-25T00:00:00.000Z'),
      'req-self-heal',
    )
    expect(result.previous).toBeNull()
    expect(result.updated).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
    expect(getStored()?.value).toBe(JSON.stringify('warning'))
  })

  it('after self-heal, the next tick performs a normal compare-and-update (CodeRabbit #216 5th)', async () => {
    const { db, inserts, getStored } = fakeDb(null, { corruptInitial: true })
    const first = await atomicallyUpdateVixRegimeSnapshot(
      db,
      'warning',
      new Date('2026-04-25T00:00:00.000Z'),
      'req-heal',
    )
    expect(first.previous).toBeNull()
    expect(first.updated).toBe(true)
    expect(getStored()?.value).toBe(JSON.stringify('warning'))

    const second = await atomicallyUpdateVixRegimeSnapshot(
      db,
      'critical',
      new Date('2026-04-25T00:01:00.000Z'),
      'req-next',
    )
    expect(second.previous).toBe('warning')
    expect(second.updated).toBe(true)
    expect(getStored()?.value).toBe(JSON.stringify('critical'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
    expect(inserts[1]!.value).toBe(JSON.stringify('critical'))
  })

  it('detectAndNotifyVixRegimeChange dedups parallel callers via CAS', async () => {
    const { db } = fakeDb('normal')
    const { notifier, calls } = makeNotifier()
    const [a, b] = await Promise.all([
      detectAndNotifyVixRegimeChange({
        db,
        notifier,
        current: decision('critical', 35.1),
        requestId: 'req-a',
      }),
      detectAndNotifyVixRegimeChange({
        db,
        notifier,
        current: decision('critical', 35.1),
        requestId: 'req-b',
      }),
    ])
    const emitted = [a.emitted, b.emitted]
    expect(emitted.filter((e) => e === true)).toHaveLength(1)
    expect(emitted.filter((e) => e === false)).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type).toBe('STATE_CHANGE')
    if (calls[0]!.type === 'STATE_CHANGE') {
      expect(calls[0]!.from).toBe('normal')
      expect(calls[0]!.to).toBe('critical')
    }
  })
})
