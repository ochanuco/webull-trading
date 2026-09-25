import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { recordChange } from '../../infrastructure/db/configAuditLog'
import { deactivateSymbolForBrokerDeny } from '../../infrastructure/db/symbolConfigRepo'
import type { Notifier } from '../../infrastructure/notification/Notifier'

// Webull が銘柄単位で恒久的に発注拒否 (TICKER_IS_DENY) すると、cooldown は約定後
// にしか付かないため entry 条件成立中は 5 分 cron ごとに 417 を出し続ける。この
// ガードは検知した銘柄を symbol_config.active=0 にして自動停止する。解除は
// operator の明示操作のみ、自動再試行しない。
export interface TickerDenyGuardDeps {
  db: DrizzleD1Database
  /** recordChange が直接受ける raw D1 binding。監査ログ書き込み専用に db と分けている。 */
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
      // Swallowed: a failed stop attempt just retriggers the same 417 next
      // tick, so this must not take the calling cron run down with it.
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
