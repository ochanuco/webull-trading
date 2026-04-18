import { describe, expect, it } from 'vitest'

import { buildWebullGrpcSignatureParts, createWebullGrpcAuthMetadata, WEBULL_GRPC_HEADERS } from './auth'
import { serializeSubscribeRequest } from './proto'

describe('buildWebullGrpcSignatureParts', () => {
  it('builds deterministic signing inputs for protobuf requests', () => {
    const requestBytes = serializeSubscribeRequest({
      subscribeType: 1,
      timestamp: 100000000,
      accounts: ['account_0'],
    })

    const signature = buildWebullGrpcSignatureParts({
      appKey: 'app_key _mocked',
      appSecret: 'app_secret_mocked',
      requestBytes,
      timestamp: '2022-01-04T03:55:31Z',
      nonce: 'my-uuid',
    })

    expect(signature.bodyMd5Hex).toBe('4335166b85119cf1b35b7be11a2275d3')
    expect(signature.stringToSign).toBe(
      'x-app-key=app_key _mocked&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=my-uuid&x-signature-version=1.0&x-timestamp=2022-01-04T03:55:31Z&4335166b85119cf1b35b7be11a2275d3',
    )
    expect(signature.encodedStringToSign).toBe(
      'x-app-key%3Dapp_key%20_mocked%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3Dmy-uuid%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%264335166b85119cf1b35b7be11a2275d3',
    )
    expect(signature.signature).toBe('LOhD7cRCIqpe7sn6vkam3Vv22Qk=')
  })

  it('populates gRPC metadata headers', () => {
    const metadata = createWebullGrpcAuthMetadata({
      appKey: 'key',
      appSecret: 'secret',
      requestBytes: serializeSubscribeRequest({
        subscribeType: 1,
        timestamp: 1,
        accounts: ['account-1'],
      }),
      timestamp: '2022-01-04T03:55:31Z',
      nonce: 'nonce-1',
    })

    expect(metadata.get(WEBULL_GRPC_HEADERS.appKey)).toEqual(['key'])
    expect(metadata.get(WEBULL_GRPC_HEADERS.signAlgorithm)).toEqual(['HMAC-SHA1'])
    expect(metadata.get(WEBULL_GRPC_HEADERS.signVersion)).toEqual(['1.0'])
    expect(metadata.get(WEBULL_GRPC_HEADERS.nonce)).toEqual(['nonce-1'])
    expect(metadata.get(WEBULL_GRPC_HEADERS.timestamp)).toEqual(['2022-01-04T03:55:31Z'])
    expect(metadata.get(WEBULL_GRPC_HEADERS.signature)).toHaveLength(1)
  })
})
