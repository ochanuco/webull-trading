// 買付余力の共有プール pre-trade ゲート (#415)。
//
// budget 配分は各銘柄を口座共有プール (円) に対する % で sizing するが、発注時に
// 実際の買付余力を見ていないと、複数銘柄の合算が実余力を超えて Webull が約定前に
// 417 (Insufficient Buying Power) で拒否する。本モジュールは Webull Account Balance
// から得た **JPY 基準の買付余力**を 1 tick 分の「台帳 (ledger)」として持ち、scheduler が
// 発注ごとに残余力を予約 (decrement) して超過注文を pre-trade で reject できるようにする。
//
// fail-safe: 余力が取得できない/異常な tick は `unavailable` 台帳にして当 tick の BUY を
// 全見送り (fail-closed)。誤った余力で過大発注しない。Webull 自体の 417 は最終防壁 (二重)。

import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'

/** sizing→fill 間の値動き / 手数料 / 端数を吸収する既定の安全バッファ (1%)。 */
export const DEFAULT_BUYING_POWER_BUFFER_PCT = 0.01

export interface BuyingPowerLedger {
  /** `ok` = 余力取得済で予約可能。`unavailable` = 取得失敗 → BUY 全 reject。 */
  status: 'ok' | 'unavailable'
  /** 残余力 (JPY 基準、安全バッファ適用後)。`unavailable` 時は 0。 */
  remainingJpy: number
  /** 取得時刻 (ISO)。dashboard 表示用。 */
  asOf: string | null
  /** 取得元ラベル (例 'webull-balance')。 */
  source: string
  /** `unavailable` の理由 (dashboard / log 用)。 */
  reason?: string
  /**
   * `notionalJpy` (JPY 基準) を予約する。`ok` かつ残余力で賄えるなら減算して true、
   * それ以外は false (= 発注見送り)。非有限/非正の notional も false。
   */
  tryReserve(notionalJpy: number): boolean
  /** 予約後に submit が失敗した時、予約を戻す (他銘柄判定を歪めないため)。 */
  refund(notionalJpy: number): void
}

/** 取得失敗 tick 用。常に予約失敗 = 当 tick の BUY を全 fail-closed。 */
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

/** 取得成功 tick 用。`availableJpy` に安全バッファを掛けた額を残余力の初期値にする。 */
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
 * Webull Account Balance から **JPY 基準の合計買付余力**を算出する。`account_currency_assets[]`
 * の通貨別 `buying_power` を JPY に換算して合算する (USD は `usdJpyRate` で換算)。
 *
 * 算出不能なら **null (= 呼び出し側で fail-closed)**:
 *   - 配列が無い / 空
 *   - いずれかの buying_power が非有限 / 負 (異常値)
 *   - USD 等の非 JPY 通貨に余力があるのに `usdJpyRate` が無効 (誤換算で過大発注しない)
 *   - JPY/USD 以外の通貨に余力がある (未対応通貨は安全側で fail-closed)
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
    if (!Number.isFinite(bp) || bp < 0) return null // 異常値 → fail-closed
    byCurrency[ccy] = bp
    if (ccy === 'JPY') {
      jpy += bp
    } else if (ccy === 'USD') {
      if (bp > 0) {
        if (!fxOk) return null // USD 余力ありだが FX 取得失敗 → fail-closed
        jpy += bp * (usdJpyRate as number)
      }
    } else if (bp > 0) {
      return null // 未対応通貨に余力 → fail-closed
    }
  }
  if (!Number.isFinite(jpy) || jpy < 0) return null
  return { jpy, byCurrency }
}
