import { timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'

/**
 * Gateway programmatic auth — API key + daemon token helpers.
 *
 * Login/SSO was removed: the gateway is a local-machine service and runs open
 * by default. These helpers keep the optional `GATEWAY_API_KEY` bearer gate
 * for operators who expose the gateway beyond localhost; when no key is
 * configured the gateway is fully open.
 */

/** The env-held API key for programmatic access (scripts, CI). */
export function gatewayApiKey(): string {
  return process.env.GATEWAY_API_KEY ?? ''
}

/** The token required to register new daemons. */
export function daemonRegisterToken(): string {
  return process.env.DAEMON_REGISTER_TOKEN ?? ''
}

/** True when the optional `GATEWAY_API_KEY` gate is configured. */
export function authConfigured(): boolean {
  return gatewayApiKey().length >= 16
}

/** True when every non-public route requires the gateway API key. */
export function requireAuth(): boolean {
  return gatewayApiKey().length >= 16
}

/**
 * Verify a gateway API key in constant time. The expected key is read from
 * `GATEWAY_API_KEY` (16+ chars). Returns false when no key is configured or
 * when the provided key doesn't match — never throws.
 */
export function verifyApiKey(provided: string | null | undefined): boolean {
  const expected = gatewayApiKey()
  if (!expected || expected.length < 16) return false
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Extract a bearer token from the `Authorization` header. Returns the token
 * (trimmed) when present, null otherwise. Header matching is case-insensitive
 * on the scheme per RFC 7235.
 */
export function bearerFromRequest(c: Context): string | null {
  const auth = c.req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null
  }
  return null
}
