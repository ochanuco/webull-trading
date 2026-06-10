import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { recordChange } from '../../infrastructure/db/configAuditLog'
import { deactivateSymbolForBrokerDeny } from '../../infrastructure/db/symbolConfigRepo'
import type { Notifier } from '../../infrastructure/notification/Notifier'

/**
 * TICKER_IS_DENY 自動停止ガード (#460)。
 *
 * Webull が銘柄単位の恒久的な発注拒否 (`OAUTH_OPENAPI_TICKER_IS_DENY`、USMV で
 * 本番実証) を返した場合、cooldown は約定後にしか付かないため、entry 条件が
 * 成立し続ける限り 5 分 cron ごとに実 submit → 417 を繰り返してしまう。
 * このガードは検知した銘柄を fail-closed で自動 entry 停止する:
 *
 *   1. `symbol_config.active = 0` + notes に理由・日時を追記 (既存メモ保持)
 *   2. config_audit_log に actor='cron:ticker-deny-guard' で before/after を記録
 *      (cron による self-mutation を operator が後追いできるように)
 *   3. STATE_CHANGE を **1 回だけ** 通知 (inactive 化により次 tick から評価
 *      対象外になるので、毎 tick の ERROR 通知スパムが構造的に止まる)
 *
 * 解除は operator の明示操作 (dashboard の有効化ボタン) のみ。自動再試行しない。
 * ガード自身の失敗は握りつぶしてログだけ残す — 停止に失敗しても次 tick で
 * 同じ 417 → 再検知されるので、cron 本体を巻き込まない方が安全。
 */
export interface TickerDenyGuardDeps {
  db: DrizzleD1Database
  /** audit log 用の raw D1 binding (recordChange が直接受ける)。 */
  rawDb: D1Database
  notifier: Notifier
  requestId?: string
  now?: () => Date
}

export function createTickerDenyGuard(deps: TickerDenyGuardDeps): (symbol: string) => Promise<void> {
  return async (symbol: string): Promise<void> => {
    const upper = symbol.trim().toUpperCase()
    const nowIso = (deps.now ?? (() => new Date()))().toISOString()
    try {
      const reasonNote = `Webull TICKER_IS_DENY により自動停止 (${nowIso.slice(0, 10)}, #460)`
      const result = await deactivateSymbolForBrokerDeny(deps.db, upper, reasonNote, nowIso)
      if (result === null) {
        // 既に inactive (並走 / 再検知) — 冪等 no-op。通知も出さない。
        return
      }
      await recordChange(deps.rawDb, {
        actor: 'cron:ticker-deny-guard',
        endpoint: 'cron:strategy',
        targetKey: `symbol_config:${upper}`,
        before: { active: result.before.active, notes: result.before.notes },
        after: { active: result.after.active, notes: result.after.notes },
        requestId: deps.requestId ?? null,
      }).catch((err) => {
        console.error(
          JSON.stringify({
            event: 'ticker_deny_guard_audit_failed',
            symbol: upper,
            requestId: deps.requestId ?? null,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      })
      // 「実発注を止める向き」の遷移なので severity は warning (critical だと
      // ops 即対応扱いになるが、ここは既に安全側に倒した後の事後報告)。
      await deps.notifier
        .notify({
          type: 'STATE_CHANGE',
          field: `symbol_config.${upper}.active`,
          from: true,
          to: false,
          severity: 'warning',
          note: `Webull が銘柄単位で発注拒否 (TICKER_IS_DENY) — ${upper} を自動 entry 停止しました。再有効化は operator 操作のみ (#460)`,
        })
        .catch(() => undefined)
      console.warn(
        JSON.stringify({
          event: 'ticker_deny_guard_deactivated',
          symbol: upper,
          requestId: deps.requestId ?? null,
        }),
      )
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'ticker_deny_guard_failed',
          symbol: upper,
          requestId: deps.requestId ?? null,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}
