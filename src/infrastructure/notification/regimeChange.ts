/**
 * Generic regime-change detection + STATE_CHANGE notification (extracted from
 * `vixRegimeChange.ts`, issue #196 3/3 → news-shock-gate PR 2).
 *
 * `vixRegimeChange.ts` の実体 (CAS 更新 / severity 分類 / dedup 通知) を
 * snapshot key と regime 型を引数で受ける汎用版に切り出したもの。
 * `vixRegimeChange.ts` はこの module を呼ぶ薄い wrapper として残り、既存の
 * public signature / 挙動 (event 名を含む) を完全に維持する。
 *
 * `config_state_snapshot` 1 行 = 1 key (例: `vix_regime` / `news_shock_regime`)
 * を CAS (compare-and-swap) で更新し、前回 tick との diff のみ Notifier に push
 * する (dedup)。初回 (snapshot 行なし) は emit しない (false alert 防止)。
 * 壊れた snapshot 行は self-heal する (次回比較の起点を作り直す)。
 *
 * fail-silent: D1 read / write が落ちても cron 本体には影響させない。
 */
import { eq } from 'drizzle-orm'
import { configStateSnapshot } from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { Notifier, NotificationSeverity } from './Notifier'

/**
 * severity 判定用の regime ランク表。`classifyRegimeSeverity` は
 * 「critical へ到達する遷移は critical、それ以外の悪化は warning、緩和は info」
 * という規則を rank の大小関係だけから導く。呼び出し側は自 domain の regime
 * 集合に対する rank map を渡す (例: VIX は normal/warning/critical の 3 値、
 * news shock は unknown/normal/warning/critical の 4 値)。
 */
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

/**
 * 前回 snapshot を読む。table 未 migration / 接続失敗等は null フォールバック
 * (= 「初回扱い」、通知は出さない)。
 *
 * `requestId` は失敗 warn ログにのみ使用する (cron run と相関させるため)。
 * warn ログの `event` は `${key}_snapshot_load_failed` (key='vix_regime' なら
 * 既存の `vix_regime_snapshot_load_failed` と一致する)。
 */
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

/**
 * 現在 regime で snapshot を upsert する。失敗は throw しない (caller が握りつぶす)。
 * 書き込み失敗は次 tick で「変わらなかった」誤検知が増えるだけで実害は小さい。
 */
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
    // configStateChange と同様、portable upsert は delete + insert で emulate。
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
 * Atomic compare-and-update for a regime snapshot row (CodeRabbit #216 4th,
 * extracted for reuse across VIX / news-shock regimes).
 *
 * 同 cron tick が並行して走った場合 (e.g. cron 重複 / 手動 trigger 並行) に
 * `load → notify → persist` の 3 step が race して重複通知が起きうるのを、
 * D1 の `UPDATE ... WHERE value = old` (CAS) で原子化する。
 *
 * 戻り値:
 *   - `previous`: 直前の snapshot 値 (初回は null)
 *   - `updated`: この caller が実際に snapshot を書き換えたか
 *
 * caller は `updated === true && previous !== null && previous !== next` の
 * ときだけ notify することで、race 下でも重複通知を防げる。初回 (previous=null)
 * は updated=true でも emit しない (false alert 防止)。
 *
 * fail-silent: D1 が落ちたら `{ previous: null, updated: false }` を返す。
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
    // 1) 初回 race を防ぐため INSERT OR IGNORE で行を確保する。
    //    meta.changes >= 1 なら自分が初回 row を作った。
    const insertRes = await db
      .prepare(
        'INSERT OR IGNORE INTO config_state_snapshot (key, value, snapshot_at, request_id) VALUES (?, ?, ?, ?)',
      )
      .bind(key, nextJson, snapshotAt, requestId ?? null)
      .run()
    const insertedRows = insertRes?.meta?.changes ?? 0
    if (insertedRows >= 1) {
      // この caller が初めて snapshot を作った。previous は null。
      return { previous: null, updated: true }
    }

    // 2) 既存 row があるので current を読む。
    const current = await readCurrentSnapshotValue(db, key, isValidRegime)
    if (current === null) {
      // 行は存在するが値が壊れている (parse 失敗等)。CAS の起点が無いままだと
      // 毎 tick 同じ分岐で stuck するので、初回観測と同じ扱いで next を書き込み
      // snapshot を直す (self-heal, CodeRabbit #216 5th)。previous=null のため
      // caller 側で notify は skip される (false alert 防止)。
      await db
        .prepare(
          'UPDATE config_state_snapshot SET value = ?, snapshot_at = ?, request_id = ? WHERE key = ?',
        )
        .bind(nextJson, snapshotAt, requestId ?? null, key)
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
      .bind(nextJson, snapshotAt, requestId ?? null, key, JSON.stringify(current))
      .run()
    const changed = updateRes?.meta?.changes ?? 0
    if (changed >= 1) {
      // CAS 成功。この caller の責任で notify してよい。
      return { previous: current, updated: true }
    }
    // 4) 他 caller が先に書き換えた。最新値を再取得して updated=false で返す。
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

/**
 * cron tick から呼ばれる top-level helper (configStateChange の pattern を踏襲)。
 *
 *   1. snapshot を CAS 更新する (失敗 → previous=null, updated=false)
 *   2. regime に変化があり、かつ自分が CAS に勝った場合のみ notifier に流す
 *      (fire-and-forget)
 *
 * `db` が無い場合は noop (configStateChange と同じ — caller の if 分岐削減)。
 */
export async function detectAndNotifyRegimeChange<R extends string>(args: {
  db: D1Database | undefined
  notifier: Notifier
  key: string
  /** 評価対象 regime + 通知 note に使う reason。 */
  current: { regime: R; reason: string }
  rank: Record<R, number>
  criticalRegime: R
  isValidRegime: (value: unknown) => value is R
  requestId?: string
  now?: () => Date
  /**
   * 遷移ごとの通知可否。false でも snapshot (CAS) は更新される — 「状態は
   * 追うが受け手のアクションが無い遷移は流さない」ため (例: news shock の
   * unknown→normal はデータ欠測の回復であって市場シグナルではない)。
   * 省略時は全遷移を通知する (従来挙動)。
   */
  shouldNotify?: (from: R, to: R) => boolean
  /**
   * 人間向け見出し (`StateChangeNotificationEvent.headline`)。undefined を
   * 返した遷移は既定の `state change: <field> <from> → <to>` 表示に落ちる。
   */
  headline?: (from: R, to: R) => string | undefined
}): Promise<{ from: R | null; to: R; emitted: boolean }> {
  if (!args.db) {
    return { from: null, to: args.current.regime, emitted: false }
  }
  const now = (args.now ?? (() => new Date()))()
  // CAS で snapshot を更新。並行 cron で重複通知が出ないように、ここで「自分が
  // 更新した」と判定された caller だけが notify する (CodeRabbit #216 4th)。
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
    const note = args.requestId ? `requestId=${args.requestId}` : undefined
    const headline = args.headline?.(previous, args.current.regime)
    // notify は fire-and-forget。`.catch(...)` は async rejection しか拾えない
    // ため、type error 等の同期 throw が起きると下の snapshot 永続化に到達せず
    // 「次 tick も同じ regime → 再通知 + snapshot 不整合」のリスクがあった。
    // try/catch で sync throw も握りつぶし、両系統を同じ event 名で warn する。
    try {
      const result = args.notifier.notify({
        type: 'STATE_CHANGE',
        field: args.key,
        from: previous,
        to: args.current.regime,
        severity,
        ...(headline !== undefined ? { headline } : {}),
        ...(note !== undefined
          ? { note: `${note} ${args.current.reason}`.trim() }
          : { note: args.current.reason }),
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
