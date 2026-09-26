import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { WebullAuth } from './WebullAuth'

/**
 * Webull's `x-access-token` issuance flow: `createToken` (`POST
 * /openapi/auth/token/create`) returns a token that stays PENDING until
 * 2FA-verified in the Webull mobile app; `checkToken` polls status until it
 * reaches NORMAL. Driven operationally by `scripts/issue-webull-token.ts`.
 */

/** SDK enum is numeric (PENDING=0/NORMAL=1/INVALID=2/EXPIRED=3); this type keeps the string form. */
export type WebullTokenStatus = 'PENDING' | 'NORMAL' | 'INVALID' | 'EXPIRED'

export interface WebullAccessTokenDto {
  token: string
  /** Epoch ms or seconds — Webull's docs don't specify which. */
  expires: number
  status: WebullTokenStatus
}

export interface WebullTokenClientOptions {
  auth: WebullAuth
  /** Same host as trade: prod `api.webull.co.jp`, or the UAT ALB URL. */
  baseUrl: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

const CREATE_PATH = '/openapi/auth/token/create'
const CHECK_PATH = '/openapi/auth/token/check'
/** Only the token endpoint requires v2 — independent of WebullHttpClient's default v1 trade version. */
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

  /** Issues a new token, or refreshes one when `existingToken` is passed. */
  createToken(existingToken?: string): Promise<WebullAccessTokenDto> {
    // Body must be omitted (not `{}`) when there's no token, or the empty
    // object still contributes a body MD5 to the signing canonical string.
    const body = existingToken ? { token: existingToken } : undefined
    return this.requestToken(CREATE_PATH, body)
  }

  /** Fetches the current status for polling. */
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
    // Mask before it enters error text — a raw token in a log/stack trace leaks the credential.
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
