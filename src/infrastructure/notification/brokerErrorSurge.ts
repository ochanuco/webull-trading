import { and, eq, gte, inArray } from 'drizzle-orm'
import {
  BrokerAuthError,
  BrokerClientError,
  BrokerRateLimitError,
  BrokerRequestError,
  BrokerServerError,
} from '../../shared/errors'
import { configStateSnapshot, notificationEmitLog } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier } from './Notifier'

/**
 * Broker request の 4xx/5xx/429 急増検知 + dedup STATE_CHANGE 通知。
 * `notification_emit_log` を source of truth として直近 lookback 分の broker
 * error 件数が threshold を超えたら 1 件だけ通知し、解消時も 1 件だけ resolve
 * 通知を出す。lookback / threshold は hard-code — global_config 拡張は test
 * fixture への影響が大きく POC 段階では見送り。
 */

export interface BrokerSurgeConfig {
  /** 直近 lookback 分間の broker error を集計する。default 5 分。 */
  lookbackMinutes: number
  /** lookback 内 errorCount >= surgeThreshold で surging=true。default 5 件。 */
  surgeThreshold: number
  /** `config_state_snapshot.key`。default `'broker_error_surge'`; override for test isolation. */
  surgeStateKey: string
}

export const DEFAULT_BROKER_SURGE_CONFIG: BrokerSurgeConfig = {
  lookbackMinutes: 5,
  surgeThreshold: 5,
  surgeStateKey: 'broker_error_surge',
}

// `broker submit` is a legacy cause string kept for compatibility with older log rows.
export const BROKER_ERROR_CAUSES: ReadonlyArray<string> = [
  'broker_429',
  'broker_4xx',
  'broker_5xx',
  'broker_other',
  'broker submit',
]

export interface BrokerSurgeDetection {
  surging: boolean
  errorCount: number
  threshold: number
  lookbackMinutes: number
  /** Deduped, sorted causes observed in the window. */
  causes: string[]
}

/** D1 failure returns `surging=false / errorCount=0` rather than throwing, to avoid a false alert. */
export async function detectBrokerErrorSurge(
  db: D1Database,
  config: BrokerSurgeConfig,
  now: Date,
): Promise<BrokerSurgeDetection> {
  const since = new Date(now.getTime() - config.lookbackMinutes * 60_000).toISOString()
  try {
    const drizzle = createDb(db)
    const rows = await drizzle
      .select({
        cause: notificationEmitLog.cause,
      })
      .from(notificationEmitLog)
      .where(
        and(
          eq(notificationEmitLog.eventType, 'ERROR'),
          gte(notificationEmitLog.timestamp, since),
          inArray(notificationEmitLog.cause, [...BROKER_ERROR_CAUSES]),
        ),
      )
    const causes = new Set<string>()
    for (const row of rows) {
      if (row.cause) causes.add(row.cause)
    }
    const errorCount = rows.length
    return {
      surging: errorCount >= config.surgeThreshold,
      errorCount,
      threshold: config.surgeThreshold,
      lookbackMinutes: config.lookbackMinutes,
      causes: [...causes].sort(),
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'broker_error_surge_detect_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return {
      surging: false,
      errorCount: 0,
      threshold: config.surgeThreshold,
      lookbackMinutes: config.lookbackMinutes,
      causes: [],
    }
  }
}

// Missing row / parse failure / D1 error all fall back to false (first-observation).
async function loadPreviousSurgeState(
  db: D1Database,
  key: string,
): Promise<boolean> {
  try {
    const drizzle = createDb(db)
    const rows = await drizzle
      .select({ value: configStateSnapshot.value })
      .from(configStateSnapshot)
      .where(eq(configStateSnapshot.key, key))
    if (rows.length === 0) return false
    const parsed = JSON.parse(rows[0]!.value) as unknown
    return parsed === true
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'broker_error_surge_snapshot_load_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}

async function persistSurgeState(
  db: D1Database,
  key: string,
  surging: boolean,
  now: Date,
  requestId: string | undefined,
): Promise<void> {
  try {
    const drizzle = createDb(db)
    await drizzle.delete(configStateSnapshot).where(eq(configStateSnapshot.key, key))
    await drizzle.insert(configStateSnapshot).values({
      key,
      value: JSON.stringify(surging),
      snapshotAt: now.toISOString(),
      requestId: requestId ?? null,
    })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'broker_error_surge_snapshot_persist_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

export interface NotifyBrokerErrorSurgeArgs {
  db: D1Database
  notifier: Notifier
  config?: BrokerSurgeConfig
  now?: Date
  requestId?: string
}

export interface NotifyBrokerErrorSurgeResult {
  emitted: boolean
  surging: boolean
  detection: BrokerSurgeDetection
}

export async function notifyBrokerErrorSurgeIfChanged(
  args: NotifyBrokerErrorSurgeArgs,
): Promise<NotifyBrokerErrorSurgeResult> {
  const config = args.config ?? DEFAULT_BROKER_SURGE_CONFIG
  const now = args.now ?? new Date()
  const detection = await detectBrokerErrorSurge(args.db, config, now)
  const previous = await loadPreviousSurgeState(args.db, config.surgeStateKey)
  let emitted = false

  if (previous !== detection.surging) {
    const note = args.requestId ? `requestId=${args.requestId}` : undefined
    try {
      await args.notifier.notify({
        type: 'STATE_CHANGE',
        field: config.surgeStateKey,
        from: previous,
        to: detection.surging,
        severity: detection.surging ? 'critical' : 'info',
        ...(note !== undefined ? { note } : {}),
      })
      emitted = true
    } catch (error) {
      // Notifier is contracted to always resolve, but defends anyway: the
      // snapshot write below still runs so a resolve notification isn't lost forever.
      console.warn(
        JSON.stringify({
          event: 'broker_error_surge_notify_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  // Always overwrite, notified or not — otherwise a resolve transition
  // would be missed once the surge state stops changing.
  await persistSurgeState(args.db, config.surgeStateKey, detection.surging, now, args.requestId)

  return { emitted, surging: detection.surging, detection }
}

export function classifyBrokerErrorCause(error: unknown): string | null {
  if (error instanceof BrokerRateLimitError) return 'broker_429'
  if (error instanceof BrokerAuthError) return 'broker_4xx'
  if (error instanceof BrokerClientError) return 'broker_4xx'
  if (error instanceof BrokerServerError) return 'broker_5xx'
  if (error instanceof BrokerRequestError) {
    const status = error.brokerStatus
    if (status === 429) return 'broker_429'
    if (typeof status === 'number') {
      if (status >= 400 && status < 500) return 'broker_4xx'
      if (status >= 500 && status < 600) return 'broker_5xx'
    }
    return 'broker_other'
  }
  return null
}
