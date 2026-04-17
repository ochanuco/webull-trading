export interface WebullAuthConfig {
  appKey?: string
  appSecret?: string
  accountId?: string
}

export class WebullAuth {
  constructor(private readonly config: WebullAuthConfig) {}

  async createHeaders(method: string, path: string, body?: string): Promise<Record<string, string>> {
    const { appKey, appSecret, accountId } = this.config

    if (!appKey || !appSecret || !accountId) {
      throw new Error('Missing Webull credentials')
    }

    const timestamp = new Date().toISOString()
    const payload = [method.toUpperCase(), path, timestamp, body ?? ''].join('\n')

    return {
      Authorization: `HMAC ${appKey}:${await signPayload(appSecret, payload)}`,
      'X-Webull-App-Key': appKey,
      'X-Webull-Account-Id': accountId,
      'X-Webull-Timestamp': timestamp,
    }
  }
}

/**
 * Placeholder for real Webull signing. Production Webull auth would derive the canonical string,
 * handle nonce/timestamp rules, and emit the broker-specific signature headers.
 */
async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return toHex(signature)
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
