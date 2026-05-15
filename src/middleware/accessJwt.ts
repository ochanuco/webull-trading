import type { MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Env } from '../config/env'

/**
 * Cloudflare Access JWT verification middleware (#29).
 *
 * Cloudflare attaches `Cf-Access-Jwt-Assertion` at edge for any request that
 * passed the Access application policy. We verify the signature against the
 * team's JWKS endpoint and check the AUD claim matches the configured
 * application AUD tag. On success we expose the principal via `c.set('actor',
 * ...)` so the audit log layer can attribute the mutation to a real identity
 * (SSO email or service token common_name) instead of a hard-coded 'ai-agent'.
 *
 * Failure modes are all 401:
 *   - missing CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD config (fail-closed; an
 *     unconfigured prod must not silently allow requests)
 *   - missing or unparseable Cf-Access-Jwt-Assertion
 *   - JWKS fetch / signature verify failure
 *   - AUD claim mismatch
 *   - expired JWT (jose enforces exp by default)
 *
 * Dev bypass: when `ACCESS_DEV_BYPASS_USER` is set AND `CF_ACCESS_TEAM_DOMAIN`
 * is unset (= no real Access in front of us, i.e. `wrangler dev`), we skip
 * verification and set actor to the bypass value. Both conditions must hold
 * so accidentally setting the bypass in prod (where team domain is mandatory)
 * cannot disable auth.
 */
export interface AccessJwtVariables {
  actor: string
}

interface JwksCacheEntry {
  jwks: JWTVerifyGetKey
  fetchedAt: number
}

const JWKS_TTL_MS = 5 * 60 * 1000

const jwksCache = new Map<string, JwksCacheEntry>()

function getJwks(teamDomain: string): JWTVerifyGetKey {
  const now = Date.now()
  const cached = jwksCache.get(teamDomain)
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.jwks
  }
  const jwksUrl = new URL('/cdn-cgi/access/certs', teamDomain)
  const jwks = createRemoteJWKSet(jwksUrl)
  jwksCache.set(teamDomain, { jwks, fetchedAt: now })
  return jwks
}

/** Exported for tests so each case starts from a clean isolate state. */
export function _resetJwksCacheForTests(): void {
  jwksCache.clear()
}

interface AccessClaims extends JWTPayload {
  email?: string
  common_name?: string
}

function pickActor(payload: AccessClaims): string {
  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
  if (email.length > 0) return email
  const commonName = typeof payload.common_name === 'string' ? payload.common_name.trim() : ''
  if (commonName.length > 0) return commonName
  return 'unknown'
}

export function accessJwtMiddleware(): MiddlewareHandler<{
  Bindings: Env
  Variables: AccessJwtVariables
}> {
  return async (c, next) => {
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim()
    const audience = c.env.CF_ACCESS_AUD?.trim()
    const devBypassUser = c.env.ACCESS_DEV_BYPASS_USER?.trim()

    const jwt = c.req.header('Cf-Access-Jwt-Assertion')

    // Dev bypass: only honoured when team domain is unset (= wrangler dev,
    // no real Access in front). In prod the team domain is always configured
    // so even a leaked ACCESS_DEV_BYPASS_USER cannot disable verification.
    if (!teamDomain && devBypassUser && !jwt) {
      c.set('actor', devBypassUser)
      return next()
    }

    if (!teamDomain || !audience) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    if (!jwt) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    try {
      const jwks = getJwks(teamDomain)
      const { payload } = await jwtVerify(jwt, jwks, {
        audience,
        algorithms: ['RS256'],
      })
      c.set('actor', pickActor(payload as AccessClaims))
      return next()
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  }
}
