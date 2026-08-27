import { describe, expect, it } from 'vitest'
import {
  findHeldTradableDisappearances,
  formatHeldTradableDisappearanceMessage,
} from '../../../src/infrastructure/notification/tradableAllowlistDisappearance'
import type { WebullPositionDto } from '../../../src/infrastructure/webull/dto'

describe('tradable allowlist disappearance notification', () => {
  it('keeps only disappeared symbols that are currently held', () => {
    const positions: WebullPositionDto[] = [
      { symbol: 'OSRH', quantity: '0' },
      { symbol: 'VMAR', quantity: '20' },
      { symbol: 'FLZH', quantity_total: '3' },
      { symbol: 'AAPL', quantity: '5' },
    ]

    expect(findHeldTradableDisappearances(['OSRH', 'VMAR', 'FLZH'], positions)).toEqual([
      { symbol: 'VMAR', qty: 20 },
      { symbol: 'FLZH', qty: 3 },
    ])
  })

  it('returns no notification targets when disappeared symbols are not held', () => {
    const positions: WebullPositionDto[] = [
      { symbol: 'OSRH', quantity: '0' },
      { symbol: 'AAPL', quantity: '5' },
    ]

    expect(findHeldTradableDisappearances(['OSRH', 'VMAR'], positions)).toEqual([])
  })

  it('formats a concise human-facing message with quantities', () => {
    expect(
      formatHeldTradableDisappearanceMessage([
        { symbol: 'VMAR', qty: 20 },
        { symbol: 'FLZH', qty: 3 },
      ]),
    ).toBe(
      'Webull取扱銘柄の変化\n\n取扱リストから消失した保有銘柄があります\nVMAR 20株\nFLZH 3株',
    )
  })
})
