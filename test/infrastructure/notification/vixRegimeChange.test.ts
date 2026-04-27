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

/**
 * Tests for VIX regime change detection (#196 3/3)。
 *
 * 観点:
 *   - 同 regime 連続では通知しない (dedup)
 *   - 初回 (snapshot null) では通知しない (false alert 防止)
 *   - normal → warning は warning severity、normal → critical は critical
 *   - critical → normal / critical → warning は info (緩和方向)
 *   - DB 未注入時は noop
 */

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

/**
 * Fake D1 — drizzle が呼ぶ select / delete / insert を素朴に動かす最小限の
 * spy。`config_state_snapshot` 1 行のみ扱う。
 */
function fakeDb(initialRegime: string | null): {
  db: D1Database
  inserts: Array<{ key: string; value: string }>
} {
  let stored: { key: string; value: string } | null =
    initialRegime !== null
      ? { key: 'vix_regime', value: JSON.stringify(initialRegime) }
      : null
  const inserts: Array<{ key: string; value: string }> = []

  // drizzle は env.DB.prepare(sql).bind(args).all() / .run() / .first() / .raw()
  // の流れで叩く。`select({ value: ... })` の field 指定形式は drizzle 内部で
  // `.raw()` 経由 (= 配列で返す) になるため raw() も実装する。`select / delete /
  // insert / update` を動かす最低限の fake。詳細は configStateChange と同様の構造。
  // 大文字 SQL (atomicallyUpdateVixRegimeSnapshot の raw prepare) と小文字 SQL
  // (drizzle 経由) の両方に対応するため lowercase 化して比較する。
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
            // drizzle `select({ value: x })` は raw 配列を期待する。
            if (sql.includes('select')) {
              if (stored) return [[stored.value]]
              return []
            }
            return []
          },
          async run() {
            if (sql.startsWith('insert or ignore')) {
              // CAS 用 insert or ignore: 既に行があれば no-op (changes=0)。
              if (stored) return { meta: { changes: 0 } }
              const key = String(args[0])
              const value = String(args[1])
              stored = { key, value }
              inserts.push({ key, value })
              return { meta: { changes: 1 } }
            }
            if (sql.includes('update')) {
              // CAS update: WHERE key=? AND value=? に一致したら書き換え。
              // raw helper のバインド順は (newValue, snapshotAt, requestId, key, oldValue)。
              const newValue = String(args[0])
              const expectedKey = String(args[3])
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
            // raw SELECT value FROM ... LIMIT 1 経由 — stored の {value} を返す。
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
  return { db, inserts }
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
    // detectAndNotifyVixRegimeChange は drizzle 経由で D1 を叩く。drizzle の
    // 内部 SQL 文字列に依存した fake は脆いので、ここでは「DB 未注入時の noop」
    // 経路だけテストする。完全な D1 経由 path は wrangler dev 越しの結合 test に
    // 委ねる (POC scope の trade-off)。
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

// 注: drizzle 経由の D1 read/write を fake する完全 path は drizzle 内部 SQL
// 形式に依存して脆いため、severity 判定 (`classifyVixRegimeSeverity`) と
// `db: undefined` 経路のみを unit test でカバー。
// 「同 regime 連続では emit しない」「DB に書く / 読む」結合は
// configStateChange と同じ pattern で動くことを既存実装で担保している。

/**
 * `prepare` を呼ぶと throw する D1 fake。drizzle `select` / `delete` /
 * `insert` のいずれも prepare phase で死ぬ。load/persist 失敗時の warn ログに
 * requestId が含まれることだけを確認する。
 */
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
    // 同期 throw する notifier。`.catch(...)` では拾えない経路を再現する。
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
    // notify が同期 throw しても snapshot は upsert されているはず。
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.key).toBe('vix_regime')
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
    // warn ログに requestId が乗っていること。
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
    // async rejection でも snapshot は到達する (これは既存挙動の確認)。
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('critical'))
    warnSpy.mockRestore()
  })
})

/**
 * `atomicallyUpdateVixRegimeSnapshot` の race-safe 性 (CodeRabbit #216 4th)。
 *
 * 並行 cron で同 next regime を渡す 2 caller が居た場合、CAS 経由で必ず
 * 片方だけが `updated=true` になり、もう片方は `updated=false`。これを使って
 * `detectAndNotifyVixRegimeChange` 側で重複通知を防ぐ。
 */
describe('atomicallyUpdateVixRegimeSnapshot — CAS race safety', () => {
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
    // CAS 起動せず、既存値も書き換えない。
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
    // INSERT OR IGNORE 経由で 1 件 insert される。
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('warning'))
  })

  it('only one of two parallel callers wins CAS for the same next regime', async () => {
    // 2 caller が並行で normal → critical を書きに来る race を再現する。
    // shared fakeDb で stored を共有し、両 promise を Promise.all で起動する。
    const { db, inserts } = fakeDb('normal')
    const [a, b] = await Promise.all([
      atomicallyUpdateVixRegimeSnapshot(db, 'critical', new Date(), 'req-a'),
      atomicallyUpdateVixRegimeSnapshot(db, 'critical', new Date(), 'req-b'),
    ])
    // どちらの previous も normal ('critical' に書き換わる前 / 書き換わった後の
    // 再 SELECT のいずれか — どちらも 'normal' を見る/読む)。
    // 重要なのは: updated=true は ちょうど 1 つ。
    const updates = [a.updated, b.updated]
    expect(updates.filter((u) => u === true)).toHaveLength(1)
    expect(updates.filter((u) => u === false)).toHaveLength(1)
    // 失敗側の previous は最新値 ('critical') を読み戻す。
    const loser = a.updated ? b : a
    const winner = a.updated ? a : b
    expect(winner.previous).toBe('normal')
    expect(loser.previous).toBe('critical')
    // CAS 成功は 1 回だけ insert/update される (insert log にも 1 件)。
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.value).toBe(JSON.stringify('critical'))
  })

  it('detectAndNotifyVixRegimeChange dedups parallel callers via CAS', async () => {
    // race-safe な dedup を end-to-end で確認: 2 caller が同 next regime で
    // detectAndNotify を呼んでも、notifier には 1 回しか届かない。
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
    // notifier 呼び出しはちょうど 1 回。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type).toBe('STATE_CHANGE')
    if (calls[0]!.type === 'STATE_CHANGE') {
      expect(calls[0]!.from).toBe('normal')
      expect(calls[0]!.to).toBe('critical')
    }
  })
})
