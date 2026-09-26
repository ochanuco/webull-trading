import type { Env } from '../../config/env'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import {
  WEBULL_QUOTE_SOURCE,
  createWebullQuoteClient,
  groupSymbolsByCategory,
  type QuoteResult,
  type WebullQuoteCategory,
} from '../../infrastructure/quotes/WebullQuoteClient'
import { YahooQuoteClient } from '../../infrastructure/quotes/YahooQuoteClient'
import { resolveAccessToken } from '../../infrastructure/webull/resolveAccessToken'
import type { QuoteSnapshot } from '../state/types'

/** Shape both Webull and Yahoo snapshot clients implement; `source` flows into `QuoteSnapshot` so dashboards/logs can tell which one served a quote. */
export interface SnapshotClient {
  readonly source: string
  getSnapshots(symbols: string[], category: WebullQuoteCategory): Promise<QuoteResult[]>
}

export interface QuoteFeedError {
  category: WebullQuoteCategory
  message: string
  /** Set only for a per-symbol failure (DO stub lookup / setQuote); a category-level fetch throw leaves this unset. */
  symbol?: string
}

export interface QuoteRunSummary {
  fetched: number
  persisted: number
  skipped: string[]
  errors: QuoteFeedError[]
  /** Primary snapshot source (`'yahoo-snapshot'` / `'webull-snapshot'`). */
  source: string
  /**
   * Symbols served via the Yahoo fallback (JP symbols Webull can't quote,
   * plus Webull-failure recovery, when primary=webull). Each quote's own
   * `QuoteSnapshot.source` carries the client actually used.
   */
  fallbackSymbols: string[]
}

interface RunQuoteFeedOptions {
  env: Env
  client?: SnapshotClient
  /** Test seam: overrides the Yahoo fallback used when primary=webull. */
  fallbackClient?: SnapshotClient
  now?: () => Date
}

/**
 * Selects the primary client by `QUOTE_SOURCE`: `'webull'` gets bid/ask
 * snapshots (real-number spread guard); anything else, including unset,
 * defaults to Yahoo — fail-safe, so switching needs an explicit env opt-in.
 */
async function selectSnapshotClient(env: Env, now: () => Date): Promise<SnapshotClient> {
  if ((env.QUOTE_SOURCE ?? '').trim().toLowerCase() === 'webull') {
    // Still builds the client on token failure — signing works without a
    // token, and the broker then rejects per category, triggering Yahoo fallback.
    const accessToken = await resolveAccessToken(env).catch(() => undefined)
    return createWebullQuoteClient(env, {
      now,
      ...(accessToken !== undefined ? { accessToken } : {}),
    })
  }
  return new YahooQuoteClient({ now })
}

/**
 * Fetches latest snapshots for every symbol in ALLOWED_SYMBOLS and writes the
 * result into each symbol's Durable Object. Called from the Workers cron
 * handler so strategy logic can read {@link QuoteSnapshot} with an `asOf` <
 * maxAgeMs freshness guard.
 *
 * With primary=webull: JP symbols go straight to Yahoo (Webull can't quote
 * them), a Webull category fetch that throws retries once on the same
 * group via Yahoo, and a group that fails there too is left at its previous
 * quote — the freshness guard then blocks new entries but not exits.
 */
export async function runQuoteFeed(options: RunQuoteFeedOptions): Promise<QuoteRunSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const universe = await loadSymbolUniverse(env)
  const symbols = universe.allowedSymbols

  const client: SnapshotClient = options.client ?? (await selectSnapshotClient(env, now))
  const isWebullPrimary = client.source === WEBULL_QUOTE_SOURCE
  const fallbackClient: SnapshotClient | null = isWebullPrimary
    ? (options.fallbackClient ?? new YahooQuoteClient({ now }))
    : null

  const summary: QuoteRunSummary = {
    fetched: 0,
    persisted: 0,
    skipped: [],
    errors: [],
    source: client.source,
    fallbackSymbols: [],
  }
  if (symbols.length === 0) return summary

  const { grouped, unsupported } = groupSymbolsByCategory(symbols)
  const fetchedAt = now().toISOString()

  const jobs: Array<{
    client: SnapshotClient
    category: WebullQuoteCategory
    symbols: string[]
    isFallback: boolean
  }> = []

  if (!isWebullPrimary) {
    // Yahoo ignores `category`, so unsupported (JP) symbols can just ride
    // along in the US_STOCK job instead of needing their own.
    if (unsupported.length > 0) {
      grouped.US_STOCK.push(...unsupported)
    }
  } else if (fallbackClient && unsupported.length > 0) {
    jobs.push({ client: fallbackClient, category: 'US_STOCK', symbols: unsupported, isFallback: true })
  } else {
    for (const symbol of unsupported) summary.skipped.push(symbol)
  }

  for (const [category, group] of Object.entries(grouped) as Array<[WebullQuoteCategory, string[]]>) {
    if (group.length === 0) continue
    jobs.push({ client, category, symbols: group, isFallback: false })
  }

  for (const job of jobs) {
    let results: QuoteResult[]
    let usedClient = job.client
    try {
      results = await job.client.getSnapshots(job.symbols, job.category)
    } catch (error) {
      summary.errors.push({
        category: job.category,
        message: error instanceof Error ? error.message : String(error),
      })
      // Retries a primary failure once via Yahoo; a fallback job's own
      // failure does not retry (no double fallback).
      if (job.isFallback || fallbackClient === null || job.client === fallbackClient) continue
      try {
        usedClient = fallbackClient
        results = await fallbackClient.getSnapshots(job.symbols, job.category)
      } catch (fallbackError) {
        summary.errors.push({
          category: job.category,
          message: `fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        })
        continue
      }
    }

    const bySymbol = new Map(results.map((r) => [r.symbol, r]))
    summary.fetched += results.length

    for (const symbol of job.symbols) {
      const result = bySymbol.get(symbol)
      if (!result) {
        summary.skipped.push(symbol)
        continue
      }
      const quote: QuoteSnapshot = {
        price: result.price,
        asOf: result.asOf,
        fetchedAt,
        // The client that actually served this quote, not the job's primary
        // — on fallback this is Yahoo, and the spread guard treats a
        // missing bid/ask from that source as expected, not an error.
        source: usedClient.source,
      }
      if (result.bid !== undefined) quote.bid = result.bid
      if (result.ask !== undefined) quote.ask = result.ask
      if (usedClient !== job.client || job.isFallback) summary.fallbackSymbols.push(symbol)
      try {
        const stub = env.SYMBOL_STATE.get(env.SYMBOL_STATE.idFromName(symbol))
        if (!stub) {
          summary.errors.push({ category: job.category, symbol, message: `Failed to get DO stub for ${symbol}` })
          continue
        }
        await stub.setQuote(symbol, quote)
        summary.persisted += 1
      } catch (error) {
        summary.errors.push({
          category: job.category,
          symbol,
          message: `Failed to persist ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  return summary
}
