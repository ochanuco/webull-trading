import grpc from '@grpc/grpc-js'

import { createWebullGrpcAuthMetadata } from './auth'
import {
  EVENT_TYPE,
  EventServiceClient,
  type SubscribeRequest,
  type SubscribeResponse,
  serializeSubscribeRequest,
} from './proto'

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
const DEFAULT_SUBSCRIBE_TYPE = 1

export interface WebullGrpcClientOptions {
  endpoint: string
  appKey: string
  appSecret: string
  accountId: string | string[]
  credentials?: grpc.ChannelCredentials
  contentType?: string
  payload?: string
  subscribeType?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  maxReconnectAttempts?: number
  signal?: AbortSignal
}

export interface WebullGrpcTradeEventClient {
  subscribe(
    onEvent: (event: SubscribeResponse) => Promise<void> | void,
    onError?: (error: Error) => Promise<void> | void,
  ): Promise<void>
}

type SubscribeCall = grpc.ClientReadableStream<SubscribeResponse>

export function createWebullGrpcTradeEventClient(
  options: WebullGrpcClientOptions,
): WebullGrpcTradeEventClient {
  const client = new EventServiceClient(
    options.endpoint,
    options.credentials ?? grpc.credentials.createSsl(),
  ) as unknown as grpc.Client & {
    Subscribe(
      request: SubscribeRequest,
      metadata: grpc.Metadata,
    ): SubscribeCall
  }

  const accounts = Array.isArray(options.accountId) ? options.accountId : [options.accountId]

  return {
    async subscribe(onEvent, onError) {
      let reconnectAttempts = 0

      while (!options.signal?.aborted) {
        const request: SubscribeRequest = {
          subscribeType: options.subscribeType ?? DEFAULT_SUBSCRIBE_TYPE,
          timestamp: Date.now(),
          accounts,
          ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
          ...(options.payload === undefined ? {} : { payload: options.payload }),
        }

        const metadata = createWebullGrpcAuthMetadata({
          appKey: options.appKey,
          appSecret: options.appSecret,
          requestBytes: serializeSubscribeRequest(request),
        })

        try {
          await consumeStream(client.Subscribe(request, metadata), onEvent)
          console.warn('Webull gRPC stream ended; reconnecting')
        } catch (error) {
          const normalizedError = normalizeError(error)
          console.error('Webull gRPC stream failed', normalizedError)
          await onError?.(normalizedError)
        }

        if (options.signal?.aborted) {
          break
        }

        if (reconnectAttempts >= (options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY)) {
          break
        }

        const backoffMs = getReconnectDelayMs(
          reconnectAttempts,
          options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
          options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
        )
        reconnectAttempts += 1
        await delay(backoffMs, options.signal)
      }

      client.close()
    },
  }
}

async function consumeStream(
  call: SubscribeCall,
  onEvent: (event: SubscribeResponse) => Promise<void> | void,
): Promise<void> {
  let eventChain = Promise.resolve()
  let streamSettled = false

  return await new Promise<void>((resolve, reject) => {
    call.on('data', (response) => {
      eventChain = eventChain.then(async () => {
        const action = classifyEvent(response)
        if (action === 'ignore') {
          return
        }
        if (action === 'fatal') {
          call.cancel()
          throw new Error(`Webull gRPC control event: ${String(response.eventType)}`)
        }

        await onEvent(response)
      })
    })

    call.once('error', (error) => {
      streamSettled = true
      eventChain.then(() => reject(error)).catch(reject)
    })

    call.once('end', () => {
      streamSettled = true
      eventChain.then(resolve).catch(reject)
    })

    call.once('close', () => {
      if (!streamSettled) {
        eventChain.then(resolve).catch(reject)
      }
    })
  })
}

function classifyEvent(response: SubscribeResponse): 'ignore' | 'fatal' | 'forward' {
  const eventType = response.eventType

  if (eventType === EVENT_TYPE.SubscribeSuccess || eventType === 0) {
    console.info('Webull gRPC subscription established')
    return 'ignore'
  }

  if (eventType === EVENT_TYPE.Ping || eventType === 1) {
    console.debug('Webull gRPC heartbeat received')
    return 'ignore'
  }

  if (
    eventType === EVENT_TYPE.AuthError ||
    eventType === EVENT_TYPE.NumOfConnExceed ||
    eventType === EVENT_TYPE.SubscribeExpired ||
    eventType === 2 ||
    eventType === 3 ||
    eventType === 4
  ) {
    return 'fatal'
  }

  return 'forward'
}

function getReconnectDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}
