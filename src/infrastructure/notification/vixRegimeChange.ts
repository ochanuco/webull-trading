/**
 * VIX regime 遷移検知 + STATE_CHANGE 通知。`regimeChange.ts` の汎用実装を
 * snapshot key `vix_regime` / 型 `VixRegime` に固定した wrapper。
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

const REGIME_RANK: Record<VixRegime, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
}

function isVixRegime(value: unknown): value is VixRegime {
  return value === 'normal' || value === 'warning' || value === 'critical'
}

/** Does not special-case `from === to`; filtering same-regime ticks is the caller's job. */
export function classifyVixRegimeSeverity(
  from: VixRegime | null,
  to: VixRegime,
): NotificationSeverity {
  return classifyRegimeSeverity(from, to, REGIME_RANK, 'critical')
}

export async function loadVixRegimeSnapshot(
  db: D1Database,
  requestId?: string,
): Promise<VixRegime | null> {
  return loadRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, isVixRegime, requestId)
}

export async function persistVixRegimeSnapshot(
  db: D1Database,
  regime: VixRegime,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  return persistRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, regime, requestId, now)
}

/** See `atomicallyUpdateRegimeSnapshot` (regimeChange.ts) for the CAS/self-heal behavior. */
export async function atomicallyUpdateVixRegimeSnapshot(
  db: D1Database,
  next: VixRegime,
  now: Date,
  requestId?: string,
): Promise<{ previous: VixRegime | null; updated: boolean }> {
  return atomicallyUpdateRegimeSnapshot(db, VIX_REGIME_SNAPSHOT_KEY, next, now, isVixRegime, requestId)
}

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
