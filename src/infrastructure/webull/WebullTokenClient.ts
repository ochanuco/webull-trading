import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { WebullAuth } from './WebullAuth'

/**
 * Webull の `x-access-token` 発行フロー (#21)。
 *
 * - `createToken(existingToken?)` → `POST /openapi/auth/token/create` v2、
 *   返却された token (通常 status=PENDING) を operator が Webull モバイルアプリで
 *   2FA SMS verify するまで使えない。
 * - `checkToken(token)` → `POST /openapi/auth/token/check` v2、status を poll
 *   して NORMAL になったかを確認する。
 *
 * Operator script (`scripts/issue-webull-token.ts`) が createToken → poll
 * checkToken → 取得 token を `wrangler secret put WEBULL_ACCESS_TOKEN` で投入、
 * という流れで使う。Worker runtime からの自動 refresh (Phase B / #21 follow-up) では
 * 同 class を Durable Object 経由で呼び出す予定。
 */

/** Webull docs / SDK enum 定義より (PENDING=0 / NORMAL=1 / INVALID=2 / EXPIRED=3)。 */
export type WebullTokenStatus = 'PENDING' | 'NORMAL' | 'INVALID' | 'EXPIRED'

export interface WebullAccessTokenDto {
  /** token 文字列。`x-access-token` ヘッダにそのまま乗せる値。 */
  token: string
  /** epoch ms (or seconds — Webull docs では明示なし)。SDK は数値として保持。 */
  expires: number
  status: WebullTokenStatus
}

export interface WebullTokenClientOptions {
  auth: WebullAuth
  /** 通常 `api.webull.co.jp` (本番) または UAT ALB URL。trade host と同じ。 */
  baseUrl: string
  /** Default 10s。create / check のレスポンスは速いはず。 */
  timeoutMs?: number
  fetchFn?: typeof fetch
}

const CREATE_PATH = '/openapi/auth/token/create'
const CHECK_PATH = '/openapi/auth/token/check'
/**
 * Webull は token endpoint だけ x-version=v2 を要求する (SDK 実装より)。
 * 既存の `WebullHttpClient.tradeVersion` (default v1) とは別軸。
 */
const TOKEN_VERSION = 'v2'

export class WebullTokenClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: WebullTokenClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  /**
   * 新規 token 発行 (`existingToken` 渡すと refresh) 。返却された status が
   * `NORMAL` ならそのまま使える (test env 等)、`PENDING` なら operator が
   * モバイルアプリで verify する必要があり、その後 `checkToken` で確認する。
   */
  createToken(existingToken?: string): Promise<WebullAccessTokenDto> {
    // SDK の CreateTokenRequest は token があれば body に含める、無ければ空 body。
    // 空 body だと body MD5 は計算しない (signing 上 body 部分が省略される)。
    const body = existingToken ? { token: existingToken } : undefined
    return this.requestToken(CREATE_PATH, body)
  }

  /** 既存 token の現在 status を取得 (poll 用)。 */
  checkToken(token: string): Promise<WebullAccessTokenDto> {
    return this.requestToken(CHECK_PATH, { token })
  }

  private async requestToken(
    path: string,
    body: { token?: string } | undefined,
  ): Promise<WebullAccessTokenDto> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const url = new URL(path, `${this.baseUrl}/`)

    let authHeaders: Record<string, string>
    try {
      authHeaders = await this.options.auth.createHeaders({
        method: 'POST',
        path: url.pathname,
        body: payload,
        host: url.host,
        version: TOKEN_VERSION,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull token auth failed: ${error instanceof Error ? error.message : String(error)}`,
        `POST ${path}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...authHeaders,
        },
        body: payload,
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull token fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `POST ${path}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Webull token request failed with status ${response.status}`,
        `POST ${path}`,
      )
    }

    let json: unknown
    try {
      json = await response.json()
    } catch (error) {
      throw new BrokerRequestError(
        `Webull token response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        `POST ${path}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    return normalizeAccessToken(json, path)
  }
}

function normalizeAccessToken(json: unknown, path: string): WebullAccessTokenDto {
  if (typeof json !== 'object' || json === null) {
    throw new BrokerRequestError(
      `Webull token response is not an object`,
      `POST ${path}`,
    )
  }
  const obj = json as Record<string, unknown>
  const token = typeof obj.token === 'string' ? obj.token : null
  const expires = typeof obj.expires === 'number' ? obj.expires : Number(obj.expires)
  const statusRaw = typeof obj.status === 'string' ? obj.status : null
  if (!token || !Number.isFinite(expires) || statusRaw === null) {
    // Mask the token in error output. raw token を JSON.stringify でログ /
    // スタックに残すと、認証情報がエラー解析チャネルに漏れる (CodeRabbit
    // #325 review)。
    const masked: Record<string, unknown> = { ...obj }
    if (typeof obj.token === 'string' && obj.token.length > 10) {
      masked.token = `${obj.token.slice(0, 6)}...${obj.token.slice(-4)}`
    } else if (typeof obj.token === 'string') {
      masked.token = '<redacted>'
    }
    throw new BrokerRequestError(
      `Webull token response missing token/expires/status: ${JSON.stringify(masked)}`,
      `POST ${path}`,
    )
  }
  if (
    statusRaw !== 'PENDING' &&
    statusRaw !== 'NORMAL' &&
    statusRaw !== 'INVALID' &&
    statusRaw !== 'EXPIRED'
  ) {
    throw new BrokerRequestError(
      `Webull token returned unknown status '${statusRaw}'`,
      `POST ${path}`,
    )
  }
  return { token, expires, status: statusRaw }
}
