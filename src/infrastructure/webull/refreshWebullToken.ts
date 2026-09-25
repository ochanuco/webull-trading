import type { Env } from '../../config/env'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { WebullAuth } from './WebullAuth'
import {
  WebullTokenClient,
  type WebullAccessTokenDto,
} from './WebullTokenClient'

/**
 * Background refresh of the active `x-access-token`, called from the cron
 * handler. No stored state or expiring soon → `createToken(existingToken)`.
 * A NORMAL result writes back immediately; PENDING/INVALID/EXPIRED counts as
 * failure (operator reseeds via `pnpm run issue-token`).
 *
 * Webull's docs don't specify whether `expires` is ms or sec, so values
 * ≥1e12 are treated as ms and smaller ones as sec — the same heuristic used
 * elsewhere (e.g. `coerceAsOf`).
 */

const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
/** Refresh once this many days remain — half of Webull's 15-day inactivity window. */
const REFRESH_BEFORE_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface RefreshSummary {
  /** True only when the broker returned a new NORMAL token and the DO was updated. */
  refreshed: boolean
  skippedReason?: string
  failureReason?: string
  before: WebullTokenState | null
  /** State after the attempt — unchanged from `before` if no write happened. */
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
    // No DO binding (e.g. local dev) — skip rather than fail; the env-based token stays in effect.
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

  // Webull may return the same token unchanged — still recorded as success so lastSuccessAt advances.
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
