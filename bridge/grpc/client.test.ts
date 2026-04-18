import grpc from '@grpc/grpc-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WEBULL_GRPC_HEADERS } from './auth'
import { createWebullGrpcTradeEventClient } from './client'
import { eventServiceDefinition, type SubscribeRequest, type SubscribeResponse } from './proto'

describe('createWebullGrpcTradeEventClient', () => {
  const servers: grpc.Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.tryShutdown(() => resolve())
          }),
      ),
    )
    servers.length = 0
  })

  it('opens a server-streaming subscription and forwards trade events', async () => {
    const receivedRequests: SubscribeRequest[] = []
    const receivedAppKeys: string[][] = []
    const server = new grpc.Server()
    servers.push(server)

    server.addService(eventServiceDefinition, {
      Subscribe(call: grpc.ServerWritableStream<SubscribeRequest, SubscribeResponse>) {
        receivedRequests.push(call.request)
        receivedAppKeys.push(call.metadata.get(WEBULL_GRPC_HEADERS.appKey) as string[])
        call.write({
          eventType: 5,
          subscribeType: 1,
          contentType: 'application/json',
          payload: JSON.stringify({
            eventType: 'ORDER_FILLED',
            orderId: 'order-1',
            symbol: 'SOXL',
            status: 'FILLED',
            filledQty: 2,
          }),
          requestId: 'req-1',
          timestamp: Date.now(),
        })
        call.end()
      },
    })

    const port = await bindServer(server)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const onEvent = vi.fn()
    const client = createWebullGrpcTradeEventClient({
      endpoint: `127.0.0.1:${port}`,
      appKey: 'app-key',
      appSecret: 'app-secret',
      accountId: 'account-1',
      credentials: grpc.credentials.createInsecure(),
      maxReconnectAttempts: 0,
    })

    await client.subscribe(onEvent)

    expect(receivedRequests).toEqual([
      {
        subscribeType: 1,
        timestamp: expect.any(Number),
        contentType: '',
        payload: '',
        accounts: ['account-1'],
      },
    ])
    expect(receivedAppKeys).toEqual([['app-key']])
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'application/json',
        payload: expect.any(String),
        requestId: 'req-1',
      }),
    )
  })
})

async function bindServer(server: grpc.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error)
        return
      }

      server.start()
      resolve(port)
    })
  })
}