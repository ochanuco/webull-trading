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
  /** primary の snapshot source (`'yahoo-snapshot'` / `'webull-snapshot'`)。 */
  source: string
  /**
   * Yahoo fallback 経由で取得した銘柄 (#475)。primary=webull のとき、JP 銘柄
   * (Webull snapshot 非対応) と Webull 障害時のリカバリがここに入る。各 quote の
   * `QuoteSnapshot.source` は実際に使った client の値なので、spread guard は
   * fallback 分を Yahoo として (= bid/ask 無しを許容して) 評価する。
   */
  fallbackSymbols: string[]
}

interface RunQuoteFeedOptions {
  env: Env
  client?: SnapshotClient
  /** test seam。primary=webull のときの Yahoo fallback を差し替える。 */
  fallbackClient?: SnapshotClient
  now?: () => Date
}

/**
 * `QUOTE_SOURCE` env による primary client の選択 (#475)。
 *   - `'webull'`: Market Data API (trade host + v2、PR #474 で稼働実証)。
 *     bid/ask 付き snapshot で spread guard (issue #411) が実数評価になる。
 *   - それ以外 / 未設定: Yahoo (PR #334 以来の現行 default)。**fail-safe 側が
 *     既定** — 切替は env の明示 opt-in のみ。
 */
async function selectSnapshotClient(env: Env, now: () => Date): Promise<SnapshotClient> {
  if ((env.QUOTE_SOURCE ?? '').trim().toLowerCase() === 'webull') {
    // Phase B token (DO 優先)。失敗しても client は構築する — 署名は通り
    // token 無しで broker が拒否すれば per-category エラー → Yahoo fallback。
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
 * primary=webull のときの fallback 設計 (#475、fail-safe):
 *   - JP 銘柄は Webull snapshot 非対応 → 最初から Yahoo で取得
 *   - Webull の category fetch が throw → 同じ group を Yahoo で再試行
 *   - Yahoo まで失敗した group はエラー記録のみ (quote は前回値のまま →
 *     freshness guard が entry を止める。exit は止めない既存設計)
 */
export async function runQuoteFeed(options: RunQuoteFeedOptions): Promise<QuoteRunSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const universe = await loadSymbolUniverse(env)
  const symbols = universe.allowedSymbols

  const client: SnapshotClient = options.client ?? (await selectSnapshotClient(env, now))
  // Yahoo fallback は primary が Webull のときだけ用意する (Yahoo primary の
  // fallback 先は存在しない)。
  const fallbackClient: SnapshotClient | null =
    client.source === WEBULL_QUOTE_SOURCE
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

  // fetch 単位のジョブ列。primary が JP を扱えない場合、JP 銘柄は Yahoo
  // fallback のジョブとして積む (従来は skip して quote が更新されなかった)。
  const jobs: Array<{
    client: SnapshotClient
    category: WebullQuoteCategory
    symbols: string[]
    isFallback: boolean
  }> = []

  const clientSupportsJp = client.source !== WEBULL_QUOTE_SOURCE
  if (clientSupportsJp) {
    // Yahoo (or 将来の同等 client): unsupported (= JP) を US_STOCK に混ぜて投げる。
    // category は Yahoo 側で ignore されるので分類は便宜上のもの。
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
      // primary の障害は Yahoo で同 group を再試行 (#475)。fallback 自身の
      // 失敗は再試行しない (二重 fallback 無し)。
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
        // 実際に fetch に使った client から取る ('yahoo-snapshot' /
        // 'webull-snapshot')。fallback 時は Yahoo になり、spread guard は
        // bid/ask 無しを「仕様」として扱う (issue #411 の source 判定)。
        source: usedClient.source,
      }
      if (result.bid !== undefined) quote.bid = result.bid
      if (result.ask !== undefined) quote.ask = result.ask
      if (usedClient !== job.client || job.isFallback) summary.fallbackSymbols.push(symbol)
      try {
        const stub = env.SYMBOL_STATE.get(env.SYMBOL_STATE.idFromName(symbol))
        if (!stub) {
          summary.errors.push({ category: job.category, message: `Failed to get DO stub for ${symbol}` })
          continue
        }
        await stub.setQuote(symbol, quote)
        summary.persisted += 1
      } catch (error) {
        summary.errors.push({
          category: job.category,
          message: `Failed to persist ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  return summary
}
