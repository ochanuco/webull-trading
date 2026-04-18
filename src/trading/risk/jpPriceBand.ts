/**
 * 東京証券取引所の daily price band (値幅制限) を粗く近似したテーブル。
 *
 * 正確な table は TSE 公式 (https://www.jpx.co.jp/equities/trading/domestic/03.html)
 * が銘柄ごと・呼値単位で定義しているが、POC では reference price level から
 * 一意に決まる static approximation で十分としている。後続 PR で Webull feed
 * から取れるようなら差し替える。
 *
 * 各エントリは `{ upTo: basePrice, band: 値幅 }` で、reference price が
 * `upTo` 以下なら `band` が適用される。
 */
interface JpPriceBandRow {
  upTo: number
  band: number
}

const JP_PRICE_BAND_TABLE: readonly JpPriceBandRow[] = [
  { upTo: 100, band: 30 },
  { upTo: 200, band: 50 },
  { upTo: 500, band: 80 },
  { upTo: 700, band: 100 },
  { upTo: 1_000, band: 150 },
  { upTo: 1_500, band: 300 },
  { upTo: 2_000, band: 400 },
  { upTo: 3_000, band: 500 },
  { upTo: 5_000, band: 700 },
  { upTo: 7_000, band: 1_000 },
  { upTo: 10_000, band: 1_500 },
  { upTo: 15_000, band: 3_000 },
  { upTo: 20_000, band: 4_000 },
  { upTo: 30_000, band: 5_000 },
  { upTo: 50_000, band: 7_000 },
  { upTo: 70_000, band: 10_000 },
  { upTo: 100_000, band: 15_000 },
  { upTo: 150_000, band: 30_000 },
  { upTo: 200_000, band: 40_000 },
  { upTo: 300_000, band: 50_000 },
  { upTo: 500_000, band: 70_000 },
  { upTo: 700_000, band: 100_000 },
  { upTo: 1_000_000, band: 150_000 },
  { upTo: 1_500_000, band: 300_000 },
  { upTo: 2_000_000, band: 400_000 },
  { upTo: 3_000_000, band: 500_000 },
  { upTo: 5_000_000, band: 700_000 },
  { upTo: 7_000_000, band: 1_000_000 },
  { upTo: 10_000_000, band: 1_500_000 },
] as const

// 10,000,000 円を超える reference price は POC 範囲外として "無制限 = 一律大きい値"
// を返す。RHS を Infinity にしないのは downstream で加減算されるため。
const EXTREME_PRICE_FALLBACK_BAND = 3_000_000

/**
 * reference price に対する upper/lower 値幅バンドを返す。
 * 正の reference price のみを受け付ける (fail-closed: それ以外は 0 バンド)。
 */
export function jpPriceBand(referencePrice: number): { upper: number; lower: number } {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { upper: referencePrice, lower: referencePrice }
  }

  const band = lookupBand(referencePrice)
  return {
    upper: referencePrice + band,
    lower: Math.max(0, referencePrice - band),
  }
}

/**
 * orderPrice が jpPriceBand(referencePrice) の [lower, upper] 内に収まるか。
 * reference price が不正 (<=0) なときは true (band check 無効) を返す。
 */
export function isWithinJpPriceBand(referencePrice: number, orderPrice: number): boolean {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return true
  }
  if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
    return false
  }
  const { upper, lower } = jpPriceBand(referencePrice)
  return orderPrice >= lower && orderPrice <= upper
}

function lookupBand(referencePrice: number): number {
  for (const row of JP_PRICE_BAND_TABLE) {
    if (referencePrice <= row.upTo) return row.band
  }
  return EXTREME_PRICE_FALLBACK_BAND
}
