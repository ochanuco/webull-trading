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
 * Broker request の 4xx/5xx/429 急増検知 + dedup STATE_CHANGE 通知 (#209)。
 *
 * PR #210 (observability) で `notification_emit_log` に severity / event_type
 * / cause / timestamp が記録されるようになった。これを source of truth と
 * して、直近 lookback 分間の broker error 件数が threshold を超えたら 1 件だけ
 * STATE_CHANGE 通知を出す。surge 中は同 state 連発を抑止し、解消したら
 * resolve 通知を出す。
 *
 * 設計方針:
 *   - lookback / threshold は hard-code (POC 段階の判断: tune は run 後に決まる、
 *     global_config 拡張は test fixture 影響大)
 *   - state 永続化は既存 `config_state_snapshot` table を流用 (新 migration 不要)
 *   - vixRegime 系の dedup pattern (configStateChange.ts) を踏襲して実装統一
 *   - fail-silent: D1 read / write が落ちても cron 本体には影響させない
 */

export interface BrokerSurgeConfig {
  /** 直近 lookback 分間の broker error を集計する。default 5 分。 */
  lookbackMinutes: number
  /** lookback 内 errorCount >= surgeThreshold で surging=true。default 5 件。 */
  surgeThreshold: number
  /**
   * 永続化 snapshot key (`config_state_snapshot.key`)。default
   * `'broker_error_surge'`。test で衝突回避用に override 可能。
   */
  surgeStateKey: string
}

export const DEFAULT_BROKER_SURGE_CONFIG: BrokerSurgeConfig = {
  lookbackMinutes: 5,
  surgeThreshold: 5,
  surgeStateKey: 'broker_error_surge',
}

/**
 * 集計対象 cause。`pullbackScheduler` / `WebullExecution` 等で broker submit
 * error を notify する時に使われる canonical 名 (#209)。`broker submit` は
 * issue 以前の legacy だが互換のため含める。
 */
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
  /** 内訳: 検出 cause の配列 (例: `['broker_5xx','broker_429']`)。dedup 済。 */
  causes: string[]
}

/**
 * `notification_emit_log` から直近 lookback 分の broker error を COUNT する。
 * D1 失敗時は「surging=false / errorCount=0」として返す (false alert 防止)。
 */
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

/**
 * `config_state_snapshot` から前回の surging 状態 (`'true'` / `'false'`) を
 * 読む。値なし / parse 失敗 / D1 失敗は「初回 (= false 扱い)」を返す。
 *
 * 値は JSON.stringify(boolean) で持つ (configStateChange.ts と統一)。
 */
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

/**
 * 現在の surging 状態を `config_state_snapshot` に永続化。delete + insert で
 * upsert (sqlite portable upsert を avoid)。失敗は throw しない。
 */
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
  /** STATE_CHANGE notify を 1 件 emit したか。 */
  emitted: boolean
  /** 今 tick での surging 判定。 */
  surging: boolean
  detection: BrokerSurgeDetection
}

/**
 * cron tick から呼ぶ top-level helper。
 *
 *   1. lookback 内の broker error を COUNT
 *   2. snapshot と比較し、true ↔ false の遷移時のみ STATE_CHANGE 1 件 emit
 *      - false → true: severity=critical (surge 開始)
 *      - true → false: severity=info (resolve)
 *   3. 同 state 継続時は emit しない (over-noise 抑止)
 *   4. snapshot を必ず upsert する (notify が throw しても persist は走る)
 *
 * notify は fire-and-forget 相当 (`.notify()` は内部で握りつぶす契約)。
 */
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
      // notify 契約上は resolve するはずだが defensive。snapshot 更新は次の
      // ステップで必ず走らせる (resolve 通知が永遠に出ない事故を回避)。
      console.warn(
        JSON.stringify({
          event: 'broker_error_surge_notify_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  // 通知有無に関わらず snapshot は今 tick の値で上書き — そうしないと
  // 同 state 継続中の resolve 検知が遅れる (vixRegime と同じ pattern)。
  await persistSurgeState(args.db, config.surgeStateKey, detection.surging, now, args.requestId)

  return { emitted, surging: detection.surging, detection }
}

/**
 * Broker error の cause 文字列を canonical 化する (#209)。`pullbackScheduler`
 * / `WebullExecution` の broker submit error 通知で使う想定。
 *
 *   - `BrokerRateLimitError` (HTTP 429)        → `'broker_429'`
 *   - `BrokerAuthError` (401/403) / `BrokerClientError` (other 4xx) → `'broker_4xx'`
 *   - `BrokerServerError` (5xx)                → `'broker_5xx'`
 *   - その他 `BrokerRequestError` (network 等) → `'broker_other'`
 *   - broker error 以外                       → `null`
 */
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
