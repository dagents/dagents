import { Hono, type Context } from 'hono'
import {
  ALLOW_RESPONSE_HEADERS,
  newapiBaseUrl,
  newapiLog as log,
} from '../newapi.js'

/**
 * `/api/v1/llm/*` → new-api `/v1/*` transparent LLM passthrough (plan M2.8 /
 * P1.4.T10).
 *
 * Unlike `/api/v1/tokens/*` (admin), this route is **not** admin-authenticated:
 * the caller supplies its own `sk-` token in `Authorization: Bearer ...`, and
 * the gateway forwards it verbatim to new-api's OpenAI-compatible surface. The
 * point is to make new-api the single LLM upstream — Flowise / daemon / console
 * all point at the gateway, which then forwards to new-api — so billing,
 * routing, and observability all live behind one door.
 *
 * We do NOT inject the admin key here: a passthrough that swapped the caller's
 * token for the admin key would let any client spend admin quota and would
 * lose per-token attribution. The caller's `Authorization` is forwarded as-is.
 *
 * Path rewrite: `/api/v1/llm/chat/completions` → new-api `/v1/chat/completions`.
 * Hop-by-hop + Connection-listed headers are stripped (RFC 7230 §6.1); the
 * response is allowlisted so new-api's `x-*` / `set-cookie` / server banner
 * can't leak. Upstream 5xx bodies are collapsed to a sanitized 502.
 */
export const llmRoutes = new Hono()

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
])

const connectionListedFields = (connectionHeader: string | null | undefined): string[] => {
  if (!connectionHeader) return []
  return connectionHeader
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== 'close' && s !== 'keep-alive')
}

/** Standard envelope (CLAUDE.md API convention): { success, data?, error? }. */
const fail = (c: Context, status: 400 | 502, error: string, extra?: Record<string, unknown>) =>
  c.json({ success: false, error, ...extra }, status)

llmRoutes.all('/*', async (c) => {
  const inbound = new URL(c.req.url)
  // /api/v1/llm/chat/completions  →  /v1/chat/completions
  const rest = inbound.pathname.replace(/^\/api\/v1\/llm\//, '')
  if (!rest || rest.includes('..')) {
    return fail(c, 400, 'unsupported llm path')
  }
  const upstreamPath = `/v1/${rest}`

  const method = c.req.method
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)

  // The caller's Authorization is the only credential we forward — no admin
  // key, no impersonation. Require it so an anonymous request 401s at the edge
  // rather than reaching new-api.
  const auth = c.req.header('authorization')
  if (!auth) {
    return fail(c, 400, 'missing authorization')
  }

  const drop = new Set(DROP_REQUEST_HEADERS)
  for (const f of connectionListedFields(c.req.raw.headers.get('connection'))) {
    drop.add(f)
  }
  const fwdHeaders = new Headers()
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (drop.has(k.toLowerCase())) continue
    fwdHeaders.set(k, v)
  }

  // Buffer the body so undici sets an accurate content-length (LLM bodies are
  // modest JSON; we avoid `duplex: 'half'` streaming complexity).
  const body = hasBody ? await c.req.text() : undefined
  const upstreamUrl = new URL(upstreamPath, newapiBaseUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers: fwdHeaders, body })
  } catch (err) {
    log.error('llm upstream failed', { path: upstreamPath, method, error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }

  // LLM calls forward the caller's token, so a 401/403/429 from new-api is
  // meaningful to the client (bad key / quota / rate limit) — pass the status
  // through. Only collapse genuine 5xx to a sanitized 502.
  if (upstream.status >= 500) {
    log.warn('llm upstream 5xx', { path: upstreamPath, method, status: upstream.status })
    return fail(c, 502, 'upstream error', { upstreamStatus: upstream.status })
  }

  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  // Streaming responses (text/event-stream) keep their content-type via the
  // allowlist; the body streams straight through.
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
})
