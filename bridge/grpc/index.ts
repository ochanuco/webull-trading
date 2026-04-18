import { TRADE_EVENT_INGEST_SECRET_HEADER, type TradeEventIngestRequest } from '../../src/infrastructure/webull/TradeEventBridge'
import { createWebullGrpcTradeEventClient } from './client'
import { mapWebullTradeEvent } from './mapper'

export interface BridgeRuntimeEnv {
  eventIngestUrl: string
  ingestSecret: string
  grpcEndpoint: string
  appKey: string
  appSecret: string
  accountId: string
}

interface PostTradeEventRetryOptions {
  timeoutMs?: number
  maxAttempts?: number
  backoffMs?: number
  multiplier?: number
  jitter?: number
}

interface RetryDelayOptions {
  attempt: number
  backoffMs: number
  multiplier: number
  jitter: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 200
const DEFAULT_BACKOFF_MULTIPLIER = 2
const DEFAULT_JITTER = 0.25

class PermanentTradeEventIngestError extends Error {}

export async function startTradeEventBridge(env: BridgeRuntimeEnv): Promise<void> {
  const client = createWebullGrpcTradeEventClient({
    endpoint: env.grpcEndpoint,
    appKey: env.appKey,
    appSecret: env.appSecret,
    accountId: env.accountId,
  })

  await client.subscribe(async (rawEvent) => {
    try {
      const event = mapWebullTradeEvent(rawEvent)
      await postTradeEvent(env, { event })
    } catch (error) {
      console.error('Failed to process gRPC trade event', error)
    }
  }, (error) => {
    console.error('Webull gRPC client error', error)
  })
}

export async function postTradeEvent(
  env: Pick<BridgeRuntimeEnv, 'eventIngestUrl' | 'ingestSecret'>,
  payload: TradeEventIngestRequest,
  fetchImpl: typeof fetch = fetch,
  options: PostTradeEventRetryOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const multiplier = options.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER
  const jitter = options.jitter ?? DEFAULT_JITTER

  const url = new URL(env.eventIngestUrl)
  const body = JSON.stringify(payload)

  let lastFailure: Error | undefined
  let lastStatus: number | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    let shouldRetry = false

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRADE_EVENT_INGEST_SECRET_HEADER]: env.ingestSecret,
        },
        body,
        signal: controller.signal,
      })

      if (response.ok) {
        return
      }

      lastStatus = response.status
      lastFailure = new Error(`Trade event ingest failed with status ${response.status}`)

      if (response.status < 500) {
        throw new PermanentTradeEventIngestError(
          `Trade event ingest failed permanently with status ${response.status}`,
        )
      }

      shouldRetry = true
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error))
      lastFailure = normalizedError

      shouldRetry = isRetryableFetchError(normalizedError)
      if (!shouldRetry) {
        throw normalizedError
      }
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (shouldRetry && attempt < maxAttempts) {
      const delayMs = getRetryDelayMs({ attempt, backoffMs, multiplier, jitter })
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }

  if (lastStatus !== undefined) {
    throw new Error(`Trade event ingest failed after ${maxAttempts} attempts with status ${lastStatus}`)
  }

  if (lastFailure) {
    throw new Error(
      `Trade event ingest failed after ${maxAttempts} attempts: ${lastFailure.message}`,
    )
  }

  throw new Error(`Trade event ingest failed after ${maxAttempts} attempts`)
}

function isRetryableFetchError(error: Error): boolean {
  return !(error instanceof PermanentTradeEventIngestError)
}

function getRetryDelayMs({
  attempt,
  backoffMs,
  multiplier,
  jitter,
}: RetryDelayOptions): number {
  const exponentialDelay = backoffMs * multiplier ** (attempt - 1)
  const jitterFactor = jitter <= 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter
  return Math.max(0, Math.round(exponentialDelay * jitterFactor))
}

if (import.meta.main) {
  const eventIngestUrl = process.env.EVENT_INGEST_URL
  const ingestSecret = process.env.EVENT_INGEST_SECRET
  const grpcEndpoint = process.env.WEBULL_GRPC_ENDPOINT
  const appKey = process.env.WEBULL_APP_KEY
  const appSecret = process.env.WEBULL_APP_SECRET
  const accountId = process.env.WEBULL_ACCOUNT_ID

  if (!eventIngestUrl || !ingestSecret || !grpcEndpoint || !appKey || !appSecret || !accountId) {
    throw new Error(
      'EVENT_INGEST_URL, EVENT_INGEST_SECRET, WEBULL_GRPC_ENDPOINT, WEBULL_APP_KEY, WEBULL_APP_SECRET, and WEBULL_ACCOUNT_ID are required',
    )
  }

  await startTradeEventBridge({
    eventIngestUrl,
    ingestSecret,
    grpcEndpoint,
    appKey,
    appSecret,
    accountId,
  })
}
