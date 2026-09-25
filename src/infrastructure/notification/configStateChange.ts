import { eq, inArray } from 'drizzle-orm'
import { configStateSnapshot } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier, NotificationSeverity } from './Notifier'

/**
 * `global_config` の trading 安全性に直結する field (`WATCHED_KEYS`) の前回値
 * を D1 に保存し、cron tick ごとに diff を取って STATE_CHANGE 通知する。
 * fail-silent: D1 read / write が落ちても cron 本体には影響させない。
 */
export interface WatchedConfig {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  sessionWindowGateEnabled: boolean
  drawdownKillThreshold: number
}

const WATCHED_KEYS: ReadonlyArray<keyof WatchedConfig> = [
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

// Falls back to an empty Map (= first-observation) on any load failure, rather than throwing.
async function loadConfigSnapshots(
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

export function diffConfigState(
  current: WatchedConfig,
  previous: Map<string, string>,
): DetectedStateChange[] {
  const changes: DetectedStateChange[] = []
  for (const key of WATCHED_KEYS) {
    const currentValue = current[key]
    const currentJson = JSON.stringify(currentValue)
    const previousJson = previous.get(key)
    if (previousJson === undefined) continue // first observation — not a change
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

/** Severity follows whether the transition moves toward live trading (critical) or away from it (info); a shape mismatch falls back to warning. */
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
    if (from === true && to === false) return 'critical'
    if (from === false && to === true) return 'info'
    return 'warning'
  }
  if (field === 'drawdownKillThreshold') {
    if (typeof from === 'number' && typeof to === 'number') {
      // Moving toward 0 (or positive) makes the kill switch harder to trigger.
      if (to > from) return 'critical'
      if (to < from) return 'info'
    }
    return 'warning'
  }
  return 'warning'
}

async function persistSnapshots(
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

/** Fire-and-forget: does not await `notify()`, only logs on rejection. */
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

/** `db` undefined is a noop, so callers don't need their own guard. */
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
