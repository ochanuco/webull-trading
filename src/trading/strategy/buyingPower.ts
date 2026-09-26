// Sizing allocates each symbol a % of the shared account buying power, but
// without a shared reservation the sum across symbols in one tick can
// exceed the real balance and get order-time-rejected by Webull (417). This
// ledger reserves from one JPY balance per tick so the scheduler can
// pre-trade reject an order that would overrun it; Webull's own 417 stays
// as a second, independent backstop.

import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'

/** Default safety margin for price drift / fees / rounding between sizing and fill. */
export const DEFAULT_BUYING_POWER_BUFFER_PCT = 0.01

export interface BuyingPowerLedger {
  /** `unavailable` means the balance fetch failed, so every reservation fails closed. */
  status: 'ok' | 'unavailable'
  /** Remaining buying power in JPY, after the safety buffer. */
  remainingJpy: number
  /** Fetch timestamp (ISO), for dashboard display. */
  asOf: string | null
  source: string
  /** Set when `status` is `unavailable`; surfaced to dashboard/logs. */
  reason?: string
  /** Reserves `notionalJpy` if `status` is `ok` and it fits in the remaining budget. */
  tryReserve(notionalJpy: number): boolean
  /** Reverses a reservation after a submit fails, so it doesn't skew later symbols in the tick. */
  refund(notionalJpy: number): void
}

export function createUnavailableBuyingPowerLedger(reason: string): BuyingPowerLedger {
  return {
    status: 'unavailable',
    remainingJpy: 0,
    asOf: null,
    source: 'webull-balance',
    reason,
    tryReserve() {
      return false
    },
    refund() {
      /* no-op */
    },
  }
}

export function createBuyingPowerLedger(opts: {
  availableJpy: number
  asOf: string | null
  source?: string
  bufferPct?: number
}): BuyingPowerLedger {
  const buffer = opts.bufferPct ?? DEFAULT_BUYING_POWER_BUFFER_PCT
  const safeBuffer = Number.isFinite(buffer) && buffer >= 0 && buffer < 1 ? buffer : DEFAULT_BUYING_POWER_BUFFER_PCT
  const base = Number.isFinite(opts.availableJpy) && opts.availableJpy > 0 ? opts.availableJpy : 0
  const ledger: BuyingPowerLedger = {
    status: 'ok',
    remainingJpy: base * (1 - safeBuffer),
    asOf: opts.asOf,
    source: opts.source ?? 'webull-balance',
    tryReserve(notionalJpy: number): boolean {
      if (!Number.isFinite(notionalJpy) || notionalJpy <= 0) return false
      if (notionalJpy > ledger.remainingJpy) return false
      ledger.remainingJpy -= notionalJpy
      return true
    },
    refund(notionalJpy: number): void {
      if (Number.isFinite(notionalJpy) && notionalJpy > 0) ledger.remainingJpy += notionalJpy
    },
  }
  return ledger
}

/**
 * Sums Webull's per-currency buying power into a JPY total (USD converted via `usdJpyRate`).
 * Returns null — caller fail-closes — rather than guess on any anomaly: missing/empty assets,
 * a negative/non-finite value, USD present without a usable FX rate, or any non-JPY/USD currency.
 */
export function buyingPowerJpyFromBalance(
  balance: WebullAccountBalanceDto,
  usdJpyRate: number | null,
): { jpy: number; byCurrency: Record<string, number> } | null {
  const assets = balance.account_currency_assets
  if (!Array.isArray(assets) || assets.length === 0) return null
  const fxOk = usdJpyRate !== null && Number.isFinite(usdJpyRate) && usdJpyRate > 0
  let jpy = 0
  const byCurrency: Record<string, number> = {}
  for (const asset of assets) {
    const ccy = (asset.currency ?? '').trim().toUpperCase()
    const bp = Number(asset.buying_power)
    if (!Number.isFinite(bp) || bp < 0) return null
    byCurrency[ccy] = bp
    if (ccy === 'JPY') {
      jpy += bp
    } else if (ccy === 'USD') {
      if (bp > 0) {
        if (!fxOk) return null
        jpy += bp * (usdJpyRate as number)
      }
    } else if (bp > 0) {
      return null
    }
  }
  if (!Number.isFinite(jpy) || jpy < 0) return null
  return { jpy, byCurrency }
}
