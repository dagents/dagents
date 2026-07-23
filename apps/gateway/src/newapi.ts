import { createLogger } from '@mil/shared'

/**
 * new-api upstream client (plan M2.8 / P1.4.T5/T8/T10).
 *
 * new-api is the system of record for LLM tokens: it owns the token *key* and
 * the quota/lifecycle status. The gateway sits in front of it so the frontend
 * never talks to new-api directly — `/api/v1/tokens/*` proxies the admin token
 * CRUD, `/api/v1/llm/*` transparently forwards LLM calls with the caller's own
 * `sk-` token, and the health probe polls new-api for token status.
 *
 * ## Admin auth (token CRUD + probe)
 * new-api's `/api/token/*` admin routes accept EITHER a login session cookie
 * OR a per-user "access token" (stored in new-api `users.access_token`) sent as
 * the **raw** `Authorization` header — NOT `Bearer`, the bare token — together
 * with a `New-Api-User: <user-id>` header naming the user the token belongs to.
 * The access token is generated once (UI or `GET /api/user/token`) and reused.
 *
 * `NEWAPI_ADMIN_KEY` = root's access token; `NEWAPI_ADMIN_USER_ID` = root's id
 * (`1` by default). When the key is absent the proxy returns 503 rather than
 * leaking a 401 that exposes the auth shape.
 *
 * ## Key masking
 * new-api masks the token `key` in its own list/get responses (e.g.
 * `lo0J**********RyYf`), so the raw key never traverses the gateway and is
 * never written to `token_meta`. `token_meta.newapi_token_id` is the int FK.
 */

const log = createLogger({ svc: 'gateway:newapi' })

export const newapiBaseUrl = (): string =>
  (process.env.NEWAPI_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export const newapiAdminKey = (): string => process.env.NEWAPI_ADMIN_KEY ?? ''

export const newapiAdminUserId = (): string =>
  process.env.NEWAPI_ADMIN_USER_ID ?? '1'

/** True when the admin key is configured — callers 503 fast when it isn't. */
export const newapiAdminConfigured = (): boolean => newapiAdminKey().length > 0

/** new-api integer token statuses (model/token.go + common/constants.go). */
export const NEWAPI_TOKEN_STATUS = {
  ENABLED: 1,
  DISABLED: 2,
  EXPIRED: 3,
  EXHAUSTED: 4,
} as const

/**
 * Hop-by-hop / client-specific headers that must not be forwarded by a proxy
 * (RFC 7230 §6.1). `host` and `content-length` are dropped too — undici sets
 * its own from the upstream URL and the buffered body. Mirrors `app.ts`.
 */
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

/** Response headers passed through to the client (allowlist, not blocklist). */
export const ALLOW_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
])

const connectionListedFields = (connectionHeader: string | null | undefined): string[] => {
  if (!connectionHeader) return []
  return connectionHeader
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== 'close' && s !== 'keep-alive')
}

/**
 * Build the upstream request headers for an admin new-api call: copy the
 * inbound headers minus hop-by-hop + Connection-listed fields, then force the
 * admin auth. The caller's own `authorization` / `new-api-user` (if any) are
 * stripped so a frontend can't impersonate an arbitrary new-api user.
 */
export function adminRequestHeaders(
  inbound: Headers,
  contentType?: string,
): Headers {
  const drop = new Set(DROP_REQUEST_HEADERS)
  drop.add('authorization')
  drop.add('new-api-user')
  for (const f of connectionListedFields(inbound.get('connection'))) {
    drop.add(f)
  }
  const out = new Headers()
  for (const [k, v] of inbound.entries()) {
    if (drop.has(k.toLowerCase())) continue
    out.set(k, v)
  }
  out.set('Authorization', newapiAdminKey())
  out.set('New-Api-User', newapiAdminUserId())
  if (contentType) out.set('content-type', contentType)
  return out
}

/**
 * Map a new-api token record (from `GET /api/token/:id` or list items) to the
 * local `token_meta.status` value (P1.4.T8). new-api flips `status` lazily on
 * use; we re-derive expired/exhausted from `expired_time` / `remain_quota` so
 * the probe reflects reality without waiting for a request to trip it.
 */
export function mapNewapiTokenStatus(token: {
  status: number
  expired_time?: number
  remain_quota?: number
  unlimited_quota?: boolean
}): 'active' | 'disabled' | 'expired' | 'exhausted' {
  const nowSec = Math.floor(Date.now() / 1000)
  if (token.expired_time && token.expired_time !== -1 && token.expired_time < nowSec) {
    return 'expired'
  }
  if (!token.unlimited_quota && (token.remain_quota ?? 0) <= 0) {
    return 'exhausted'
  }
  switch (token.status) {
    case NEWAPI_TOKEN_STATUS.DISABLED:
      return 'disabled'
    case NEWAPI_TOKEN_STATUS.EXPIRED:
      return 'expired'
    case NEWAPI_TOKEN_STATUS.EXHAUSTED:
      return 'exhausted'
    default:
      return 'active'
  }
}

/**
 * Probe one new-api token by id via the admin API and return its health.
 * `GET /api/token/:id` → `{ success, data: { id, status, ... } }`. A 429 from
 * new-api is a transient rate-limit on the admin surface, distinct from the
 * token's own status; we surface it as `rate_limited`. Network failure /
 * unexpected shape → `error` (probe inconclusive, don't clobber a known-good
 * status silently — the caller decides whether to write it).
 */
export async function probeTokenHealth(
  newapiTokenId: number,
): Promise<{ status: 'active' | 'disabled' | 'expired' | 'exhausted' | 'rate_limited' | 'error'; detail?: string }> {
  const url = `${newapiBaseUrl()}/api/token/${newapiTokenId}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: newapiAdminKey(),
        'New-Api-User': newapiAdminUserId(),
      },
    })
  } catch (err) {
    log.warn('probe fetch failed', { newapiTokenId, error: String(err) })
    return { status: 'error', detail: String(err) }
  }

  if (res.status === 429) return { status: 'rate_limited' }
  if (!res.ok) {
    log.warn('probe upstream non-ok', { newapiTokenId, status: res.status })
    return { status: 'error', detail: `upstream status ${res.status}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return { status: 'error', detail: `bad json: ${String(err)}` }
  }
  const data = (body as { success?: boolean; data?: Record<string, unknown> })?.data
  if (!data || typeof data.status !== 'number') {
    return { status: 'error', detail: 'unexpected token shape' }
  }
  return {
    status: mapNewapiTokenStatus({
      status: data.status,
      expired_time: data.expired_time as number | undefined,
      remain_quota: data.remain_quota as number | undefined,
      unlimited_quota: data.unlimited_quota as boolean | undefined,
    }),
  }
}

export { log as newapiLog }
