import type { Env } from '../../config/env'
import type { WebullAccountBalanceDto } from './dto'
import { resolveAccessToken } from './resolveAccessToken'
import { createWebullReadClient } from './WebullReadClient'

/**
 * Extracts USD-denominated equity (`cash_balance + market_value`) from the
 * USD entry in `account_currency_assets`. JPY entries are always ignored —
 * `dailyStartEquity` is USD-denominated, and mixing in JPY would corrupt the
 * risk gate's drawdown denominator.
 *
 * Returns `null` (never a fabricated value) on any ambiguous input: missing
 * assets, no USD entry, missing `market_value` (the v1 balance shape doesn't
 * return it), non-finite/negative amounts, or a total ≤ 0 (0 is reserved for
 * the "not yet seeded" fallback path). Callers skip the re-seed and keep the
 * last rolled value.
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

/**
 * Live path for {@link usdEquityFromBalance}: resolves the token, fetches
 * the balance, and normalizes it — keeps the raw Webull DTO out of the
 * trading layer. Token/fetch failures throw (caller `runPortfolioRoll`
 * catches as `broker_fetch_failed`); a 200 that can't be parsed to USD
 * returns `null`, same as `usdEquityFromBalance`.
 */
export async function fetchUsdEquity(env: Env): Promise<number | null> {
  const accessToken = await resolveAccessToken(env)
  const readClient = createWebullReadClient(env, { accessToken })
  const balance = await readClient.getAccountBalance()
  return usdEquityFromBalance(balance)
}
