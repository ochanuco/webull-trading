import { DurableObject } from 'cloudflare:workers'
import type { WebullTokenStatus } from '../../infrastructure/webull/WebullTokenClient'

const STATE_KEY = 'webull_token'

/**
 * Durable Object that stores the active Webull `x-access-token` and its
 * metadata for runtime use (#21 Phase B). Singleton — every caller addresses
 * `idFromName('default')`, so there is exactly one shared instance per worker
 * environment.
 *
 * The DO is intentionally storage-only. Refresh orchestration (calling
 * `WebullTokenClient.createToken(existingToken)` and deciding whether to
 * update) lives in `refreshWebullToken` so the network-call boundary stays
 * out of the DO and unit tests don't need to mock fetch through a DO stub.
 */

export interface WebullTokenState {
  /** Last token observed in NORMAL status. */
  token: string
  /** Epoch ms / sec as returned by Webull. We persist the raw value untouched. */
  expires: number
  status: WebullTokenStatus
  /** Wall-clock when this state was written (ISO). */
  fetchedAt: string
  /** Wall-clock of the most recent refresh attempt (ISO, success or failure). */
  lastAttemptAt: string | null
  /** Wall-clock of the most recent successful refresh (ISO). Helps spot a stuck loop. */
  lastSuccessAt: string | null
}

export class WebullTokenStateDO extends DurableObject<object> {
  async getState(): Promise<WebullTokenState | null> {
    const stored = await this.ctx.storage.get<WebullTokenState>(STATE_KEY)
    return stored ?? null
  }

  /**
   * Operator seeds the DO with a freshly verified token (issued via
   * `pnpm run issue-token` and confirmed `NORMAL`). Refusing non-NORMAL values
   * here keeps a half-verified PENDING token out of the runtime path.
   */
  async seedToken(input: {
    token: string
    expires: number
    status: WebullTokenStatus
    nowIso?: string
  }): Promise<WebullTokenState> {
    if (input.status !== 'NORMAL') {
      throw new Error(
        `WebullTokenStateDO.seedToken refuses status=${input.status}; only NORMAL tokens may be seeded`,
      )
    }
    const now = input.nowIso ?? new Date().toISOString()
    const next: WebullTokenState = {
      token: input.token,
      expires: input.expires,
      status: input.status,
      fetchedAt: now,
      lastAttemptAt: now,
      lastSuccessAt: now,
    }
    await this.ctx.storage.put(STATE_KEY, next)
    return next
  }

  /**
   * Persist the result of a refresh attempt. `result.success === true` means
   * `next` replaces the active token; otherwise we keep the previous token
   * but bump `lastAttemptAt` so monitoring can detect a stuck retry.
   */
  async recordRefresh(
    result:
      | {
          success: true
          token: string
          expires: number
          status: WebullTokenStatus
          nowIso?: string
        }
      | { success: false; nowIso?: string },
  ): Promise<WebullTokenState | null> {
    const now = result.nowIso ?? new Date().toISOString()
    const current = (await this.ctx.storage.get<WebullTokenState>(STATE_KEY)) ?? null

    if (result.success) {
      const next: WebullTokenState = {
        token: result.token,
        expires: result.expires,
        status: result.status,
        // Keep the original fetchedAt only if this is the same token; otherwise
        // reset so dashboards / alerts can distinguish "token rotated just now"
        // from "still using the old token".
        fetchedAt: current && current.token === result.token ? current.fetchedAt : now,
        lastAttemptAt: now,
        lastSuccessAt: now,
      }
      await this.ctx.storage.put(STATE_KEY, next)
      return next
    }

    if (!current) {
      // We have no prior state and refresh failed — there is nothing usable to
      // persist. We return null so the caller knows there's no token, but we
      // still write a marker row to capture the attempt timestamp for ops.
      const marker: WebullTokenState = {
        token: '',
        expires: 0,
        status: 'INVALID',
        fetchedAt: now,
        lastAttemptAt: now,
        lastSuccessAt: null,
      }
      await this.ctx.storage.put(STATE_KEY, marker)
      return marker
    }

    const next: WebullTokenState = {
      ...current,
      lastAttemptAt: now,
    }
    await this.ctx.storage.put(STATE_KEY, next)
    return next
  }
}
