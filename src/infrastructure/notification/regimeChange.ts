/**
 * Generic regime-change detection + STATE_CHANGE notification, keyed by a
 * `config_state_snapshot` row per `key` (e.g. `vix_regime`,
 * `news_shock_regime`). CAS-updates the snapshot and only notifies on a
 * diff from the previous tick; fails silently so a D1 outage never breaks
 * the calling cron.
 */
import { eq } from 'drizzle-orm'
import { configStateSnapshot } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier, NotificationSeverity } from './Notifier'

/** Severity is derived from rank order alone: an escalation reaching `criticalRegime` is critical, any other escalation is warning, anything else is info. Callers supply their own domain's rank map. */
export function classifyRegimeSeverity<R extends string>(
  from: R | null,
  to: R,
  rank: Record<R, number>,
  criticalRegime: R,
): NotificationSeverity {
  if (from === null) return 'info'
  const fromRank = rank[from]
  const toRank = rank[to]
  if (toRank > fromRank) {
    return to === criticalRegime ? 'critical' : 'warning'
  }
  return 'info'
}

/** Any load failure (missing table, connection error, invalid stored value) falls back to null, i.e. treated as first observation. */
export async function loadRegimeSnapshot<R extends string>(
  db: D1Database,
  key: string,
  isValidRegime: (value: unknown) => value is R,
  requestId?: string,
): Promise<R | null> {
  try {
    const drizzle = createDb(db)
    const rows = await drizzle
      .select({ value: configStateSnapshot.value })
      .from(configStateSnapshot)
      .where(eq(configStateSnapshot.key, key))
      .limit(1)
    const raw = rows[0]?.value
    if (!raw) return null
    const parsed = parseSafe(raw)
    if (isValidRegime(parsed)) return parsed
    return null
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: `${key}_snapshot_load_failed`,
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/** Never throws: a write failure just leaves the next tick seeing a stale "unchanged" snapshot, which is low-cost. */
export async function persistRegimeSnapshot<R extends string>(
  db: D1Database,
  key: string,
  regime: R,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  const drizzle = createDb(db)
  const snapshotAt = now.toISOString()
  const value = JSON.stringify(regime)
  try {
    // Emulates upsert via delete + insert, matching configStateChange (D1 has no portable upsert).
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
        event: `${key}_snapshot_persist_failed`,
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * CAS (`UPDATE ... WHERE value = old`) update, so concurrent cron ticks
 * racing `load → notify → persist` can't both win and double-notify.
 * `updated` is true only for the caller that actually wrote the row; that
 * caller is the only one that should notify. Fails silently to
 * `{ previous: null, updated: false }` on a D1 error.
 */
export async function atomicallyUpdateRegimeSnapshot<R extends string>(
  db: D1Database,
  key: string,
  next: R,
  now: Date,
  isValidRegime: (value: unknown) => value is R,
  requestId?: string,
): Promise<{ previous: R | null; updated: boolean }> {
  const snapshotAt = now.toISOString()
  const nextJson = JSON.stringify(next)
  try {
    // INSERT OR IGNORE resolves the first-row race: changes>=1 means this caller created it.
    const insertRes = await db
      .prepare(
        'INSERT OR IGNORE INTO config_state_snapshot (key, value, snapshot_at, request_id) VALUES (?, ?, ?, ?)',
      )
      .bind(key, nextJson, snapshotAt, requestId ?? null)
      .run()
    const insertedRows = insertRes?.meta?.changes ?? 0
    if (insertedRows >= 1) {
      return { previous: null, updated: true }
    }

    const current = await readCurrentSnapshotValue(db, key, isValidRegime)
    if (current === null) {
      // Row exists but its value doesn't parse. Without this, a corrupted
      // row would stick on the same branch every tick with no valid CAS
      // basis; overwrite it and treat it like a first observation.
      await db
        .prepare(
          'UPDATE config_state_snapshot SET value = ?, snapshot_at = ?, request_id = ? WHERE key = ?',
        )
        .bind(nextJson, snapshotAt, requestId ?? null, key)
        .run()
      return { previous: null, updated: true }
    }
    if (current === next) {
      return { previous: current, updated: false }
    }

    const updateRes = await db
      .prepare(
        'UPDATE config_state_snapshot SET value = ?, snapshot_at = ?, request_id = ? WHERE key = ? AND value = ?',
      )
      .bind(nextJson, snapshotAt, requestId ?? null, key, JSON.stringify(current))
      .run()
    const changed = updateRes?.meta?.changes ?? 0
    if (changed >= 1) {
      return { previous: current, updated: true }
    }
    // Another caller won the CAS race; re-read the value it wrote.
    const latest = await readCurrentSnapshotValue(db, key, isValidRegime)
    return { previous: latest, updated: false }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: `${key}_snapshot_cas_failed`,
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return { previous: null, updated: false }
  }
}

async function readCurrentSnapshotValue<R extends string>(
  db: D1Database,
  key: string,
  isValidRegime: (value: unknown) => value is R,
): Promise<R | null> {
  const row = await db
    .prepare('SELECT value FROM config_state_snapshot WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>()
  if (!row || typeof row.value !== 'string') return null
  const parsed = parseSafe(row.value)
  if (isValidRegime(parsed)) return parsed
  return null
}

/** `db` undefined is a noop, matching configStateChange's contract. */
export async function detectAndNotifyRegimeChange<R extends string>(args: {
  db: D1Database | undefined
  notifier: Notifier
  key: string
  /** Regime under evaluation; `reason` also becomes the notification note. */
  current: { regime: R; reason: string }
  rank: Record<R, number>
  criticalRegime: R
  isValidRegime: (value: unknown) => value is R
  requestId?: string
  now?: () => Date
  /**
   * Per-transition notify gate. The snapshot (and CAS) still updates when
   * this returns false — only the notification is suppressed, for
   * transitions the recipient can't act on (e.g. news-shock's
   * unknown→normal is missing-data recovery, not a market signal).
   * Omitted = notify on every transition.
   */
  shouldNotify?: (from: R, to: R) => boolean
  /** Human headline; undefined falls back to the default `state change: <field> <from> → <to>` text. */
  headline?: (from: R, to: R) => string | undefined
}): Promise<{ from: R | null; to: R; emitted: boolean }> {
  if (!args.db) {
    return { from: null, to: args.current.regime, emitted: false }
  }
  const now = (args.now ?? (() => new Date()))()
  const { previous, updated } = await atomicallyUpdateRegimeSnapshot(
    args.db,
    args.key,
    args.current.regime,
    now,
    args.isValidRegime,
    args.requestId,
  )
  let emitted = false
  if (
    updated &&
    previous !== null &&
    previous !== args.current.regime &&
    (args.shouldNotify?.(previous, args.current.regime) ?? true)
  ) {
    const severity = classifyRegimeSeverity(previous, args.current.regime, args.rank, args.criticalRegime)
    // No requestId in the body — correlation goes through the emit log's
    // request_id column. A headline replaces the reason note entirely
    // rather than appending it.
    const headline = args.headline?.(previous, args.current.regime)
    // `.catch()` alone only covers async rejection; a synchronous throw
    // from notify() would otherwise propagate out of this function and
    // abort the `emitted`/return below, even though the CAS above already
    // succeeded. try/catch covers both paths under one warn event.
    try {
      const result = args.notifier.notify({
        type: 'STATE_CHANGE',
        field: args.key,
        from: previous,
        to: args.current.regime,
        severity,
        ...(headline !== undefined ? { headline } : { note: args.current.reason }),
      })
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch((err) => {
          console.warn(
            JSON.stringify({
              event: `${args.key}_change_notify_failed`,
              requestId: args.requestId ?? null,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        })
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: `${args.key}_change_notify_failed`,
          requestId: args.requestId ?? null,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    emitted = true
  }
  return { from: previous, to: args.current.regime, emitted }
}

function parseSafe(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}
