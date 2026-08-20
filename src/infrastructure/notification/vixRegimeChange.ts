/**
 * VIX regime 遷移検知 + STATE_CHANGE 通知 (issue #196 3/3)。
 *
 * cron tick で算出した `VixRegimeFilterDecision.regime` を `config_state_snapshot`
 * に保存し、前回 tick との diff (e.g. `normal → warning`, `warning → critical`)
 * のみ Notifier に push する。同 regime が連続する tick では emit しない (dedup)。
 *
 * 実体は `regimeChange.ts` の汎用版 (news-shock-gate PR 2 で抽出) — この
 * module は snapshot key (`vix_regime`) と regime 型 (`VixRegime`) を固定した
 * 薄い wrapper。既存の public signature / 挙動は完全に維持する
 * (`test/infrastructure/notification/vixRegimeChange.test.ts` が無改変で通る)。
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
import {
  atomicallyUpdateRegimeSnapshot,
  classifyRegimeSeverity,
  detectAndNotifyRegimeChange,
  loadRegimeSnapshot,
  persistRegimeSnapshot,
} from './regimeChange'
import type { Notifier, NotificationSeverity } from './Notifier'
import type { VixRegime, VixRegimeFilterDecision } from '../../trading/risk/vixRegimeFilter'

/** snapshot table の key 値。`config_state_snapshot.key` の他 watched-config 群と衝突しない短名。 */
const VIX_REGIME_SNAPSHOT_KEY = 'vix_regime'

/**
 * regime のランク (低 → 高)。「critical 方向への遷移は警告強め、緩和方向は info」
 * の severity 判定に使う。
 */
const REGIME_RANK: Record<VixRegime, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
}

function isVixRegime(value: unknown): value is VixRegime {
  return value === 'normal' || value === 'warning' || value === 'critical'
}

/**
 * 遷移の severity を返す。同 regime 連続は呼び出し側でフィルタする想定なので
 * ここでは `from === to` を考慮しない (caller の責務)。
 */
export function classifyVixRegimeSeverity(
  from: VixRegime | null,
  to: VixRegime,
): NotificationSeverity {
  return classifyRegimeSeverity(from, to, REGIME_RANK, 'critical')
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
  return loadRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, isVixRegime, requestId)
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
  return persistRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, regime, requestId, now)
}

/**
 * Atomic compare-and-update for the VIX regime snapshot (CodeRabbit #216 4th)。
 * 実体は `atomicallyUpdateRegimeSnapshot` (regimeChange.ts)。詳細な race /
 * self-heal の挙動はそちらの doc comment を参照。
 */
export async function atomicallyUpdateVixRegimeSnapshot(
  db: D1Database,
  next: VixRegime,
  now: Date,
  requestId?: string,
): Promise<{ previous: VixRegime | null; updated: boolean }> {
  return atomicallyUpdateRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, next, now, isVixRegime, requestId)
}

/**
 * cron tick から呼ばれる top-level helper (configStateChange の pattern を踏襲)。
 * 実体は `detectAndNotifyRegimeChange` (regimeChange.ts)。
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
  return detectAndNotifyRegimeChange({
    db: args.db,
    notifier: args.notifier,
    key: VIX_REGIME_SNAPSHOT_KEY,
    current: { regime: args.current.regime, reason: args.current.reason },
    rank: REGIME_RANK,
    criticalRegime: 'critical',
    isValidRegime: isVixRegime,
    requestId: args.requestId,
    now: args.now,
  })
}
