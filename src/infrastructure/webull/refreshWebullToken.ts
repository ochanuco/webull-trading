import type { Env } from '../../config/env'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { WebullAuth } from './WebullAuth'
import {
  WebullTokenClient,
  type WebullAccessTokenDto,
} from './WebullTokenClient'

/**
 * Background refresh of the active `x-access-token` (#21 Phase B).
 *
 * Called from the cron handler. Walks the state machine:
 *   - DO state は無し / 期限切れ間近 → `createToken(existingToken)` で更新
 *   - 既に NORMAL 返却なら即書き戻し
 *   - PENDING 等 → 失敗扱い (operator が再度 `pnpm run issue-token` で seed する想定)
 *   - INVALID / EXPIRED → 失敗扱い
 *
 * Refresh が必要かどうかの判定は時刻と `expires` の差分で行う。Webull docs に
 * `expires` の単位 (ms or sec) が明示されてないので両方サポート (10^12 以上を ms、
 * それ以外を sec として扱う)。これは `coerceAsOf` 等で他にも採用してる pattern。
 */

const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
/** expires まで残り日数がこれ以下になったら refresh 試行。Webull 15 days inactivity 規定の半分。 */
const REFRESH_BEFORE_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface RefreshSummary {
  /** 実際に DO を更新したか (= broker から新しい NORMAL token を取得できたか)。 */
  refreshed: boolean
  /** 試行をスキップしたなら理由 (期限まで余裕がある等)。 */
  skippedReason?: string
  /** 失敗時の理由 (broker error / PENDING など)。 */
  failureReason?: string
  /** 試行前の DO 状態 (debug 用)。 */
  before: WebullTokenState | null
  /** 試行後の DO 状態 (write が走らなかった場合は before と同じ)。 */
  after: WebullTokenState | null
}

export async function refreshWebullToken(
  env: Env,
  options?: {
    now?: () => Date
    tokenClient?: WebullTokenClient
    force?: boolean
  },
): Promise<RefreshSummary> {
  const namespace = env.WEBULL_TOKEN_STATE
  if (!namespace) {
    // DO 未バインドな環境 (local dev で wrangler.jsonc を編集してない等)。
    // 自動 refresh は無効、Phase A の env 経由運用を続ける。
    return {
      refreshed: false,
      skippedReason: 'WEBULL_TOKEN_STATE binding is not configured',
      before: null,
      after: null,
    }
  }

  const now = options?.now?.() ?? new Date()
  const store = new WebullTokenStateClient(namespace)
  const before = await store.getState()

  // refresh の必要判定: state なし or expires が REFRESH_BEFORE_DAYS 以内 or force。
  // `expires` の単位 (ms vs sec) は値で判定 (10^12 以上は ms、未満は sec)。
  if (!options?.force && before && before.status === 'NORMAL') {
    const expiresMs = before.expires >= 1e12 ? before.expires : before.expires * 1000
    const remainMs = expiresMs - now.getTime()
    if (remainMs > REFRESH_BEFORE_DAYS * MS_PER_DAY) {
      return {
        refreshed: false,
        skippedReason: `not due yet (remain ${Math.floor(remainMs / MS_PER_DAY)} days)`,
        before,
        after: before,
      }
    }
  }

  if (!env.WEBULL_APP_KEY || !env.WEBULL_APP_SECRET) {
    return {
      refreshed: false,
      failureReason: 'WEBULL_APP_KEY / WEBULL_APP_SECRET not set',
      before,
      after: before,
    }
  }

  const client =
    options?.tokenClient ??
    new WebullTokenClient({
      auth: new WebullAuth({
        appKey: env.WEBULL_APP_KEY,
        appSecret: env.WEBULL_APP_SECRET,
      }),
      baseUrl: env.WEBULL_TRADE_API_BASE?.trim() || DEFAULT_TRADE_API_BASE,
    })

  let result: WebullAccessTokenDto
  try {
    result = await client.createToken(before?.token)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const after = await store.recordRefresh({ success: false, nowIso: now.toISOString() })
    return {
      refreshed: false,
      failureReason: `createToken threw: ${message}`,
      before,
      after,
    }
  }

  // Webull は refresh 時に同じ token を返すこともある (status だけ更新)。それでも
  // NORMAL なら success として書き戻す (= lastSuccessAt が動く事に意味がある)。
  if (result.status === 'NORMAL') {
    const after = await store.recordRefresh({
      success: true,
      token: result.token,
      expires: result.expires,
      status: result.status,
      nowIso: now.toISOString(),
    })
    return { refreshed: true, before, after }
  }

  const after = await store.recordRefresh({ success: false, nowIso: now.toISOString() })
  return {
    refreshed: false,
    failureReason: `createToken returned status=${result.status} (operator action required)`,
    before,
    after,
  }
}
