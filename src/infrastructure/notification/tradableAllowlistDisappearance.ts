import type { WebullPositionDto } from '../webull/dto'

export interface HeldTradableDisappearance {
  symbol: string
  qty: number
}

export function findHeldTradableDisappearances(
  disappearedSymbols: string[],
  positions: WebullPositionDto[],
): HeldTradableDisappearance[] {
  const disappeared = new Set(disappearedSymbols.map((symbol) => symbol.toUpperCase()))

  return positions.flatMap((position) => {
    const symbol = (position.symbol ?? '').toUpperCase()
    if (!symbol || !disappeared.has(symbol)) return []

    const rawQty = position.quantity ?? position.quantity_total
    const qty = Number(rawQty)
    if (!Number.isFinite(qty) || qty <= 0) return []

    return [{ symbol, qty }]
  })
}

export function formatHeldTradableDisappearanceMessage(
  held: HeldTradableDisappearance[],
): string {
  const rows = held.map(({ symbol, qty }) => `${symbol} ${formatQty(qty)}株`)
  return [
    'Webull取扱銘柄の変化',
    '',
    '取扱リストから消失した保有銘柄があります',
    ...rows,
  ].join('\n')
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : qty.toString()
}
