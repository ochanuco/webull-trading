import type { Env } from '../../config/env'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import {
  groupSymbolsByCategory,
  type QuoteResult,
  type WebullQuoteCategory,
} from '../../infrastructure/quotes/WebullQuoteClient'
import { YahooQuoteClient } from '../../infrastructure/quotes/YahooQuoteClient'
import type { QuoteSnapshot } from '../state/types'

/**
 * snapshot client が満たすべき shape (#21 follow-up)。Webull / Yahoo を
 * 並列で扱えるよう interface を抽出。`source` は QuoteSnapshot に転写され
 * dashboard / log で「今どの data source か」を区別可能にする。
 */
export interface SnapshotClient {
  readonly source: string
  getSnapshots(symbols: string[], category: WebullQuoteCategory): Promise<QuoteResult[]>
}

export interface QuoteRunSummary {
  fetched: number
  persisted: number
  skipped: string[]
  errors: Array<{ category: WebullQuoteCategory; message: string }>
  /** 実際に使われた snapshot source (`'yahoo-snapshot'` / `'webull-snapshot'`)。 */
  source: string
}

interface RunQuoteFeedOptions {
  env: Env
  client?: SnapshotClient
  now?: () => Date
}

/**
 * Fetches latest snapshots for every symbol in ALLOWED_SYMBOLS and writes the
 * result into each symbol's Durable Object. Called from the Workers cron
 * handler so strategy logic can read {@link QuoteSnapshot} with an `asOf` <
 * maxAgeMs freshness guard.
 */
export async function runQuoteFeed(options: RunQuoteFeedOptions): Promise<QuoteRunSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const universe = await loadSymbolUniverse(env)
  const symbols = universe.allowedSymbols

  // default は Yahoo Finance (#21 follow-up)。Webull JP の market-data API
  // (`data-api.webull.co.jp`) がまだ運用開始してない (DNS は存在するが TCP 無応答
  // + `api.webull.co.jp/openapi/market-data/*` が 404) ので、運用開始するまでは
  // Yahoo 経由で snapshot を取る。Webull market-data が live になったら caller
  // 側で `WebullQuoteClient` を `options.client` に渡せば切替可能。
  const client: SnapshotClient = options.client ?? new YahooQuoteClient({ now })

  const summary: QuoteRunSummary = {
    fetched: 0,
    persisted: 0,
    skipped: [],
    errors: [],
    source: client.source,
  }
  if (symbols.length === 0) return summary

  const { grouped, unsupported } = groupSymbolsByCategory(symbols)
  const fetchedAt = now().toISOString()

  // `groupSymbolsByCategory` は Webull の制約 (JP snapshot endpoint なし) で
  // JP 銘柄を `unsupported` に分類する。Yahoo は `.T` suffix で JP も普通に
  // 取得できるので、Yahoo 経路では unsupported を fetch 対象に戻す。
  // Webull 経路では従来通り skip (CodeRabbit #334)。
  const clientSupportsJp = client.source !== 'webull-snapshot'
  if (clientSupportsJp) {
    // Yahoo (or 将来の同等 client): unsupported (= JP) を US_STOCK に混ぜて投げる。
    // category は Yahoo 側で ignore されるので分類は便宜上のもの。
    if (unsupported.length > 0) {
      grouped.US_STOCK.push(...unsupported)
    }
  } else {
    // Webull: JP snapshot は依然 unsupported。summary に "known unfetchable"
    // として残す (silent drop を避ける)。
    for (const symbol of unsupported) summary.skipped.push(symbol)
  }

  for (const [category, group] of Object.entries(grouped) as Array<[WebullQuoteCategory, string[]]>) {
    if (group.length === 0) continue
    let results: QuoteResult[]
    try {
      results = await client.getSnapshots(group, category)
    } catch (error) {
      summary.errors.push({
        category,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const bySymbol = new Map(results.map((r) => [r.symbol, r]))
    summary.fetched += results.length

    for (const symbol of group) {
      const result = bySymbol.get(symbol)
      if (!result) {
        summary.skipped.push(symbol)
        continue
      }
      const quote: QuoteSnapshot = {
        price: result.price,
        asOf: result.asOf,
        fetchedAt,
        // `client.source` から取る ('yahoo-snapshot' / 'webull-snapshot')。
        // hardcoded constant をやめ、実際に使った client から動的に取る事で
        // 切替時の source 漏れを防ぐ。
        source: client.source,
      }
      if (result.bid !== undefined) quote.bid = result.bid
      if (result.ask !== undefined) quote.ask = result.ask
      try {
        const stub = env.SYMBOL_STATE.get(env.SYMBOL_STATE.idFromName(symbol))
        if (!stub) {
          summary.errors.push({ category, message: `Failed to get DO stub for ${symbol}` })
          continue
        }
        await stub.setQuote(symbol, quote)
        summary.persisted += 1
      } catch (error) {
        summary.errors.push({
          category,
          message: `Failed to persist ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  return summary
}