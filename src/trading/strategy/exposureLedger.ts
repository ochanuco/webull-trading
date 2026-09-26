// One ledger shared across a whole cron tick's BUY pass, not recomputed per
// symbol: recomputing independently (as manual /trade/execute does) would
// let a later symbol in the same tick miss an earlier symbol's reservation
// and blow the portfolio exposure ceiling (global_config.max_portfolio_exposure_pct).

export interface ExposureLedger {
  /** `unavailable` means the ceiling couldn't be computed, so every reservation fails closed. */
  status: 'ok' | 'unavailable'
  remainingJpy: number
  ceilingJpy: number
  /** Current position value in JPY at tick start; diagnostic only. */
  currentJpy: number
  /** Set when `status` is `unavailable`; surfaced to dashboard/logs. */
  reason?: string
  /** Reserves `notionalJpy` if `status` is `ok` and it fits in the remaining budget. */
  tryReserve(notionalJpy: number): boolean
  /** Reverses a reservation after a submit fails, so it doesn't skew later symbols in the tick. */
  refund(notionalJpy: number): void
}

export function createUnavailableExposureLedger(reason: string): ExposureLedger {
  return {
    status: 'unavailable',
    remainingJpy: 0,
    ceilingJpy: 0,
    currentJpy: 0,
    reason,
    tryReserve() {
      return false
    },
    refund() {
      /* no-op */
    },
  }
}

export function createExposureLedger(opts: { ceilingJpy: number; currentJpy: number }): ExposureLedger {
  const ceilingJpy = Number.isFinite(opts.ceilingJpy) && opts.ceilingJpy > 0 ? opts.ceilingJpy : 0
  const currentJpy = Number.isFinite(opts.currentJpy) && opts.currentJpy >= 0 ? opts.currentJpy : 0
  const ledger: ExposureLedger = {
    status: 'ok',
    remainingJpy: Math.max(0, ceilingJpy - currentJpy),
    ceilingJpy,
    currentJpy,
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
