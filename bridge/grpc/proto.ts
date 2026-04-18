import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const PROTO_PATH = new URL('../proto/events.proto', import.meta.url).pathname

export interface SubscribeRequest {
  subscribeType: number
  timestamp: number
  contentType?: string
  payload?: string
  accounts: string[]
}

export interface SubscribeResponse {
  eventType: number | string
  subscribeType: number
  contentType: string
  payload: string
  requestId: string
  timestamp: number | string
}

type LoadedGrpcPackage = {
  grpc: {
    trade: {
      event: {
        EventService: grpc.ServiceClientConstructor & {
          service: grpc.ServiceDefinition
        }
      }
    }
  }
}

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
})

const grpcPackage = grpc.loadPackageDefinition(packageDefinition) as unknown as LoadedGrpcPackage

export const EVENT_TYPE = {
  SubscribeSuccess: 'SubscribeSuccess',
  Ping: 'Ping',
  AuthError: 'AuthError',
  NumOfConnExceed: 'NumOfConnExceed',
  SubscribeExpired: 'SubscribeExpired',
} as const

export const EventServiceClient = grpcPackage.grpc.trade.event.EventService
export const eventServiceDefinition = EventServiceClient.service

type SubscribeMethodDefinition = {
  requestSerialize: (value: SubscribeRequest) => Buffer
}

export function serializeSubscribeRequest(request: SubscribeRequest): Buffer {
  const subscribeMethod = eventServiceDefinition.Subscribe as unknown as SubscribeMethodDefinition
  return subscribeMethod.requestSerialize(request)
}
