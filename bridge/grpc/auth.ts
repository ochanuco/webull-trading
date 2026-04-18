import { createHash, createHmac, randomUUID } from 'node:crypto'

import grpc from '@grpc/grpc-js'

const WEBULL_SIGN_ALGORITHM = 'HMAC-SHA1'
const WEBULL_SIGN_VERSION = '1.0'
const SECRET_TAILER = '&'

export const WEBULL_GRPC_HEADERS = {
  appKey: 'x-app-key',
  signature: 'x-signature',
  signAlgorithm: 'x-signature-algorithm',
  signVersion: 'x-signature-version',
  nonce: 'x-signature-nonce',
  timestamp: 'x-timestamp',
} as const

export interface CreateWebullGrpcAuthMetadataOptions {
  appKey: string
  appSecret: string
  requestBytes: Uint8Array
  timestamp?: string
  nonce?: string
}

export interface WebullGrpcSignatureParts {
  metadataEntries: Array<[string, string]>
  bodyMd5Hex: string
  stringToSign: string
  encodedStringToSign: string
  signature: string
}

export function buildWebullGrpcSignatureParts(
  options: CreateWebullGrpcAuthMetadataOptions,
): WebullGrpcSignatureParts {
  const timestamp = options.timestamp ?? toWebullIso8601(new Date())
  const nonce = options.nonce ?? randomUUID()
  const metadataEntries: Array<[string, string]> = [
    [WEBULL_GRPC_HEADERS.appKey, options.appKey],
    [WEBULL_GRPC_HEADERS.signAlgorithm, WEBULL_SIGN_ALGORITHM],
    [WEBULL_GRPC_HEADERS.signVersion, WEBULL_SIGN_VERSION],
    [WEBULL_GRPC_HEADERS.nonce, nonce],
    [WEBULL_GRPC_HEADERS.timestamp, timestamp],
  ]

  const signParams = Object.fromEntries(
    metadataEntries.map(([key, value]) => [key.toLowerCase(), value]),
  )

  const bodyMd5Hex = createHash('md5').update(options.requestBytes).digest('hex')
  const signString = Object.entries(signParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

  const stringToSign = `${signString}&${bodyMd5Hex}`
  const encodedStringToSign = strictEncodeURIComponent(stringToSign)
  const signature = createHmac('sha1', `${options.appSecret}${SECRET_TAILER}`)
    .update(encodedStringToSign)
    .digest('base64')

  return {
    metadataEntries,
    bodyMd5Hex,
    stringToSign,
    encodedStringToSign,
    signature,
  }
}

export function createWebullGrpcAuthMetadata(
  options: CreateWebullGrpcAuthMetadataOptions,
): grpc.Metadata {
  const metadata = new grpc.Metadata()
  const signatureParts = buildWebullGrpcSignatureParts(options)

  for (const [key, value] of signatureParts.metadataEntries) {
    metadata.set(key, value)
  }

  metadata.set(WEBULL_GRPC_HEADERS.signature, signatureParts.signature)
  return metadata
}

function toWebullIso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function strictEncodeURIComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
