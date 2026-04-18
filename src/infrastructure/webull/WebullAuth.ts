const WEBULL_SIGNATURE_ALGORITHM = 'HMAC-SHA1'
const WEBULL_SIGNATURE_VERSION = '1.0'

type SignablePrimitive = string | number | boolean
type SignableValue =
  | SignablePrimitive
  | readonly SignablePrimitive[]
  | null
  | undefined

export interface WebullAuthConfig {
  appKey?: string
  appSecret?: string
  version?: string
}

export interface BuildSignedHeadersInput {
  method: string
  path: string
  query?: Record<string, SignableValue>
  body?: string
  appKey: string
  appSecret: string
  host: string
  nonce?: string
  timestamp?: string
  version?: string
}

interface CanonicalStringInput {
  path: string
  query?: Record<string, SignableValue>
  headers: Record<string, string>
  bodyMd5?: string
}

export class WebullAuth {
  constructor(private readonly config: WebullAuthConfig) {}

  async createHeaders({
    method,
    path,
    query,
    body,
    host,
    nonce,
    timestamp,
    version,
  }: Omit<BuildSignedHeadersInput, 'appKey' | 'appSecret'>): Promise<Record<string, string>> {
    const { appKey, appSecret, version: configVersion } = this.config

    if (!appKey || !appSecret) {
      throw new Error('Missing Webull credentials')
    }

    return buildSignedHeaders({
      method,
      path,
      query,
      body,
      appKey,
      appSecret,
      host,
      nonce,
      timestamp,
      version: version ?? configVersion,
    })
  }
}

export async function buildSignedHeaders({
  method,
  path,
  query,
  body,
  appKey,
  appSecret,
  host,
  nonce = crypto.randomUUID(),
  timestamp = new Date().toISOString(),
  version,
}: BuildSignedHeadersInput): Promise<Record<string, string>> {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'POST') {
    throw new Error(`Unsupported Webull signing method: ${method}`)
  }

  const signingHeaders = {
    host,
    'x-app-key': appKey,
    'x-signature-algorithm': WEBULL_SIGNATURE_ALGORITHM,
    'x-signature-nonce': nonce,
    'x-signature-version': WEBULL_SIGNATURE_VERSION,
    'x-timestamp': timestamp,
    ...(version === undefined ? {} : { 'x-version': version }),
  }
  const bodyMd5 = body === undefined || body.length === 0 ? undefined : await md5UpperHex(body)
  const stringToSign = canonicalString({
    path,
    query,
    headers: signingHeaders,
    bodyMd5,
  })
  const encodedString = urlEncodeCanonical(stringToSign)
  const signature = await hmacSha1Base64(appSecret, encodedString)

  return {
    ...signingHeaders,
    'x-signature': signature,
  }
}

export function canonicalString({
  path,
  query,
  headers,
  bodyMd5,
}: CanonicalStringInput): string {
  const merged = new Map<string, string>()

  for (const [key, value] of Object.entries(headers)) {
    merged.set(key.toLowerCase(), value)
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      const normalized = normalizeSignableValue(value)
      if (normalized !== undefined) {
        merged.set(key, normalized)
      }
    }
  }

  const sortedPairs = [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

  return bodyMd5 ? `${path}&${sortedPairs}&${bodyMd5}` : `${path}&${sortedPairs}`
}

export function urlEncodeCanonical(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export async function hmacSha1Base64(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${secret}&`),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return toBase64(signature)
}

export async function md5UpperHex(value: string): Promise<string> {
  const input = new TextEncoder().encode(value)

  try {
    const digest = await crypto.subtle.digest('MD5', input)
    return toHex(digest).toUpperCase()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') {
      return md5UpperHexFallback(input)
    }
    throw error
  }
}

function normalizeSignableValue(value: SignableValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry))
      .sort((left, right) => left.localeCompare(right))
      .join('&')
  }

  return String(value)
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

// Workers supports MD5 in WebCrypto, but Vitest's Node runtime does not.
function md5UpperHexFallback(input: Uint8Array): string {
  const words = md5Words(input)
  return wordsToBytes(words)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function md5Words(input: Uint8Array): number[] {
  const blocks = new Array<number>(((input.length + 8) >> 6 << 4) + 16).fill(0)

  for (let index = 0; index < input.length; index += 1) {
    const blockIndex = index >> 2
    blocks[blockIndex] = (blocks[blockIndex] ?? 0) | (input[index]! << ((index % 4) * 8))
  }

  const paddingIndex = input.length >> 2
  blocks[paddingIndex] = (blocks[paddingIndex] ?? 0) | (0x80 << ((input.length % 4) * 8))
  blocks[blocks.length - 2] = input.length * 8

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  for (let i = 0; i < blocks.length; i += 16) {
    const prevA = a
    const prevB = b
    const prevC = c
    const prevD = d

    a = ff(a, b, c, d, blocks[i]!, 7, -680876936)
    d = ff(d, a, b, c, blocks[i + 1]!, 12, -389564586)
    c = ff(c, d, a, b, blocks[i + 2]!, 17, 606105819)
    b = ff(b, c, d, a, blocks[i + 3]!, 22, -1044525330)
    a = ff(a, b, c, d, blocks[i + 4]!, 7, -176418897)
    d = ff(d, a, b, c, blocks[i + 5]!, 12, 1200080426)
    c = ff(c, d, a, b, blocks[i + 6]!, 17, -1473231341)
    b = ff(b, c, d, a, blocks[i + 7]!, 22, -45705983)
    a = ff(a, b, c, d, blocks[i + 8]!, 7, 1770035416)
    d = ff(d, a, b, c, blocks[i + 9]!, 12, -1958414417)
    c = ff(c, d, a, b, blocks[i + 10]!, 17, -42063)
    b = ff(b, c, d, a, blocks[i + 11]!, 22, -1990404162)
    a = ff(a, b, c, d, blocks[i + 12]!, 7, 1804603682)
    d = ff(d, a, b, c, blocks[i + 13]!, 12, -40341101)
    c = ff(c, d, a, b, blocks[i + 14]!, 17, -1502002290)
    b = ff(b, c, d, a, blocks[i + 15]!, 22, 1236535329)

    a = gg(a, b, c, d, blocks[i + 1]!, 5, -165796510)
    d = gg(d, a, b, c, blocks[i + 6]!, 9, -1069501632)
    c = gg(c, d, a, b, blocks[i + 11]!, 14, 643717713)
    b = gg(b, c, d, a, blocks[i]!, 20, -373897302)
    a = gg(a, b, c, d, blocks[i + 5]!, 5, -701558691)
    d = gg(d, a, b, c, blocks[i + 10]!, 9, 38016083)
    c = gg(c, d, a, b, blocks[i + 15]!, 14, -660478335)
    b = gg(b, c, d, a, blocks[i + 4]!, 20, -405537848)
    a = gg(a, b, c, d, blocks[i + 9]!, 5, 568446438)
    d = gg(d, a, b, c, blocks[i + 14]!, 9, -1019803690)
    c = gg(c, d, a, b, blocks[i + 3]!, 14, -187363961)
    b = gg(b, c, d, a, blocks[i + 8]!, 20, 1163531501)
    a = gg(a, b, c, d, blocks[i + 13]!, 5, -1444681467)
    d = gg(d, a, b, c, blocks[i + 2]!, 9, -51403784)
    c = gg(c, d, a, b, blocks[i + 7]!, 14, 1735328473)
    b = gg(b, c, d, a, blocks[i + 12]!, 20, -1926607734)

    a = hh(a, b, c, d, blocks[i + 5]!, 4, -378558)
    d = hh(d, a, b, c, blocks[i + 8]!, 11, -2022574463)
    c = hh(c, d, a, b, blocks[i + 11]!, 16, 1839030562)
    b = hh(b, c, d, a, blocks[i + 14]!, 23, -35309556)
    a = hh(a, b, c, d, blocks[i + 1]!, 4, -1530992060)
    d = hh(d, a, b, c, blocks[i + 4]!, 11, 1272893353)
    c = hh(c, d, a, b, blocks[i + 7]!, 16, -155497632)
    b = hh(b, c, d, a, blocks[i + 10]!, 23, -1094730640)
    a = hh(a, b, c, d, blocks[i + 13]!, 4, 681279174)
    d = hh(d, a, b, c, blocks[i]!, 11, -358537222)
    c = hh(c, d, a, b, blocks[i + 3]!, 16, -722521979)
    b = hh(b, c, d, a, blocks[i + 6]!, 23, 76029189)
    a = hh(a, b, c, d, blocks[i + 9]!, 4, -640364487)
    d = hh(d, a, b, c, blocks[i + 12]!, 11, -421815835)
    c = hh(c, d, a, b, blocks[i + 15]!, 16, 530742520)
    b = hh(b, c, d, a, blocks[i + 2]!, 23, -995338651)

    a = ii(a, b, c, d, blocks[i]!, 6, -198630844)
    d = ii(d, a, b, c, blocks[i + 7]!, 10, 1126891415)
    c = ii(c, d, a, b, blocks[i + 14]!, 15, -1416354905)
    b = ii(b, c, d, a, blocks[i + 5]!, 21, -57434055)
    a = ii(a, b, c, d, blocks[i + 12]!, 6, 1700485571)
    d = ii(d, a, b, c, blocks[i + 3]!, 10, -1894986606)
    c = ii(c, d, a, b, blocks[i + 10]!, 15, -1051523)
    b = ii(b, c, d, a, blocks[i + 1]!, 21, -2054922799)
    a = ii(a, b, c, d, blocks[i + 8]!, 6, 1873313359)
    d = ii(d, a, b, c, blocks[i + 15]!, 10, -30611744)
    c = ii(c, d, a, b, blocks[i + 6]!, 15, -1560198380)
    b = ii(b, c, d, a, blocks[i + 13]!, 21, 1309151649)
    a = ii(a, b, c, d, blocks[i + 4]!, 6, -145523070)
    d = ii(d, a, b, c, blocks[i + 11]!, 10, -1120210379)
    c = ii(c, d, a, b, blocks[i + 2]!, 15, 718787259)
    b = ii(b, c, d, a, blocks[i + 9]!, 21, -343485551)

    a = addUnsigned(a, prevA)
    b = addUnsigned(b, prevB)
    c = addUnsigned(c, prevC)
    d = addUnsigned(d, prevD)
  }

  return [a, b, c, d]
}

function wordsToBytes(words: number[]): number[] {
  return words.flatMap((word) => [
    word & 0xff,
    (word >>> 8) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 24) & 0xff,
  ])
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return rotateLeft(addUnsigned(a, addUnsigned(addUnsigned((b & c) | (~b & d), x), t)), s) + b
}

function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return rotateLeft(addUnsigned(a, addUnsigned(addUnsigned((b & d) | (c & ~d), x), t)), s) + b
}

function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(b ^ c ^ d, x), t)), s) + b
}

function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(c ^ (b | ~d), x), t)), s) + b
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}

function addUnsigned(left: number, right: number): number {
  return (((left >>> 0) + (right >>> 0)) & 0xffffffff) | 0
}
