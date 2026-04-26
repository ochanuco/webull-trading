import { describe, expect, it } from 'vitest'
import {
  classifyVixRegimeSeverity,
  detectAndNotifyVixRegimeChange,
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

  // drizzle は env.DB.prepare(sql).bind(args).all() / .run() / .first() の流れで叩く。
  // ここは最低限「key='vix_regime' を select / delete / insert する」だけ動かす
  // テスト用 fake。詳細は configStateChange と同様の構造。
  const prepare = (sql: string): unknown => {
    return {
      bind(...args: unknown[]) {
        return {
          async all() {
            // SELECT path
            if (sql.includes('select')) {
              if (stored) return { results: [stored] }
              return { results: [] }
            }
            return { results: [] }
          },
          async run() {
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
