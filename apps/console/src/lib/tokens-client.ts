/**
 * Browser-side token admin client (P1.10.T8).
 *
 * Thin fetch wrapper over the console's own `/api/tokens/*` proxy routes
 * (which forward to the gateway → new-api). Kept in a small module, rather
 * than inline in the settings component, so the CRUD calls are testable in
 * isolation and the component stays focused on rendering — the same split
 * `chat-client.ts` takes for the chat path.
 *
 * Envelope: the gateway uses `{ success, data?, error? }` (CLAUDE.md API
 * convention). `unwrap()` lifts `data` out on success and throws an `Error`
 * carrying `error` on failure, so callers can `try/catch` a single string.
 * The proxy also surfaces gateway-side 502 (upstream) and 503 (admin key
 * not configured); both are reported as thrown errors with the gateway's
 * `error` text so the UI toast is meaningful.
 */

import { toApiToken, type ApiToken, type NewapiTokenRecord, type TokenFormInput } from './tokens'

/** Standard envelope shared with the gateway / dispatch routes. */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
  detail?: unknown
}

/**
 * new-api's paginated list payload. The gateway returns new-api's body
 * verbatim (`{ success, data: { items, total, page, … } }`); `unwrap` lifts
 * the outer `data`, so `payload` IS the inner page object (`{ items, total }`).
 * Nesting `data` again here would read `payload.data.items` → `undefined`.
 */
interface NewapiListPayload {
  items?: NewapiTokenRecord[]
  total?: number
  page?: number
  page_size?: number
}

/** Throw the gateway's `error` (or a generic fallback) on a non-success. */
async function unwrap<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new Error(`token request failed (${res.status})`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success) {
    throw new Error(body.error ?? `token request failed (${res.status})`)
  }
  return body.data as T
}

export interface ListTokensResult {
  tokens: ApiToken[]
  total: number
}

/**
 * GET /api/tokens — list. Projects each new-api record into the console
 * `ApiToken` view via `toApiToken`. The gateway already upserts a
 * `token_meta` row per item on list, but does not fold the local meta back
 * into the new-api response (the gateway returns new-api's body verbatim),
 * so `remark` / `visibility` are not populated here — they are fetched
 * lazily on detail open. The list is enough for the table (name / key mask
 * / group / quota / status).
 *
 * `payload` is the inner page object (post-`unwrap`), so `items` lives
 * directly on it — NOT under another `data` key.
 */
export async function listTokens(signal?: AbortSignal): Promise<ListTokensResult> {
  const res = await fetch('/api/tokens', { method: 'GET', cache: 'no-store', signal })
  const payload = await unwrap<NewapiListPayload>(res)
  const items = payload.items ?? []
  return {
    tokens: items.map((raw) => toApiToken(raw)),
    total: payload.total ?? items.length,
  }
}

/**
 * GET /api/tokens/:id — fetch one. Returns the projected `ApiToken`.
 * `unwrap` lifts `body.data`, so `payload` is the bare new-api token record
 * (`{ id, key, … }`) — no second `data` layer to peel.
 *
 * NOTE: the gateway upserts `token_meta` on get but still returns new-api's
 * body verbatim, so the local `remark` / `visibility` are NOT folded in here.
 * The edit modal's remark therefore starts empty on detail-open (a known
 * gateway-side limitation; the modal surfaces a hint to re-enter it).
 */
export async function getToken(id: number, signal?: AbortSignal): Promise<ApiToken> {
  const res = await fetch(`/api/tokens/${id}`, { method: 'GET', cache: 'no-store', signal })
  const raw = await unwrap<NewapiTokenRecord>(res)
  return toApiToken(raw)
}

/**
 * POST /api/tokens — create. The gateway splits local-only `meta` out of
 * the payload before forwarding to new-api (new-api rejects unknown fields),
 * so the console sends one body with both the new-api fields and `meta`.
 *
 * new-api does not return the new id on create (just `{ success: true }`),
 * so the caller should re-list to pick up the new row — the gateway syncs
 * `token_meta` on the next list/detail read. (Documented in the route.)
 */
export async function createToken(input: TokenFormInput): Promise<void> {
  const res = await fetch('/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toNewapiPayload(input)),
  })
  await unwrap<unknown>(res)
}

/**
 * PUT /api/tokens/:id — update. `id` is added to the body as `id` (new-api
 * expects id in the body, not the path; the gateway handles that) and the
 * caller's optional `meta` is split out by the gateway and applied to the
 * local `token_meta` row after a successful upstream update.
 */
export async function updateToken(id: number, input: TokenFormInput): Promise<void> {
  const res = await fetch(`/api/tokens/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toNewapiPayload(input)),
  })
  await unwrap<unknown>(res)
}

/** DELETE /api/tokens/:id — delete. new-api soft-deletes; the gateway drops token_meta. */
export async function deleteToken(id: number): Promise<void> {
  const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
  await unwrap<unknown>(res)
}

/** Gateway health probe result (mirrors `/api/gateway-health` body). */
export interface GatewayHealth {
  ok: boolean
  reachable: boolean
  svc?: string
  status?: number
}

/** GET /api/gateway-health — is the gateway reachable + healthy. */
export async function getGatewayHealth(signal?: AbortSignal): Promise<GatewayHealth> {
  const res = await fetch('/api/gateway-health', { method: 'GET', cache: 'no-store', signal })
  if (!res.ok) return { ok: false, reachable: false, status: res.status }
  return (await res.json()) as GatewayHealth
}

/**
 * Translate the console form input into the new-api token payload the
 * gateway forwards. `meta` rides along as a sibling object — the gateway
 * strips it before the upstream call and applies it to `token_meta`.
 *
 * `remainQuota` is new-api's quota-points unit (1$ ≈ 500000) and maps 1:1 to
 * new-api's `remain_quota` — the *remaining* budget, not the original grant
 * (new-api accrues `used_quota` itself; we never write it back). On edit we
 * backfill `remainQuota` from the row's `remainQuota` so saving a name-only
 * edit does not inflate quota. Omit `remainQuota` to leave it untouched
 * (no `remain_quota` key sent). `status` (1/2) is only sent when the caller
 * explicitly toggles enable/disable. `expiredTime` is epoch seconds
 * (-1 / undefined = never).
 */
function toNewapiPayload(input: TokenFormInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: input.name }
  if (input.group !== undefined) payload.group = input.group
  if (input.unlimitedQuota) {
    payload.unlimited_quota = true
    payload.remain_quota = 0
  } else if (input.remainQuota !== undefined && input.remainQuota !== null) {
    payload.unlimited_quota = false
    payload.remain_quota = input.remainQuota
  }
  if (input.expiredTime !== undefined && input.expiredTime !== null) {
    payload.expired_time = input.expiredTime
  }
  // new-api stores the model allowlist as a comma-joined string in `models`.
  // Omit the key entirely when the caller has no value, so new-api keeps the
  // existing allowlist on update (sending `models: ""` would clear it).
  if (input.models !== undefined && input.models !== null && input.models !== '') {
    payload.models = input.models
  }
  // status is only forwarded when the caller explicitly sets it (enable/
  // disable toggle). new-api accepts `status` on PUT; the gateway's
  // `z.record(z.string(), z.unknown())` body schema passes it through.
  if (input.status !== undefined) payload.status = input.status
  if (input.meta) payload.meta = input.meta
  return payload
}
