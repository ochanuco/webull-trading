import type { DailyBar } from '../../trading/strategy/indicators'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { WebullAuth } from '../webull/WebullAuth'
import { inferWebullMarket } from '../webull/mapper'

// developer.webull.com shows `category=US_STOCK` on the wire (underscore).
// Python SDK's EasyEnum.__str__ returns `self.name` (the underscored
// identifier), and Java SDK passes `Category.US_STOCK.name()` the same way.
// JP_STOCK has no working HK-sandbox path — JP bars need a JP tenant (#89).
type BarCategory = 'US_STOCK' | 'US_ETF' | 'JP_STOCK'

// Mirrors WebullQuoteClient's US ETF allowlist.
const US_ETF_SYMBOLS = new Set<string>(['SOXL', 'SOXS'])

function resolveBarCategory(symbol: string): BarCategory {
  if (inferWebullMarket(symbol) === 'JP') return 'JP_STOCK'
  return US_ETF_SYMBOLS.has(symbol) ? 'US_ETF' : 'US_STOCK'
}

/**
 * 5/15/30/60 分足。Yahoo `/v8/finance/chart` の `interval` enum と一致。
 * 戦略 cron は最新 1h close を indicators.price として使うため `60m` を渡す。
 */
export type IntradayInterval = '5m' | '15m' | '30m' | '60m'

/**
 * Intraday OHLC bar。`timestamp` は秒精度の ISO UTC (Yahoo の epoch second を
 * `new Date(ts*1000).toISOString()` 化したもの)。
 */
export interface IntradayBar {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
}

export interface BarClient {
  getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]>
  /**
   * Optional intraday fetch。strategy cron が「当日最新 1h close」を fill 価格
   * として使う際に呼び出す。未実装の client (Webull 等) は省略可で、cron 側は
   * fallback して daily close を使う。
   */
  getIntradayBars?(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]>
}

interface WebullBarClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  /**
   * Quotes host (#21)。JP 本番では trade と分離 (`data-api.webull.co.jp`)。
   * JP UAT (ALB) では trade と同じ URL を入れる。未設定 / 空 / whitespace なら
   * JP prod default (`DEFAULT_QUOTES_API_BASE`) に fallback、env が explicit に
   * セットされてれば override。
   */
  WEBULL_QUOTES_API_BASE?: string
  /** 2FA 発行 `x-access-token` (#21)。詳細は `WebullClientEnv.WEBULL_ACCESS_TOKEN`。 */
  WEBULL_ACCESS_TOKEN?: string
  WEBULL_BARS_PATH?: string
}

interface WebullBarClientOptions {
  auth: WebullAuth
  baseUrl: string
  barsPath?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/**
 * Webull market-data bars client (daily + intraday)。path は env
 * (`WEBULL_BARS_PATH`) で override 可能、mapper は forgiving — close の無い
 * bar は throw せず drop する。
 *
 * 2026-05-22 に deprecated 化 (market-data 未稼働と誤認、PR #334 で Yahoo へ) →
 * **2026-06-11 に解除** (#475): Market Data API は trade host + x-version v2 で
 * 稼働中 (PR #474 実測)。`BAR_SOURCE=webull` のとき {@link FallbackBarClient}
 * 経由で primary になる。
 */
export class WebullBarClient implements BarClient {
  private readonly baseUrl: string
  private readonly barsPath: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: WebullBarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    // JP UAT tenant (jp-openapi-alb.uat.webullbroker.com) only exposes the
    // v2 bars endpoint at `/openapi/market-data/stock/bars`. The Java SDK's
    // v1 `/openapi/market-data/bars` returns 404 on this tenant. See #84
    // probe trace.
    this.barsPath = options.barsPath ?? '/openapi/market-data/stock/bars'
    this.timeoutMs = options.timeoutMs ?? 5_000
    // Workers の global `fetch` はメソッド呼び出し扱いで `this` を globalThis
    // にひも付けないと "Illegal invocation" で落ちる。明示的に bind しておく。
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    return normalizeBars(await this.requestBars(symbol, 'D', lookback))
  }

  /**
   * 最新の intraday bars (#475)。strategy cron が「当日最新 1h close」を fill
   * 価格に使う optional contract ({@link BarClient.getIntradayBars}) の Webull
   * 実装。v2 timespan enum は M5/M15/M30/M60。
   */
  async getIntradayBars(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]> {
    const timespan = { '5m': 'M5', '15m': 'M15', '30m': 'M30', '60m': 'M60' }[interval]
    // 消費側は最新 bar の close しか見ないが、Yahoo 実装が当日分を返すのに
    // 合わせて直近 8 本 (60m × 8 ≈ 1 営業日) を取る。
    return normalizeIntradayBars(await this.requestBars(symbol, timespan, 8))
  }

  private async requestBars(symbol: string, timespan: string, count: number): Promise<unknown> {
    const category = resolveBarCategory(symbol)
    // v2 stock/bars timespan enum (from probe 417 body):
    //   M1, M5, M15, M30, M60, M120, M240, D, W, M, Y
    // Daily = "D" (upper-case). Earlier `d1` yielded UNSUPPORTED_TIMESPAN.
    //
    // `real_time_required` は新 OpenAPI docs (#251) で required 扱い、default
    // `true`。サーバ側既定と同じ値を明示送信して、将来 default 変更があっても
    // 我々の挙動が動かないようにする (= 戦略 cron は real-time bar を期待する
    // ので false に倒す動機はない)。issue #255。
    const query = {
      symbol,
      category,
      timespan,
      count: String(count),
      real_time_required: 'true',
    }

    const url = new URL(this.barsPath, `${this.baseUrl}/`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

    let headers: Record<string, string>
    try {
      headers = await this.options.auth.createHeaders({
        method: 'GET',
        // Signing is path-only; query is merged into the canonical sorted pairs.
        // Passing `pathname + search` duplicates query params (same bug as #80).
        path: url.pathname,
        query,
        host: url.host,
        // v2 — v1 /market-data/bars is 404 on the JP UAT tenant.
        version: 'v2',
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull bar auth failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.barsPath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull bar fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.barsPath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Webull bar request failed with status ${response.status}`,
        `GET ${this.barsPath}`,
      )
    }

    return (await response.json()) as unknown
  }
}

/**
 * Webull JP **production** の Market Data API host (#475)。docs どおり trade
 * host と同一 (`WebullQuoteClient` と同じ)。旧値 `data-api.webull.co.jp` は
 * TCP 無応答で market-data を serve していなかった (PR #474 実測)。UAT
 * (1 ホスト束ね) は `WEBULL_QUOTES_API_BASE` env で override する。
 */
const DEFAULT_QUOTES_API_BASE = 'https://api.webull.co.jp'

function createWebullBarClient(
  env: WebullBarClientEnv,
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    /** Phase B: resolveAccessToken 由来の override (DO 優先)。 */
    accessToken?: string
  },
): WebullBarClient {
  // env 空 / undefined / whitespace は JP prod default。env が明示されてれば
  // override (UAT / 将来 region 用)。
  const baseUrl = env.WEBULL_QUOTES_API_BASE?.trim() || DEFAULT_QUOTES_API_BASE
  return new WebullBarClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
      accessToken: options?.accessToken ?? env.WEBULL_ACCESS_TOKEN,
    }),
    baseUrl,
    barsPath: env.WEBULL_BARS_PATH,
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs,
  })
}

interface RawBar {
  // v2 stock/bars returns `time` as ISO-with-offset, e.g.
  // "2026-04-17T04:00:00.000+0000". v1 and other surfaces use `date` or
  // `trade_time`. Accept all three.
  time?: string
  date?: string
  trade_time?: string
  open?: number | string
  high?: number | string
  low?: number | string
  close?: number | string
}

function normalizeBars(json: unknown): DailyBar[] {
  const rawList = extractList(json)
  const bars: DailyBar[] = []
  for (const raw of rawList) {
    const date = extractDate(raw)
    const open = toNumber(raw.open)
    const high = toNumber(raw.high)
    const low = toNumber(raw.low)
    const close = toNumber(raw.close)
    if (!date || open === null || high === null || low === null || close === null) continue
    bars.push({ date, open, high, low, close })
  }
  // Ensure oldest-first for downstream indicators.
  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}

function extractDate(raw: RawBar): string {
  // Prefer a full `date` string when present, else derive YYYY-MM-DD from
  // `time` / `trade_time` by taking the leading 10 chars. All three shapes
  // have been observed in the wild depending on the endpoint version.
  if (typeof raw.date === 'string' && raw.date.length >= 10) return raw.date
  if (typeof raw.time === 'string' && raw.time.length >= 10) return raw.time.slice(0, 10)
  if (typeof raw.trade_time === 'string' && raw.trade_time.length >= 10) return raw.trade_time.slice(0, 10)
  return ''
}

function extractList(json: unknown): RawBar[] {
  if (Array.isArray(json)) return json as RawBar[]
  if (json && typeof json === 'object') {
    const data = (json as { data?: unknown }).data
    if (Array.isArray(data)) return data as RawBar[]
  }
  return []
}

function toNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeIntradayBars(json: unknown): IntradayBar[] {
  const rawList = extractList(json)
  const bars: IntradayBar[] = []
  for (const raw of rawList) {
    const timestamp = extractTimestamp(raw)
    const open = toNumber(raw.open)
    const high = toNumber(raw.high)
    const low = toNumber(raw.low)
    const close = toNumber(raw.close)
    if (!timestamp || open === null || high === null || low === null || close === null) continue
    bars.push({ timestamp, open, high, low, close })
  }
  // oldest-first — 消費側 (pullbackScheduler) は「最後の bar = 最新」を前提。
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return bars
}

function extractTimestamp(raw: RawBar): string {
  // v2 は "2026-04-17T04:00:00.000+0000" 形式。ISO UTC (秒精度) に正規化して
  // Yahoo 実装 (`new Date(ts*1000).toISOString()`) と同じ shape を返す。
  const value = raw.time ?? raw.trade_time ?? raw.date
  if (typeof value !== 'string' || value.length < 10) return ''
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

// ---------------------------------------------------------------------------
// #475: BAR_SOURCE 切替と Webull primary + Yahoo fallback の composite。
// ---------------------------------------------------------------------------

import { YahooBarClient } from './YahooBarClient'
import { resolveAccessToken } from '../webull/resolveAccessToken'
import type { Env } from '../../config/env'

/**
 * Webull bars で取得**できない**銘柄か (#475)。
 *   - `^` prefix の index (^VIX 等): Webull の instrument universe に無い
 *   - JP 銘柄: JP quotes subscription が必要 (MCP 実測 "Market data requires
 *     quotes subscription") で現契約では取れない
 * これらは Yahoo に直行する。
 */
function isWebullBarUnsupported(symbol: string): boolean {
  return symbol.startsWith('^') || inferWebullMarket(symbol) === 'JP'
}

/**
 * Webull primary + Yahoo fallback の composite (#475)。quote feed
 * (`quoteScheduler`) と同じ fail-safe 方針:
 *   - 非対応銘柄 (^VIX / JP) は最初から Yahoo
 *   - Webull の fetch 失敗は同じ呼び出しを Yahoo で再試行 (degraded but tradeable)
 *   - Yahoo まで失敗したら throw (呼び出し側の既存エラー処理に乗る — daily 失敗
 *     は per-symbol skip、intraday 失敗は daily close fallback)
 */
export class FallbackBarClient implements BarClient {
  constructor(
    private readonly primary: WebullBarClient,
    private readonly fallback: YahooBarClient,
  ) {}

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    if (isWebullBarUnsupported(symbol)) return this.fallback.getDailyBars(symbol, lookback)
    try {
      return await this.primary.getDailyBars(symbol, lookback)
    } catch {
      return this.fallback.getDailyBars(symbol, lookback)
    }
  }

  async getIntradayBars(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]> {
    if (isWebullBarUnsupported(symbol)) return this.fallback.getIntradayBars(symbol, interval)
    try {
      return await this.primary.getIntradayBars(symbol, interval)
    } catch {
      return this.fallback.getIntradayBars(symbol, interval)
    }
  }
}

/**
 * `BAR_SOURCE` env による bar client の選択 (#475)。quote の `QUOTE_SOURCE` と
 * 同じ規約: `'webull'` で Webull primary (+ Yahoo fallback)、未設定 / 他値は
 * Yahoo (現行 default) — **fail-safe 側が既定**で、切替は env の明示 opt-in のみ。
 * 独立 flag にしているのは quote と bars を別々に canary できるようにするため。
 */
export async function selectBarClient(env: Env): Promise<BarClient> {
  if ((env.BAR_SOURCE ?? '').trim().toLowerCase() === 'webull') {
    // Phase B token (DO 優先)。失敗しても client は構築する — token 無しで
    // broker が拒否すれば per-call エラー → Yahoo fallback。
    const accessToken = await resolveAccessToken(env).catch(() => undefined)
    return new FallbackBarClient(
      createWebullBarClient(env, {
        ...(accessToken !== undefined ? { accessToken } : {}),
      }),
      new YahooBarClient(),
    )
  }
  return new YahooBarClient()
}
