import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'

/**
 * `WebullAccountBalanceDto.account_currency_assets` から USD 建て資産
 * (`cash_balance + market_value`) を抽出する純関数 (#EOD equity auto-seed)。
 *
 * `dailyStartEquity` は USD 建てのため、JPY エントリは常に無視する
 * (JPY を混ぜると通貨単位が混在し、円建て値が USD 分母として drawdown risk
 * gate に食われる事故が再発する — 本 issue の発端そのもの)。
 *
 * fail-safe: 以下のいずれかに該当すれば呼び出し側が re-seed を skip できる
 * よう `null` を返す (捏造しない、roll 済みの値を維持させる)。
 *   - `account_currency_assets` が無い / 空配列
 *   - USD エントリが無い (currency は trim + upper-case で正規化して比較)
 *   - `market_value` が欠落 (v1 `/openapi/account/balance` は `market_value` を
 *     返さない仕様 — `WebullAccountCurrencyAssetDto` 参照。v1 のみ稼働している
 *     環境では常に null になり、旧経路の手動 seed が維持される)
 *   - `cash_balance` / `market_value` のいずれかが非有限 (NaN/Infinity) または負
 *   - 合計が 0 以下 (0 は「未 seed」扱いの fallback 経路と衝突するため異常値
 *     として扱う)
 */
export function usdEquityFromBalance(balance: WebullAccountBalanceDto): number | null {
  const assets = balance.account_currency_assets
  if (!assets || assets.length === 0) return null

  const usdAsset = assets.find(
    (asset) => asset.currency?.trim().toUpperCase() === 'USD',
  )
  if (!usdAsset) return null

  if (usdAsset.market_value === undefined) return null

  const cash = Number(usdAsset.cash_balance)
  const marketValue = Number(usdAsset.market_value)
  if (!Number.isFinite(cash) || cash < 0) return null
  if (!Number.isFinite(marketValue) || marketValue < 0) return null

  const total = cash + marketValue
  if (total <= 0) return null

  return total
}
