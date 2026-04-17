import { TRADE_EVENT_INGEST_SECRET_HEADER, type TradeEventIngestRequest } from '../../src/infrastructure/webull/TradeEventBridge'
import { createWebullGrpcTradeEventClient } from './client'
import { mapWebullTradeEvent } from './mapper'

export interface BridgeRuntimeEnv {
  workerBaseUrl: string
  ingestSecret: string
  grpcEndpoint: string
}

export async function startTradeEventBridge(env: BridgeRuntimeEnv): Promise<void> {
  const client = createWebullGrpcTradeEventClient({ endpoint: env.grpcEndpoint })

  await client.subscribe(async (rawEvent: unknown) => {
    try {
      const event = mapWebullTradeEvent(rawEvent)
      await postTradeEvent(env, { event })
    } catch (error) {
      console.error('Failed to process gRPC trade event', error)
    }
  })
}

export async function postTradeEvent(
  env: Pick<BridgeRuntimeEnv, 'workerBaseUrl' | 'ingestSecret'>,
  payload: TradeEventIngestRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // TODO(phase-5/#6): add timeout and retry handling for transient ingest failures.
  const response = await fetchImpl(new URL('/events/trade', env.workerBaseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TRADE_EVENT_INGEST_SECRET_HEADER]: env.ingestSecret,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Trade event ingest failed with status ${response.status}`)
  }
}

if (import.meta.main) {
  const workerBaseUrl = process.env.WORKER_BASE_URL
  const ingestSecret = process.env.EVENT_INGEST_SECRET
  const grpcEndpoint = process.env.WEBULL_GRPC_ENDPOINT

  if (!workerBaseUrl || !ingestSecret || !grpcEndpoint) {
    throw new Error('WORKER_BASE_URL, EVENT_INGEST_SECRET, and WEBULL_GRPC_ENDPOINT are required')
  }

  await startTradeEventBridge({ workerBaseUrl, ingestSecret, grpcEndpoint })
}
