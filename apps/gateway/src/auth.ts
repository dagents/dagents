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

/** Constant-time string comparison for secret-ish values (tokens, shared
 * secrets). Length mismatch returns false immediately (leaking only length,
 * which response timing already does). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Cross-origin browser guard (default open mode): the gateway runs without
 * auth by default, so any web page the operator visits could otherwise drive
 * the whole API — browsers attach `Origin` to cross-origin requests, and
 * "simple" requests (e.g. text/plain JSON bodies) skip CORS preflight
 * entirely. Binding to 127.0.0.1 does NOT stop the operator's own browser
 * from making those calls.
 *
 * Policy: requests carrying an Origin are allowed when same-origin (origin
 * host === request Host), from a loopback origin (our console on
 * localhost:3000, IAB webviews, etc.), or listed in `GATEWAY_ALLOWED_ORIGINS`
 * (comma-separated exact `host` values, e.g. `console.example:443`).
 * Non-browser clients (curl, CLIs, server-side fetch) send no Origin header
 * and are unaffected.
 */
const LOOPBACK_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

export function originAllowed(origin: string, requestHost: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.host && parsed.host === requestHost) return true
  const wanted = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const extras = (process.env.GATEWAY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const extra of extras) {
    // 接受 `host[:port]` 与带 scheme 的 origin 两种写法；按 hostname 比较
    // （URL 解析会丢默认端口，逐字符比对会漏 https://x 与 x:443 的等价性）。
    let extraHostname = extra
    try {
      extraHostname = new URL(extra.includes('://') ? extra : `https://${extra}`).hostname
    } catch {
      // 非法白名单条目按裸字符串兜底比较
    }
    if (extraHostname === wanted || extra === parsed.host.toLowerCase()) return true
  }
  return LOOPBACK_ORIGIN_HOSTNAMES.has(wanted)
}
