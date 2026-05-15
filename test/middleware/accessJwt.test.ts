import { Hono } from 'hono'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/config/env'
import {
  _resetJwksCacheForTests,
  accessJwtMiddleware,
  type AccessJwtVariables,
} from '../../src/middleware/accessJwt'

/**
 * Issue #29 — Cloudflare Access JWT middleware.
 *
 * We sign tokens with a locally-generated RS256 key, expose the matching JWK
 * via a stubbed `fetch`, and assert the middleware accepts / rejects each
 * shape. Each test resets the JWKS in-memory cache to keep cases independent.
 */

const TEAM_DOMAIN = 'https://team.cloudflareaccess.test'
const AUD = 'aud-tag-abc'
const JWKS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`

interface SetupResult {
  privateKey: CryptoKey
  kid: string
  jwk: JsonWebKey
}

async function setupKey(): Promise<SetupResult> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  const kid = 'test-kid-1'
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  return { privateKey, kid, jwk: jwk as JsonWebKey }
}

interface SignOpts {
  aud?: string | string[]
  exp?: string | number
  email?: string
  commonName?: string
  noSub?: boolean
}

async function signToken(key: SetupResult, opts: SignOpts = {}): Promise<string> {
  const payload: Record<string, unknown> = {}
  if (opts.email !== undefined) payload.email = opts.email
  if (opts.commonName !== undefined) payload.common_name = opts.commonName

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuedAt()
    .setAudience(opts.aud ?? AUD)

  if (opts.exp !== undefined) jwt.setExpirationTime(opts.exp)
  else jwt.setExpirationTime('2h')

  if (!opts.noSub) jwt.setSubject('test-subject')
  return jwt.sign(key.privateKey)
}

type CapturedActor = { actor: string | undefined }

function buildApp(captured: CapturedActor) {
  const app = new Hono<{ Bindings: Env; Variables: AccessJwtVariables }>()
  app.use('/protected/*', accessJwtMiddleware())
  app.get('/protected/x', (c) => {
    captured.actor = c.get('actor')
    return c.text('ok')
  })
  return app
}

function stubJwksFetch(jwk: JsonWebKey, opts: { failOnce?: boolean } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith(JWKS_URL)) {
      throw new Error(`Unexpected fetch: ${url}`)
    }
    if (opts.failOnce) {
      opts.failOnce = false
      return new Response('boom', { status: 500 })
    }
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('accessJwtMiddleware (#29)', () => {
  let key: SetupResult

  beforeEach(async () => {
    _resetJwksCacheForTests()
    key = await setupKey()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('200s when JWT is valid and stamps actor=email', async () => {
    stubJwksFetch(key.jwk)
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)
    const jwt = await signToken(key, { email: 'alice@example.com' })

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(200)
    expect(captured.actor).toBe('alice@example.com')
  })

  it('falls back to common_name when email claim is missing', async () => {
    stubJwksFetch(key.jwk)
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)
    const jwt = await signToken(key, { commonName: 'bridge-agent' })

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(200)
    expect(captured.actor).toBe('bridge-agent')
  })

  it('401s when Cf-Access-Jwt-Assertion is missing', async () => {
    stubJwksFetch(key.jwk)
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)

    const res = await app.request(
      '/protected/x',
      {},
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(401)
    expect(captured.actor).toBeUndefined()
  })

  it('401s when AUD claim does not match CF_ACCESS_AUD', async () => {
    stubJwksFetch(key.jwk)
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)
    const jwt = await signToken(key, { aud: 'wrong-aud', email: 'alice@example.com' })

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(401)
    expect(captured.actor).toBeUndefined()
  })

  it('401s when JWT is expired', async () => {
    stubJwksFetch(key.jwk)
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)
    // exp 1 second in the past — jose enforces exp by default.
    const expired = Math.floor(Date.now() / 1000) - 1
    const jwt = await signToken(key, { exp: expired, email: 'alice@example.com' })

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(401)
    expect(captured.actor).toBeUndefined()
  })

  it('401s when JWKS fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)
    const jwt = await signToken(key, { email: 'alice@example.com' })

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as Env,
    )

    expect(res.status).toBe(401)
  })

  it('401s when CF_ACCESS_TEAM_DOMAIN / AUD env are unset (no dev bypass)', async () => {
    const captured: CapturedActor = { actor: undefined }
    const app = buildApp(captured)

    const res = await app.request(
      '/protected/x',
      { headers: { 'Cf-Access-Jwt-Assertion': 'whatever' } },
      {} as Env,
    )

    expect(res.status).toBe(401)
  })

  describe('dev bypass', () => {
    it('passes through when ACCESS_DEV_BYPASS_USER is set and team domain is unset', async () => {
      const captured: CapturedActor = { actor: undefined }
      const app = buildApp(captured)

      const res = await app.request(
        '/protected/x',
        {},
        { ACCESS_DEV_BYPASS_USER: 'local-dev@example.com' } as Env,
      )

      expect(res.status).toBe(200)
      expect(captured.actor).toBe('local-dev@example.com')
    })

    it('REFUSES bypass when team domain is set (= prod-shaped config)', async () => {
      stubJwksFetch(key.jwk)
      const captured: CapturedActor = { actor: undefined }
      const app = buildApp(captured)

      const res = await app.request(
        '/protected/x',
        {}, // no JWT
        {
          CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          CF_ACCESS_AUD: AUD,
          ACCESS_DEV_BYPASS_USER: 'should-be-ignored',
        } as Env,
      )

      expect(res.status).toBe(401)
      expect(captured.actor).toBeUndefined()
    })

    it('still verifies the real JWT when one is provided alongside ACCESS_DEV_BYPASS_USER', async () => {
      stubJwksFetch(key.jwk)
      const captured: CapturedActor = { actor: undefined }
      const app = buildApp(captured)
      const jwt = await signToken(key, { email: 'alice@example.com' })

      const res = await app.request(
        '/protected/x',
        { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
        {
          CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          CF_ACCESS_AUD: AUD,
          ACCESS_DEV_BYPASS_USER: 'should-be-ignored',
        } as Env,
      )

      expect(res.status).toBe(200)
      expect(captured.actor).toBe('alice@example.com')
    })
  })
})
