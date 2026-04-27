/**
 * VIX regime 遷移検知 + STATE_CHANGE 通知 (issue #196 3/3)。
 *
 * cron tick で算出した `VixRegimeFilterDecision.regime` を `config_state_snapshot`
 * に保存し、前回 tick との diff (e.g. `normal → warning`, `warning → critical`)
 * のみ Notifier に push する。同 regime が連続する tick では emit しない (dedup)。
 *
 * `configStateChange.ts` と同じ pattern (snapshot table 共有) で実装する:
 *   - key: `vix_regime` 固定 (1 行)
 *   - value: JSON.stringify(regime) (e.g. `"normal"`)
 *   - 初回 (snapshot 行なし) は通知を出さず単に snapshot を作る (false alert 防止)
 *
 * severity 規則:
 *   - normal → warning   : warning  (size 縮小開始)
 *   - normal → critical  : critical (BUY 全停止)
 *   - warning → critical : critical (escalation)
 *   - critical → warning : info     (緩和)
 *   - critical → normal  : info     (解除)
 *   - warning → normal   : info     (解除)
 *
 * fail-silent: D1 read / write が落ちても cron 本体には影響させない。
 */
import { eq } from 'drizzle-orm'
import { configStateSnapshot } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier, NotificationSeverity } from './Notifier'
import type { VixRegime, VixRegimeFilterDecision } from '../../trading/risk/vixRegimeFilter'

/** snapshot table の key 値。`config_state_snapshot.key` の他 watched-config 群と衝突しない短名。 */
export const VIX_REGIME_SNAPSHOT_KEY = 'vix_regime'

/**
 * regime のランク (低 → 高)。「critical 方向への遷移は警告強め、緩和方向は info」
 * の severity 判定に使う。
 */
const REGIME_RANK: Record<VixRegime, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
}

/**
 * 遷移の severity を返す。同 regime 連続は呼び出し側でフィルタする想定なので
 * ここでは `from === to` を考慮しない (caller の責務)。
 */
export function classifyVixRegimeSeverity(
  from: VixRegime | null,
  to: VixRegime,
): NotificationSeverity {
  if (from === null) return 'info'
  const fromRank = REGIME_RANK[from]
  const toRank = REGIME_RANK[to]
  if (toRank > fromRank) {
    // 悪化方向。critical へ到達する遷移は critical、それ以外 (normal→warning) は warning。
    return to === 'critical' ? 'critical' : 'warning'
  }
  // 緩和方向は info。
  return 'info'
}

/**
 * 前回 snapshot を読む。table 未 migration / 接続失敗等は null フォールバック
 * (= 「初回扱い」、通知は出さない)。
 *
 * `requestId` は失敗 warn ログにのみ使用する (cron run と相関させるため)。
 */
export async function loadVixRegimeSnapshot(
  db: D1Database,
  requestId?: string,
): Promise<VixRegime | null> {
  try {
    const drizzle = createDb(db)
    const rows = await drizzle
      .select({ value: configStateSnapshot.value })
      .from(configStateSnapshot)
      .where(eq(configStateSnapshot.key, VIX_REGIME_SNAPSHOT_KEY))
      .limit(1)
    const raw = rows[0]?.value
    if (!raw) return null
    const parsed = parseSafe(raw)
    if (parsed === 'normal' || parsed === 'warning' || parsed === 'critical') {
      return parsed
    }
    return null
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_snapshot_load_failed',
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/**
 * 現在 regime で snapshot を upsert する。失敗は throw しない (caller が握りつぶす)。
 * 書き込み失敗は次 tick で「変わらなかった」誤検知が増えるだけで実害は小さい。
 */
export async function persistVixRegimeSnapshot(
  db: D1Database,
  regime: VixRegime,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  const drizzle = createDb(db)
  const snapshotAt = now.toISOString()
  const value = JSON.stringify(regime)
  try {
    // configStateChange と同様、portable upsert は delete + insert で emulate。
    await drizzle.delete(configStateSnapshot).where(eq(configStateSnapshot.key, VIX_REGIME_SNAPSHOT_KEY))
    await drizzle.insert(configStateSnapshot).values({
      key: VIX_REGIME_SNAPSHOT_KEY,
      value,
      snapshotAt,
      requestId: requestId ?? null,
    })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_snapshot_persist_failed',
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * Atomic compare-and-update for the VIX regime snapshot (CodeRabbit #216 4th).
 *
 * 同 cron tick が並行して走った場合 (e.g. cron 重複 / 手動 trigger 並行) に
 * `loadVixRegimeSnapshot → notify → persistVixRegimeSnapshot` の 3 step が
 * race して、両 caller が同じ previous を読み → 両方が notify → 後勝ち update、
 * という重複通知が起きうる。これを D1 の `UPDATE ... WHERE value = old` (CAS)
 * で原子化する。
 *
 * 戻り値:
 *   - `previous`: 直前の snapshot 値 (初回は null)
 *   - `updated`: この caller が実際に snapshot を書き換えたか
 *
 * caller は `updated === true && previous !== null && previous !== next` の
 * ときだけ notify することで、race 下でも重複通知を防げる。初回 (previous=null)
 * は updated=true でも emit しない (false alert 防止 — 既存挙動と同じ)。
 *
 * fail-silent: D1 が落ちたら `{ previous: null, updated: false }` を返す。
 * 既存 `loadVixRegimeSnapshot` / `persistVixRegimeSnapshot` の signature は
 * 温存し、新 caller (`detectAndNotifyVixRegimeChange`) のみがこの helper を
 * 使う。
 */
export async function atomicallyUpdateVixRegimeSnapshot(
  db: D1Database,
  next: VixRegime,
  now: Date,
  requestId?: string,
): Promise<{ previous: VixRegime | null; updated: boolean }> {
  const snapshotAt = now.toISOString()
  const nextJson = JSON.stringify(next)
  try {
    // 1) 初回 race を防ぐため INSERT OR IGNORE で行を確保する。
    //    ただ、この時点では「INSERT した = この caller が初回」と確定はしない
    //    (drizzle 既存 path で別 helper が delete+insert してる可能性)。
    //    meta.changes >= 1 なら自分が初回 row を作った。
    const insertRes = await db
      .prepare(
        'INSERT OR IGNORE INTO config_state_snapshot (key, value, snapshot_at, request_id) VALUES (?, ?, ?, ?)',
      )
      .bind(VIX_REGIME_SNAPSHOT_KEY, nextJson, snapshotAt, requestId ?? null)
      .run()
    const insertedRows = insertRes?.meta?.changes ?? 0
    if (insertedRows >= 1) {
      // この caller が初めて snapshot を作った。previous は null。
      // updated=true だが、caller 側で previous=null は emit しない約束。
      return { previous: null, updated: true }
    }

    // 2) 既存 row があるので current を読む。
    const current = await readCurrentRegime(db)
    if (current === null) {
      // 行は存在するが値が壊れている (parse 失敗等)。CAS の起点が無いままだと
      // 毎 tick 同じ分岐で stuck し snapshot が永久に self-heal せず通知も再開
      // しないので、初回観測と同じ扱いで next を書き込み snapshot を直す
      // (CodeRabbit #216 5th)。previous=null のため caller 側で notify は
      // skip される (false alert 防止)。
      await db
        .prepare(
          'UPDATE config_state_snapshot SET value = ?, snapshot_at = ?, request_id = ? WHERE key = ?',
        )
        .bind(nextJson, snapshotAt, requestId ?? null, VIX_REGIME_SNAPSHOT_KEY)
        .run()
      return { previous: null, updated: true }
    }
    if (current === next) {
      // 値が同じ → no-op (snapshot_at だけ更新する意味は薄い、emit もしない)。
      return { previous: current, updated: false }
    }

    // 3) UPDATE WHERE value = current で CAS。他 caller が先に書き換えていたら
    //    meta.changes === 0 になる。
    const updateRes = await db
      .prepare(
        'UPDATE config_state_snapshot SET value = ?, snapshot_at = ?, request_id = ? WHERE key = ? AND value = ?',
      )
      .bind(nextJson, snapshotAt, requestId ?? null, VIX_REGIME_SNAPSHOT_KEY, JSON.stringify(current))
      .run()
    const changed = updateRes?.meta?.changes ?? 0
    if (changed >= 1) {
      // CAS 成功。この caller の責任で notify してよい。
      return { previous: current, updated: true }
    }
    // 4) 他 caller が先に書き換えた。最新値を再取得して updated=false で返す。
    const latest = await readCurrentRegime(db)
    return { previous: latest, updated: false }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'vix_regime_snapshot_cas_failed',
        requestId: requestId ?? null,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return { previous: null, updated: false }
  }
}

async function readCurrentRegime(db: D1Database): Promise<VixRegime | null> {
  const row = await db
    .prepare('SELECT value FROM config_state_snapshot WHERE key = ? LIMIT 1')
    .bind(VIX_REGIME_SNAPSHOT_KEY)
    .first<{ value: string }>()
  if (!row || typeof row.value !== 'string') return null
  const parsed = parseSafe(row.value)
  if (parsed === 'normal' || parsed === 'warning' || parsed === 'critical') {
    return parsed
  }
  return null
}

/**
 * cron tick から呼ばれる top-level helper (configStateChange の pattern を踏襲)。
 *
 *   1. snapshot を読む (失敗 → null)
 *   2. regime に変化があれば notifier に流す (fire-and-forget)
 *   3. snapshot を upsert (await する: 次 tick の比較に必要)
 *
 * `env.DB` が無い場合は noop (configStateChange と同じ — caller の if 分岐削減)。
 */
export async function detectAndNotifyVixRegimeChange(args: {
  db: D1Database | undefined
  notifier: Notifier
  current: VixRegimeFilterDecision
  requestId?: string
  now?: () => Date
}): Promise<{ from: VixRegime | null; to: VixRegime; emitted: boolean }> {
  if (!args.db) {
    return { from: null, to: args.current.regime, emitted: false }
  }
  const now = (args.now ?? (() => new Date()))()
  // CAS で snapshot を更新。並行 cron で重複通知が出ないように、ここで「自分が
  // 更新した」と判定された caller だけが notify する (CodeRabbit #216 4th)。
  const { previous, updated } = await atomicallyUpdateVixRegimeSnapshot(
    args.db,
    args.current.regime,
    now,
    args.requestId,
  )
  let emitted = false
  if (updated && previous !== null && previous !== args.current.regime) {
    const severity = classifyVixRegimeSeverity(previous, args.current.regime)
    const note = args.requestId ? `requestId=${args.requestId}` : undefined
    // notify は fire-and-forget。`.catch(...)` は async rejection しか拾えない
    // ため、type error 等の同期 throw が起きると下の snapshot 永続化に到達せず
    // 「次 tick も同じ regime → 再通知 + snapshot 不整合」のリスクがあった。
    // try/catch で sync throw も握りつぶし、両系統を同じ event 名で warn する。
    try {
      const result = args.notifier.notify({
        type: 'STATE_CHANGE',
        field: VIX_REGIME_SNAPSHOT_KEY,
        from: previous,
        to: args.current.regime,
        severity,
        ...(note !== undefined ? { note: `${note} ${args.current.reason}`.trim() } : { note: args.current.reason }),
      })
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'vix_regime_change_notify_failed',
              requestId: args.requestId ?? null,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        })
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'vix_regime_change_notify_failed',
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
