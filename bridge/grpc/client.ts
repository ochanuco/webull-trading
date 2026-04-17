export interface WebullGrpcClientOptions {
  endpoint: string
}

export interface WebullGrpcTradeEventClient {
  subscribe(onEvent: (event: unknown) => Promise<void> | void): Promise<void>
}

export function createWebullGrpcTradeEventClient(
  _options: WebullGrpcClientOptions,
): WebullGrpcTradeEventClient {
  return {
    async subscribe(_onEvent) {
      throw new Error('TODO: implement Webull gRPC server-streaming client once proto definitions are available')
    },
  }
}
