import { eq, inArray } from 'drizzle-orm'
import { configStateSnapshot } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier, NotificationSeverity } from './Notifier'

/**
 * `global_config` の重要 field の前回値を D1 `config_state_snapshot` に
 * 保存し、cron tick ごとに diff を取って STATE_CHANGE 通知する (#141)。
 *
 * 検知対象は **trading の安全性に直結する** field に絞る:
 *   - `dry_run`            (true → false: 実発注 ON、危険)
 *   - `trading_enabled`    (false → true: 実発注 ON、危険)
 *   - `market_hours_check` (false → true: 取引時間外 reject、運用変更)
 *   - `session_window_gate_enabled` (true → false: 開場前 fence が外れる)
 *   - `drawdown_kill_threshold` (絶対値が緩む方向は危険)
 *
 * 「実発注に近づく方向」の遷移は `severity: critical`、逆方向は `info`。
 * 初回 (snapshot 行なし) は通知を出さず単に snapshot を作る (false alert
 * 防止)。
 *
 * fail-silent: D1 read / write が落ちても cron 本体には影響させない (caller
 * が try/catch する想定 + emit は fire-and-forget)。
 */
export interface WatchedConfig {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  sessionWindowGateEnabled: boolean
  drawdownKillThreshold: number
}

export const WATCHED_KEYS: ReadonlyArray<keyof WatchedConfig> = [
  'dryRun',
  'tradingEnabled',
  'marketHoursCheck',
  'sessionWindowGateEnabled',
  'drawdownKillThreshold',
]

export interface DetectedStateChange {
  field: keyof WatchedConfig
  from: WatchedConfig[keyof WatchedConfig] | null
  to: WatchedConfig[keyof WatchedConfig]
  severity: NotificationSeverity
}

/**
 * D1 から前回 snapshot を読む。table 未 migration 等で落ちても caller を
 * 落とさないよう、空 Map を返して「初回扱い」にフォールバックする。
 */
export async function loadConfigSnapshots(
  db: D1Database,
): Promise<Map<string, string>> {
  try {
    const drizzle = createDb(db)
    const rows = await drizzle
      .select({ key: configStateSnapshot.key, value: configStateSnapshot.value })
      .from(configStateSnapshot)
      .where(inArray(configStateSnapshot.key, [...WATCHED_KEYS]))
    return new Map(rows.map((r) => [r.key, r.value] as const))
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'config_state_snapshot_load_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Map()
  }
}

/**
 * 現在値と前回 snapshot を diff して、変化した field だけ列挙する。前回
 * 値が無い field は「初回」扱いで diff には含めない (false alert 防止)。
 */
export function diffConfigState(
  current: WatchedConfig,
  previous: Map<string, string>,
): DetectedStateChange[] {
  const changes: DetectedStateChange[] = []
  for (const key of WATCHED_KEYS) {
    const currentValue = current[key]
    const currentJson = JSON.stringify(currentValue)
    const previousJson = previous.get(key)
    if (previousJson === undefined) continue // 初回 — 通知しない
    if (previousJson === currentJson) continue
    const previousValue = parseSafe(previousJson)
    changes.push({
      field: key,
      from: previousValue as WatchedConfig[keyof WatchedConfig] | null,
      to: currentValue,
      severity: classifySeverity(key, previousValue, currentValue),
    })
  }
  return changes
}

/**
 * 「実発注に近づく方向」かどうかで severity を決める。基準:
 *   - `dry_run: true → false`        critical
 *   - `trading_enabled: false → true` critical
 *   - `market_hours_check: true → false` critical (時間外 fence が外れる)
 *   - `drawdown_kill_threshold` が緩む (より 0 に近い負値、または 0 以上) critical
 *   - 逆方向 (停止に向かう) は info
 *   - 上記以外の遷移 (型崩れ等) は warning
 */
export function classifySeverity(
  field: keyof WatchedConfig,
  from: unknown,
  to: unknown,
): NotificationSeverity {
  if (field === 'dryRun') {
    if (from === true && to === false) return 'critical'
    if (from === false && to === true) return 'info'
    return 'warning'
  }
  if (field === 'tradingEnabled') {
    if (from === false && to === true) return 'critical'
    if (from === true && to === false) return 'info'
    return 'warning'
  }
  if (field === 'marketHoursCheck') {
    if (from === true && to === false) return 'critical'
    if (from === false && to === true) return 'info'
    return 'warning'
  }
  if (field === 'sessionWindowGateEnabled') {
    // true → false: 開場前 fence が外れ 24h 常時評価に戻る = 緩む方向で critical
    if (from === true && to === false) return 'critical'
    if (from === false && to === true) return 'info'
    return 'warning'
  }
  if (field === 'drawdownKillThreshold') {
    if (typeof from === 'number' && typeof to === 'number') {
      // 閾値が「より 0 に近い / 正方向」へ動くと kill が発動しづらくなる = 危険
      if (to > from) return 'critical'
      if (to < from) return 'info'
    }
    return 'warning'
  }
  return 'warning'
}

/**
 * 現在値で snapshot table を upsert する。caller は `loadConfigSnapshots`
 * → `diffConfigState` → `notifyChanges` → `persistSnapshots` の順で呼ぶ。
 *
 * 失敗は throw しない (caller が握りつぶす)。snapshot 書き込みが落ちても
 * 次 tick で「変わらなかった」誤検知が増えるだけで実害は小さい。
 */
export async function persistSnapshots(
  db: D1Database,
  current: WatchedConfig,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  const drizzle = createDb(db)
  const snapshotAt = now.toISOString()
  // Drizzle has no portable upsert for sqlite without ON CONFLICT — emulate
  // with delete + insert per key. Each key is independent so a single
  // failure doesn't lose the others.
  for (const key of WATCHED_KEYS) {
    const value = JSON.stringify(current[key])
    try {
      await drizzle.delete(configStateSnapshot).where(eq(configStateSnapshot.key, key))
      await drizzle.insert(configStateSnapshot).values({
        key,
        value,
        snapshotAt,
        requestId: requestId ?? null,
      })
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'config_state_snapshot_persist_failed',
          key,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}

/**
 * 検出した change を Notifier に流す helper。fire-and-forget (caller は
 * await 不要) — エラーは内部で log するだけ。
 */
export function notifyConfigStateChanges(
  notifier: Notifier,
  changes: DetectedStateChange[],
  requestId: string | undefined,
): void {
  for (const change of changes) {
    const note = requestId ? `requestId=${requestId}` : undefined
    notifier
      .notify({
        type: 'STATE_CHANGE',
        field: change.field,
        from: change.from,
        to: change.to,
        severity: change.severity,
        ...(note !== undefined ? { note } : {}),
      })
      .catch((err) => {
        console.warn(
          JSON.stringify({
            event: 'config_state_change_notify_failed',
            field: change.field,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      })
  }
}

/**
 * cron tick から呼ばれる top-level helper。
 *
 *   1. snapshot を読む (失敗 → 空 Map)
 *   2. diff を取る (初回 = 空)
 *   3. notifier に diff を流す (fire-and-forget)
 *   4. snapshot を upsert (await する: 次 tick の比較に必要)
 *
 * `env.DB` が無いと state change 検知は成立しないので、caller 側で
 * skip するか、ここで noop fallback する。後者を採用 (caller の if 分岐を
 * 減らす)。
 */
export async function detectAndNotifyConfigStateChanges(args: {
  db: D1Database | undefined
  notifier: Notifier
  current: WatchedConfig
  requestId?: string
  now?: () => Date
}): Promise<DetectedStateChange[]> {
  if (!args.db) return []
  const previous = await loadConfigSnapshots(args.db)
  const changes = diffConfigState(args.current, previous)
  notifyConfigStateChanges(args.notifier, changes, args.requestId)
  const now = (args.now ?? (() => new Date()))()
  await persistSnapshots(args.db, args.current, args.requestId, now)
  return changes
}

function parseSafe(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}
