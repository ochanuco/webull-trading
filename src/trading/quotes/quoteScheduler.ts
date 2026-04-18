import type { Env } from '../../config/env'
import { parseCsvEnv } from '../../config/env'
import {
  groupSymbolsByCategory,
  WebullQuoteClient,
  createWebullQuoteClient,
  type QuoteResult,
  type WebullQuoteCategory,
} from '../../infrastructure/quotes/WebullQuoteClient'
import type { QuoteSnapshot } from '../state/types'

const QUOTE_SOURCE = 'webull-snapshot'

export interface QuoteRunSummary {
  fetched: number
  persisted: number
  skipped: string[]
  errors: Array<{ category: WebullQuoteCategory; message: string }>
}

interface RunQuoteFeedOptions {
  env: Env
  client?: WebullQuoteClient
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
  const symbols = parseCsvEnv(env.ALLOWED_SYMBOLS)

  const summary: QuoteRunSummary = { fetched: 0, persisted: 0, skipped: [], errors: [] }
  if (symbols.length === 0) return summary

  const client = options.client ?? createWebullQuoteClient(env, { now })
  const groups = groupSymbolsByCategory(symbols)
  const fetchedAt = now().toISOString()

  for (const [category, group] of Object.entries(groups) as Array<[WebullQuoteCategory, string[]]>) {
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
        source: QUOTE_SOURCE,
      }
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