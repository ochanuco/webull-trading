import { describe, expect, it, vi } from 'vitest'
import {
  atomicallyUpdateRegimeSnapshot,
  classifyRegimeSeverity,
  detectAndNotifyRegimeChange,
  loadRegimeSnapshot,
  persistRegimeSnapshot,
} from '../../../src/infrastructure/notification/regimeChange'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'

/**
 * Tests for the generic regime-change module (extracted from
 * `vixRegimeChange.ts`, news-shock-gate PR 2)。
 *
 * `vixRegimeChange.test.ts` covers the VIX-specific wrapper end-to-end
 * (unchanged by this extraction). Here we exercise the generic surface
 * directly with an independent regime domain (`'unknown' | 'normal' | 'warning' | 'critical'`,
 * matching the news-shock gate's regime set) to prove the module is not
 * secretly VIX-shaped.
 *
 * 観点:
 *   - CAS (compare-and-swap) による重複通知防止
 *   - 初回 (snapshot なし) は emit しない
 *   - 同 regime 連続は emit しない (dedup)
 *   - key ごとに独立した warn ログ event 名 (`${key}_snapshot_load_failed` 等)
 */

type Regime = 'unknown' | 'normal' | 'warning' | 'critical'
const RANK: Record<Regime, number> = { unknown: 0, normal: 0, warning: 1, critical: 2 }
function isRegime(value: unknown): value is Regime {
  return value === 'unknown' || value === 'normal' || value === 'warning' || value === 'critical'
}
const KEY = 'news_shock_regime'

/** Fake D1 — vixRegimeChange.test.ts の fakeDb と同構造の最小限 spy。 */
function fakeDb(
  initial: string | null,
  options: { corruptInitial?: boolean } = {},
): {
  db: D1Database
  inserts: Array<{ key: string; value: string }>
  getStored: () => { key: string; value: string } | null
} {
  let stored: { key: string; value: string } | null = options.corruptInitial
    ? { key: KEY, value: '@@not-json@@' }
    : initial !== null
      ? { key: KEY, value: JSON.stringify(initial) }
      : null
  const inserts: Array<{ key: string; value: string }> = []

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
              const newValue = String(args[0])
              const expectedKey = String(args[3])
              if (args.length >= 5) {
                const expectedOldValue = String(args[4])
                if (stored && stored.key === expectedKey && stored.value === expectedOldValue) {
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
            if (sql.includes('select')) return stored
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

describe('classifyRegimeSeverity', () => {
  it('first observation (from=null) is info', () => {
    expect(classifyRegimeSeverity<Regime>(null, 'warning', RANK, 'critical')).toBe('info')
  })
  it('escalation toward the critical regime is critical', () => {
    expect(classifyRegimeSeverity<Regime>('normal', 'critical', RANK, 'critical')).toBe('critical')
    expect(classifyRegimeSeverity<Regime>('warning', 'critical', RANK, 'critical')).toBe('critical')
  })
  it('escalation not reaching critical is warning', () => {
    expect(classifyRegimeSeverity<Regime>('normal', 'warning', RANK, 'critical')).toBe('warning')
  })
  it('relief (rank decreases) is info', () => {
    expect(classifyRegimeSeverity<Regime>('critical', 'warning', RANK, 'critical')).toBe('info')
    expect(classifyRegimeSeverity<Regime>('warning', 'normal', RANK, 'critical')).toBe('info')
  })
  it('same-rank lateral move (unknown <-> normal) is info, not an alert', () => {
    expect(classifyRegimeSeverity<Regime>('unknown', 'normal', RANK, 'critical')).toBe('info')
    expect(classifyRegimeSeverity<Regime>('normal', 'unknown', RANK, 'critical')).toBe('info')
  })
})

describe('loadRegimeSnapshot / persistRegimeSnapshot — failure logging uses the key-derived event name', () => {
  it('logs `${key}_snapshot_load_failed` on load failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await loadRegimeSnapshot(brokenDb(), KEY, isRegime, 'req-1')
    expect(result).toBeNull()
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('news_shock_regime_snapshot_load_failed')
    expect(logged.requestId).toBe('req-1')
    warnSpy.mockRestore()
  })

  it('logs `${key}_snapshot_persist_failed` on persist failure (fail-silent)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await persistRegimeSnapshot(brokenDb(), KEY, 'warning', 'req-2', new Date())
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(logged.event).toBe('news_shock_regime_snapshot_persist_failed')
    warnSpy.mockRestore()
  })
})

describe('atomicallyUpdateRegimeSnapshot — CAS race safety', () => {
  it('returns updated=true with previous=null on first observation', async () => {
    const { db, inserts } = fakeDb(null)
    const result = await atomicallyUpdateRegimeSnapshot(db, KEY, 'warning', new Date(), isRegime, 'req-first')
    expect(result.previous).toBeNull()
    expect(result.updated).toBe(true)
    expect(inserts).toHaveLength(1)
  })

  it('returns updated=false when the regime did not change (no-op)', async () => {
    const { db, inserts } = fakeDb('warning')
    const result = await atomicallyUpdateRegimeSnapshot(db, KEY, 'warning', new Date(), isRegime, 'req-noop')
    expect(result.previous).toBe('warning')
    expect(result.updated).toBe(false)
    expect(inserts).toHaveLength(0)
  })

  it('only one of two parallel callers wins CAS for the same next regime', async () => {
    const { db, inserts } = fakeDb('normal')
    const [a, b] = await Promise.all([
      atomicallyUpdateRegimeSnapshot(db, KEY, 'critical', new Date(), isRegime, 'req-a'),
      atomicallyUpdateRegimeSnapshot(db, KEY, 'critical', new Date(), isRegime, 'req-b'),
    ])
    const updates = [a.updated, b.updated]
    expect(updates.filter((u) => u === true)).toHaveLength(1)
    expect(updates.filter((u) => u === false)).toHaveLength(1)
    expect(inserts).toHaveLength(1)
  })

  it('self-heals a corrupted snapshot row by overwriting with next (no notify)', async () => {
    const { db, inserts, getStored } = fakeDb(null, { corruptInitial: true })
    const result = await atomicallyUpdateRegimeSnapshot(db, KEY, 'warning', new Date(), isRegime, 'req-heal')
    expect(result.previous).toBeNull()
    expect(result.updated).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(getStored()?.value).toBe(JSON.stringify('warning'))
  })
})

describe('detectAndNotifyRegimeChange — dedup / first-run / db-less noop', () => {
  it('does not emit on first observation (no previous snapshot)', async () => {
    const { notifier, calls } = makeNotifier()
    const { db } = fakeDb(null)
    const result = await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier,
      key: KEY,
      current: { regime: 'warning', reason: 'news_shock_warning: 2.8x (size x0.5)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
    })
    expect(calls).toHaveLength(0)
    expect(result.emitted).toBe(false)
    expect(result.from).toBeNull()
  })

  it('is a noop when db is undefined', async () => {
    const { notifier, calls } = makeNotifier()
    const result = await detectAndNotifyRegimeChange<Regime>({
      db: undefined,
      notifier,
      key: KEY,
      current: { regime: 'critical', reason: 'news_shock_critical: 5.1x tone-2.3 (block)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
    })
    expect(calls).toHaveLength(0)
    expect(result.emitted).toBe(false)
    expect(result.to).toBe('critical')
  })

  it('does not emit again for the same regime on the next tick (dedup)', async () => {
    const { notifier, calls } = makeNotifier()
    const { db } = fakeDb('normal')
    const first = await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier,
      key: KEY,
      current: { regime: 'warning', reason: 'news_shock_warning: 2.8x (size x0.5)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
      requestId: 'req-1',
    })
    expect(first.emitted).toBe(true)
    const second = await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier,
      key: KEY,
      current: { regime: 'warning', reason: 'news_shock_warning: 2.8x (size x0.5)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
      requestId: 'req-2',
    })
    expect(second.emitted).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('dedups parallel callers via CAS (only one notifier call)', async () => {
    const { db } = fakeDb('normal')
    const { notifier, calls } = makeNotifier()
    const [a, b] = await Promise.all([
      detectAndNotifyRegimeChange<Regime>({
        db,
        notifier,
        key: KEY,
        current: { regime: 'critical', reason: 'news_shock_critical: 5.1x tone-2.3 (block)' },
        rank: RANK,
        criticalRegime: 'critical',
        isValidRegime: isRegime,
        requestId: 'req-a',
      }),
      detectAndNotifyRegimeChange<Regime>({
        db,
        notifier,
        key: KEY,
        current: { regime: 'critical', reason: 'news_shock_critical: 5.1x tone-2.3 (block)' },
        rank: RANK,
        criticalRegime: 'critical',
        isValidRegime: isRegime,
        requestId: 'req-b',
      }),
    ])
    const emitted = [a.emitted, b.emitted]
    expect(emitted.filter((e) => e === true)).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type).toBe('STATE_CHANGE')
    if (calls[0]!.type === 'STATE_CHANGE') {
      expect(calls[0]!.field).toBe(KEY)
      expect(calls[0]!.from).toBe('normal')
      expect(calls[0]!.to).toBe('critical')
    }
  })

  it('suppresses the notification but still updates the snapshot when shouldNotify returns false', async () => {
    const { notifier, calls } = makeNotifier()
    const { db, getStored } = fakeDb('unknown')
    const result = await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier,
      key: KEY,
      current: { regime: 'normal', reason: 'news_shock_normal: 1.3x' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
      requestId: 'req-suppress',
      // unknown→normal (データ欠測の回復) はアクションが取れないため流さない。
      shouldNotify: (from, to) => !(from === 'unknown' && to === 'normal'),
    })
    expect(calls).toHaveLength(0)
    expect(result.emitted).toBe(false)
    // snapshot は更新済み — 次 tick の normal は「変化なし」として dedup される。
    expect(JSON.parse(getStored()!.value)).toBe('normal')
    expect(result.from).toBe('unknown')
    expect(result.to).toBe('normal')
  })

  it('attaches the caller-built headline to the STATE_CHANGE event', async () => {
    const { notifier, calls } = makeNotifier()
    const { db } = fakeDb('normal')
    await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier,
      key: KEY,
      current: { regime: 'warning', reason: 'news_shock_warning: 2.8x (size x0.5)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
      requestId: 'req-headline',
      headline: (from, to) => `テスト見出し (${from}→${to})`,
    })
    expect(calls).toHaveLength(1)
    if (calls[0]!.type === 'STATE_CHANGE') {
      expect(calls[0]!.headline).toBe('テスト見出し (normal→warning)')
      // headline があれば本文はそれで完結 — requestId / canonical reason の
      // note は付けない (ユーザーフィードバック)。
      expect(calls[0]!.note).toBeUndefined()
    }
  })

  it('still persists snapshot and logs `${key}_change_notify_failed` when notify() throws synchronously', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, inserts } = fakeDb('normal')
    const throwingNotifier: Notifier = {
      notify(_event) {
        throw new Error('boom: sync notify failure')
      },
    }
    const result = await detectAndNotifyRegimeChange<Regime>({
      db,
      notifier: throwingNotifier,
      key: KEY,
      current: { regime: 'warning', reason: 'news_shock_warning: 2.8x (size x0.5)' },
      rank: RANK,
      criticalRegime: 'critical',
      isValidRegime: isRegime,
      requestId: 'req-sync-throw',
    })
    expect(result.emitted).toBe(true)
    expect(inserts).toHaveLength(1)
    const failedLogs = warnSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null && entry.event === 'news_shock_regime_change_notify_failed')
    expect(failedLogs.length).toBeGreaterThanOrEqual(1)
    warnSpy.mockRestore()
  })
})
