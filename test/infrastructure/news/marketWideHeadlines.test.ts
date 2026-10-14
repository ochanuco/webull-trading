import { describe, expect, it } from 'vitest'
import { isMarketWideHeadline, selectMarketWideHeadlines } from '../../../src/infrastructure/news/marketWideHeadlines'

describe('isMarketWideHeadline', () => {
  it.each([
    'Disney (DIS): Buy, Sell, or Hold Post Q2 Earnings?',
    '3 Reasons to Avoid SAIA and 1 Stock to Buy Instead',
    '2 Reasons to Watch CDNS and 1 to Stay Cautious',
    'Is Okta (OKTA) the Hidden AI Play in Enterprise Software?',
  ])('単一銘柄・リスト記事の見出しは除外する: %s', (title) => {
    expect(isMarketWideHeadline(title)).toBe(false)
  })

  it.each([
    'CPI Inflation Overshoots, Putting Fed Hike In Play; S&P 500 Futures Fall, Yields Jump (Live Coverage)',
    'Stock Market Today: Nasdaq Sinks On Hot Inflation Data; ASML Seesaws (Live Coverage)',
    'U.S. Stock Futures Fall on Hot Inflation Data',
    "Update: Equity Indexes Fall Intraday as Fed's Waller Says More Rate Hikes Needed",
  ])('市場全体の見出しは残す: %s', (title) => {
    expect(isMarketWideHeadline(title)).toBe(true)
  })

  it('市場語を含まない見出しは除外する', () => {
    expect(isMarketWideHeadline('Apple unveils new phone')).toBe(false)
  })
})

describe('selectMarketWideHeadlines', () => {
  it('市場全体の見出しだけを順序を保って返す', () => {
    const keep = { title: 'U.S. Stock Futures Fall on Hot Inflation Data', source: 'Y', publishedAt: null }
    const drop = { title: '3 Reasons to Avoid SAIA and 1 Stock to Buy Instead', source: 'Y', publishedAt: null }
    expect(selectMarketWideHeadlines([drop, keep])).toEqual([keep])
  })
})
