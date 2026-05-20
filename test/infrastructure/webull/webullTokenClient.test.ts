import { describe, expect, it, vi } from 'vitest'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'
import { WebullTokenClient } from '../../../src/infrastructure/webull/WebullTokenClient'

const auth = new WebullAuth({ appKey: 'ak', appSecret: 'sk' })

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WebullTokenClient.createToken', () => {
  // #21: token endpoint は v2 固定 (SDK 実装より)。Webull は version mismatch を
  // signature reject で返してくるので、ここの version drift を必ず lock する。
  it('POSTs /openapi/auth/token/create with x-version: v2 (no body when no existing token)', async () => {
    let capturedUrl: URL | undefined
    let capturedHeaders: Headers | undefined
    let capturedBody: string | null = null
    let capturedMethod: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedMethod = init?.method
      capturedHeaders = new Headers(init?.headers)
      capturedBody = init?.body ? String(init.body) : null
      return mockJson({ token: 'tok-1', expires: 1700000000, status: 'PENDING' })
    }) as unknown as typeof fetch

    const client = new WebullTokenClient({
      auth,
      baseUrl: 'https://api.example.test',
      fetchFn,
    })
    const result = await client.createToken()

    expect(capturedMethod).toBe('POST')
    expect(capturedUrl?.pathname).toBe('/openapi/auth/token/create')
    expect(capturedHeaders?.get('x-version')).toBe('v2')
    // SDK の CreateTokenRequest: token 未指定なら body params が空のまま。
    // ここで `{}` を送ると body MD5 が canonical に混ざってしまうので、
    // `undefined` を保ってるか locked する (signing への影響あり)。
    expect(capturedBody).toBeNull()
    expect(result).toEqual({ token: 'tok-1', expires: 1700000000, status: 'PENDING' })
  })

  // refresh path: existing token を渡すと body に乗る。check_token と区別するため
  // body shape を locked。
  it('includes the existing token in the body when refreshing', async () => {
    let capturedBody: string | null = null
    const fetchFn = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : null
      return mockJson({ token: 'tok-2', expires: 1700000000, status: 'NORMAL' })
    }) as unknown as typeof fetch

    const client = new WebullTokenClient({
      auth,
      baseUrl: 'https://api.example.test',
      fetchFn,
    })
    await client.createToken('tok-old')

    expect(capturedBody).toBe(JSON.stringify({ token: 'tok-old' }))
  })

  it('parses { token, expires, status } and exposes NORMAL/PENDING/INVALID/EXPIRED', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({ token: 'tok-3', expires: 9999999999, status: 'NORMAL' }),
    ) as unknown as typeof fetch
    const client = new WebullTokenClient({ auth, baseUrl: 'https://api.example.test', fetchFn })
    const result = await client.createToken()
    expect(result.status).toBe('NORMAL')
  })

  it('throws BrokerRequestError on non-2xx', async () => {
    const fetchFn = vi.fn(async () => mockJson({ error: 'bad' }, 401)) as unknown as typeof fetch
    const client = new WebullTokenClient({ auth, baseUrl: 'https://api.example.test', fetchFn })
    await expect(client.createToken()).rejects.toThrow(/401/)
  })

  it('throws when response is missing required fields', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({ token: 'tok-no-status', expires: 1700000000 }),
    ) as unknown as typeof fetch
    const client = new WebullTokenClient({ auth, baseUrl: 'https://api.example.test', fetchFn })
    await expect(client.createToken()).rejects.toThrow(/token\/expires\/status/)
  })

  it('throws when status string is unrecognised (e.g. typo or new value)', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({ token: 'tok-x', expires: 1700000000, status: 'WHATEVER' }),
    ) as unknown as typeof fetch
    const client = new WebullTokenClient({ auth, baseUrl: 'https://api.example.test', fetchFn })
    await expect(client.createToken()).rejects.toThrow(/unknown status/)
  })
})

describe('WebullTokenClient.checkToken', () => {
  it('POSTs /openapi/auth/token/check with { token } body', async () => {
    let capturedUrl: URL | undefined
    let capturedBody: string | null = null
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedBody = init?.body ? String(init.body) : null
      return mockJson({ token: 'tok-y', expires: 1700000000, status: 'NORMAL' })
    }) as unknown as typeof fetch

    const client = new WebullTokenClient({
      auth,
      baseUrl: 'https://api.example.test',
      fetchFn,
    })
    const result = await client.checkToken('tok-y')

    expect(capturedUrl?.pathname).toBe('/openapi/auth/token/check')
    expect(capturedBody).toBe(JSON.stringify({ token: 'tok-y' }))
    expect(result.status).toBe('NORMAL')
  })

  // Status は string enum で 4 値しかない。typo / unknown は throw する事を locked。
  it.each(['PENDING', 'NORMAL', 'INVALID', 'EXPIRED'] as const)(
    'accepts status=%s',
    async (status) => {
      const fetchFn = vi.fn(async () =>
        mockJson({ token: 'tok-z', expires: 1700000000, status }),
      ) as unknown as typeof fetch
      const client = new WebullTokenClient({ auth, baseUrl: 'https://api.example.test', fetchFn })
      const result = await client.checkToken('tok-z')
      expect(result.status).toBe(status)
    },
  )
})
