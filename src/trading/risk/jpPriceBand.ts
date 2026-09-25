// TSE の daily price band (値幅制限) は本来銘柄・呼値単位だが、POC では
// reference price のみから引ける静的近似テーブルで代用する。
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

// 10,000,000 円超は POC 範囲外として大きな固定値を返す (Infinity だと downstream
// の加減算結果が壊れるため有限値にしている)。
const EXTREME_PRICE_FALLBACK_BAND = 3_000_000

/** 不正な reference price (<=0 / 非有限) は fail-closed で zero バンドを返す。 */
export function jpPriceBand(referencePrice: number): { upper: number; lower: number } {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { upper: 0, lower: 0 }
  }

  const band = lookupBand(referencePrice)
  return {
    upper: referencePrice + band,
    lower: Math.max(0, referencePrice - band),
  }
}

// referencePrice が不正 (比較基準なし) なときは fail-closed の false ではなく
// true (skip) を返す — band 判定不能を理由に BUY を弾かない。
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