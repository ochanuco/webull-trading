import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullAccountDto, WebullPlaceOrderResponseDto } from './dto'
import { toWebullPlaceOrderRequest } from './mapper'
import { WebullAuth } from './WebullAuth'

export interface WebullClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID?: string
  WEBULL_API_BASE?: string
}

interface WebullHttpClientOptions {
  auth: WebullAuth
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

export class WebullHttpClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: WebullHttpClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://openapi.webull.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchFn = options.fetchFn ?? fetch
  }

  async getAccount(): Promise<WebullAccountDto> {
    return this.request<WebullAccountDto>('GET', '/account')
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    return this.request<WebullPlaceOrderResponseDto>('POST', '/order/place', toWebullPlaceOrderRequest(intent))
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(await this.options.auth.createHeaders(method, path, payload)),
        },
        body: payload,
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Webull request failed with status ${response.status}`)
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Webull request timed out after ${this.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

export function createWebullHttpClient(
  env: WebullClientEnv,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number },
): WebullHttpClient {
  return new WebullHttpClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
      accountId: env.WEBULL_ACCOUNT_ID,
    }),
    baseUrl: env.WEBULL_API_BASE,
    timeoutMs: options?.timeoutMs,
    fetchFn: options?.fetchFn,
  })
}
