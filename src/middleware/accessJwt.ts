import type { MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Env } from '../config/env'

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

// `audience: 'mcp'` verifies against a separate Access application's AUD (CF_ACCESS_MCP_AUD),
// not the main app's — scoping a service token's reach to the read-only /mcp app instead of
// letting it also pass the main trading app's Access check, which would reach /admin writes.
// Falls back to CF_ACCESS_AUD when CF_ACCESS_MCP_AUD is unset, for setups that add the Service
// Auth policy to the main app instead of a dedicated one.
//
// Every failure path returns 401, including missing CF_ACCESS_TEAM_DOMAIN/AUD config — an
// unconfigured deployment must not silently allow requests through.
export function accessJwtMiddleware(opts?: { audience?: 'default' | 'mcp' }): MiddlewareHandler<{
  Bindings: Env
  Variables: AccessJwtVariables
}> {
  return async (c, next) => {
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim()
    const audience =
      opts?.audience === 'mcp'
        ? c.env.CF_ACCESS_MCP_AUD?.trim() || c.env.CF_ACCESS_AUD?.trim()
        : c.env.CF_ACCESS_AUD?.trim()
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
