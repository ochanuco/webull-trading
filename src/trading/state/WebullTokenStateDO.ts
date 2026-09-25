import { DurableObject } from 'cloudflare:workers'
import type { WebullTokenStatus } from '../../infrastructure/webull/WebullTokenClient'

const STATE_KEY = 'webull_token'

/**
 * Callers must address this DO via `idFromName('default')` — one shared
 * instance per worker environment. Intentionally storage-only: refresh
 * orchestration lives in `refreshWebullToken` instead, so the network-call
 * boundary stays out of the DO and unit tests don't need to mock fetch
 * through a DO stub.
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

  /** Refuses non-NORMAL status so a half-verified PENDING token never enters the runtime path. */
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

  /** On failure, keeps the previous token but still bumps `lastAttemptAt` so monitoring can detect a stuck retry. */
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
        // Resets on a token change so dashboards/alerts can tell "rotated
        // just now" apart from "still using the old token".
        fetchedAt: current && current.token === result.token ? current.fetchedAt : now,
        lastAttemptAt: now,
        lastSuccessAt: now,
      }
      await this.ctx.storage.put(STATE_KEY, next)
      return next
    }

    if (!current) {
      // Nothing usable to persist, but the marker row still records the
      // attempt timestamp for ops even though the returned state is null.
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
