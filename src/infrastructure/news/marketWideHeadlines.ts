import type { RssHeadline } from './rssHeadlineParser'

const NOISE =
  /buy, sell,? or hold|\d reasons?\b|reasons to (avoid|sell|buy)|stock to buy|stocks? to buy|\([A-Z.]{1,5}\):|\([A-Z.]{1,5}\) |^is .* stock|stock ready|prediction:|should you|better buy|no-brainer|etfs? worth|dividend (stock|etf)|^(a|\d+) (year|month)s? ago|could soar|soar after|lost one third|breaks? out|premarket movers/i

const MARKET =
  /stock market|s&p 500|nasdaq|\bdow\b|dow jones|wall street|futures|equity futures|\bcpi\b|inflation|\bfed\b|fomc|yields?|treasur|sell-?off|\brout\b|plunge|tumble|rally|stocks (fall|slide|slip|drop|rise|climb|sink|sag|rally|tumble|jump|surge|slump)|volatility|vix|tariff|jobs report|payrolls|rate (hike|cut)|indexes|markets?\b/i

export function isMarketWideHeadline(title: string): boolean {
  return MARKET.test(title) && !NOISE.test(title)
}

export function selectMarketWideHeadlines(headlines: RssHeadline[]): RssHeadline[] {
  return headlines.filter((h) => isMarketWideHeadline(h.title))
}
