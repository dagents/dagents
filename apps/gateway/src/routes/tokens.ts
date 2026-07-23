import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import {
  ALLOW_RESPONSE_HEADERS,
  adminRequestHeaders,
  newapiBaseUrl,
  newapiAdminConfigured,
  newapiLog as log,
} from '../newapi.js'
import { recordAudit } from '../audit.js'

/**
 * `/api/v1/tokens/*` → new-api `/api/token/*` admin proxy + local `token_meta`
 * sync (plan M2.8 / P1.4.T5).
 *
 * The frontend never talks to new-api directly. The gateway authenticates to
 * new-api with the admin access token (`NEWAPI_ADMIN_KEY` + `New-Api-User`),
 * so the proxy:
 *   - strips the caller's `authorization` / `new-api-user` (no impersonation),
 *   - injects the admin credentials,
 *   - rewrites `/api/v1/tokens` → `/api/token`,
 *   - and keeps `token_meta` in sync for create/get/update/delete so the
 *     console has local label/group/visibility + probe status without a key.
 *
 * new-api masks the token `key` in its own responses, so the raw key never
 * crosses this route and is never persisted to `token_meta` (only the int
 * `newapi_token_id` is).
 *
 * Status: non-2xx upstream bodies are collapsed to a sanitized 502 (new-api
 * error bodies can carry internal detail), matching the Flowise proxy's
 * posture. The admin key not being configured is a 503, not a 401, so we don't
 * advertise new-api's auth shape.
 */
export const tokensRoutes = new Hono()

// Local-only editorial fields the console can set alongside a new-api token.
// `name`/`group` are mirrored to new-api; `remark`/`visibility` live only here.
const metaPatchSchema = z.object({
  remark: z.string().max(500).optional(),
  visibility: z.enum(['private', 'workspace', 'public']).optional(),
})

/** Standard envelope (CLAUDE.md API convention): { success, data?, error? }. */
const fail = (c: Context, status: 400 | 502 | 503, error: string, extra?: Record<string, unknown>) =>
  c.json({ success: false, error, ...extra }, status)

tokensRoutes.use('/*', async (c, next) => {
  if (!newapiAdminConfigured()) {
    return fail(c, 503, 'token admin not configured')
  }
  await next()
})

/**
 * After a new-api create, list, get, update, or delete, reconcile the local
 * `token_meta` row. `newapiTokenId` is the int id new-api assigned; `name` and
 * `group` are mirrored from new-api so the console list matches. `remark` /
 * `visibility` are local-only and only touched when the caller patches them.
 */
async function upsertTokenMeta(args: {
  newapiTokenId: number
  name?: string
  group?: string
  remark?: string | null
  visibility?: string
  workspaceId?: string | null
}): Promise<void> {
  const remark = args.remark ?? null
  const visibility = args.visibility ?? 'workspace'
  const workspaceId = args.workspaceId ?? null
  await runQuery(
    `INSERT INTO token_meta (newapi_token_id, name, "group", remark, visibility, workspace_id, status, created_at, updated_at)
     VALUES ($1, COALESCE($2,''), COALESCE($3,'default'), $4, $5, $6, 'unknown', NOW(), NOW())
     ON CONFLICT (newapi_token_id) DO UPDATE
       SET name = COALESCE($2, token_meta.name),
           "group" = COALESCE($3, token_meta."group"),
           remark = COALESCE($4, token_meta.remark),
           visibility = COALESCE($5, token_meta.visibility),
           workspace_id = COALESCE($6, token_meta.workspace_id),
           updated_at = NOW()`,
    [
      args.newapiTokenId,
      args.name ?? null,
      args.group ?? null,
      remark,
      visibility,
      workspaceId,
    ],
  )
}

async function deleteTokenMeta(newapiTokenId: number): Promise<void> {
  await runQuery(`DELETE FROM token_meta WHERE newapi_token_id = $1`, [newapiTokenId])
}

/**
 * Extract the new-api token id from a proxied path. The frontend uses the
 * RESTful id form `/api/v1/tokens/:id[/...]`; `:id` is new-api's integer token
 * id. We accept only digits so `/api/v1/tokens/../foo` can't reach new-api.
 */
function parseTokenId(seg: string): number | null {
  if (!/^\d+$/.test(seg)) return null
  const n = Number(seg)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Core proxy: forward `method /api/v1/tokens[/...]` to new-api
 * `method /api/token[/...]`, streaming the body and applying the admin auth
 * header set. Returns the upstream Response (caller decides how to render it).
 */
async function proxyToNewapi(c: Context, upstreamPath: string): Promise<Response> {
  const inbound = new URL(c.req.url)
  const method = c.req.method
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const body = hasBody ? await c.req.text() : undefined

  const headers = adminRequestHeaders(c.req.raw.headers, hasBody ? 'application/json' : undefined)
  const upstreamUrl = new URL(upstreamPath, newapiBaseUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body })
  } catch (err) {
    log.error('new-api proxy failed', { path: upstreamPath, method, error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }
  return upstream
}

/** Sanitize + render an upstream Response: allowlist headers, collapse 5xx. */
async function renderUpstream(c: Context, upstream: Response, runId?: string): Promise<Response> {
  if (!upstream.ok) {
    log.warn('upstream error', { status: upstream.status, runId })
    return fail(c, 502, 'upstream error', { upstreamStatus: upstream.status })
  }
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

/**
 * GET /api/v1/tokens — list. Mirrors new-api's paginated `{ data: { items, total, page } }`,
 * then upserts a `token_meta` row for each item so the console list has local
 * metadata. The masked keys pass through untouched.
 */
tokensRoutes.get('/', async (c) => {
  const upstream = await proxyToNewapi(c, '/api/token/')
  if (!upstream.ok) return renderUpstream(c, upstream)

  let json: unknown
  try {
    json = await upstream.json()
  } catch {
    return renderUpstream(c, upstream)
  }
  const data = (json as { data?: { items?: Array<Record<string, unknown>> } })?.data
  const items = Array.isArray(data?.items) ? data!.items! : []
  for (const item of items) {
    const id = typeof item.id === 'number' ? item.id : Number(item.id)
    if (!Number.isSafeInteger(id) || id <= 0) continue
    await upsertTokenMeta({
      newapiTokenId: id,
      name: typeof item.name === 'string' ? item.name : undefined,
      group: typeof item.group === 'string' ? item.group : undefined,
    })
  }
  return c.json(json, upstream.status as 200)
})

/**
 * GET /api/v1/tokens/:id — fetch one. Upserts `token_meta` for the id so a
 * detail view has a local row even on first open.
 */
tokensRoutes.get('/:id', async (c) => {
  const id = parseTokenId(c.req.param('id'))
  if (id === null) return fail(c, 400, 'invalid token id')
  const upstream = await proxyToNewapi(c, `/api/token/${id}`)
  if (!upstream.ok) return renderUpstream(c, upstream, String(id))

  let json: unknown
  try {
    json = await upstream.json()
  } catch {
    return renderUpstream(c, upstream, String(id))
  }
  const data = (json as { data?: Record<string, unknown> })?.data
  if (data && typeof data.id === 'number') {
    await upsertTokenMeta({
      newapiTokenId: data.id,
      name: typeof data.name === 'string' ? data.name : undefined,
      group: typeof data.group === 'string' ? data.group : undefined,
    })
  }
  return c.json(json, upstream.status as 200)
})

/**
 * POST /api/v1/tokens — create. Body is the new-api token payload; the caller
 * may add a `meta` object ({ remark, visibility }) which is stripped before
 * forwarding (new-api rejects unknown fields) and applied to the local row.
 *
 * new-api does NOT return the new id on create (just `{ success: true }`), so
 * we can't upsert `token_meta` here with a known id. The list/detail GET syncs
 * it on next read; `meta` from the create body is dropped — the console should
 * PATCH it after the id is known. (Documented in the route comment.)
 */
tokensRoutes.post('/', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!parsed.success) return fail(c, 400, 'invalid body', { detail: parsed.error.message })

  // Split local-only `meta` from the new-api payload so new-api gets exactly
  // the token fields it owns and the console's editorial fields stay local.
  const { meta: _meta, ...newapiPayload } = parsed.data

  const upstream = await proxyToNewapiBody(c, JSON.stringify(newapiPayload), '/api/token/')
  // Audit the create attempt: new-api does NOT return the new id on create
  // (just `{ success: true }`), so we can't name the target id here — the
  // audit row records the create verb + the requested name for forensic value.
  // The list/detail GET syncs the real id on next read. Best-effort: the write
  // is awaited so the audit lands before the response, but `recordAudit`
  // swallows every error (fire-and-forget contract) so a failed write never
  // blocks or fails the create.
  if (upstream.ok) {
    await recordAudit(c, {
      action: 'token.create',
      target: { type: 'token', id: String(newapiPayload.name ?? '') },
      detail: { name: newapiPayload.name ?? null, group: newapiPayload.group ?? null },
    })
  }
  return renderUpstream(c, upstream)
})

/** Forward a pre-buffered JSON body (used when we rewrite the payload). */
async function proxyToNewapiBody(
  c: Context,
  body: string,
  upstreamPath: string,
): Promise<Response> {
  const inbound = new URL(c.req.url)
  const headers = adminRequestHeaders(c.req.raw.headers, 'application/json')
  const upstreamUrl = new URL(upstreamPath, newapiBaseUrl())
  upstreamUrl.search = inbound.search
  try {
    return await fetch(upstreamUrl, { method: 'POST', headers, body })
  } catch (err) {
    log.error('new-api proxy failed', { path: upstreamPath, method: 'POST', error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }
}

/**
 * PUT /api/v1/tokens/:id — update. `:id` is added to the body as `id` (new-api
 * expects id in the body, not the path) and the caller's optional `meta` is
 * split out and applied to `token_meta` after a successful upstream update.
 */
tokensRoutes.put('/:id', async (c) => {
  const id = parseTokenId(c.req.param('id'))
  if (id === null) return fail(c, 400, 'invalid token id')
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!parsed.success) return fail(c, 400, 'invalid body', { detail: parsed.error.message })

  const { meta, ...newapiPayload } = parsed.data
  newapiPayload.id = id

  const upstream = await proxyToNewapiBody(c, JSON.stringify(newapiPayload), `/api/token/`)
  if (!upstream.ok) return renderUpstream(c, upstream, String(id))

  // best-effort local meta sync — re-read name/group from new-api on success
  let name: string | undefined
  let group: string | undefined
  try {
    const refetch = await fetch(`${newapiBaseUrl()}/api/token/${id}`, {
      headers: adminRequestHeaders(new Headers()),
    })
    if (refetch.ok) {
      const refData = (await refetch.json()) as { data?: Record<string, unknown> }
      name = typeof refData.data?.name === 'string' ? refData.data.name : undefined
      group = typeof refData.data?.group === 'string' ? refData.data.group : undefined
    }
  } catch (err) {
    log.warn('post-update refetch failed', { id, error: String(err) })
  }

  const metaParsed = metaPatchSchema.safeParse(meta ?? {})
  await upsertTokenMeta({
    newapiTokenId: id,
    name,
    group,
    remark: metaParsed.success ? metaParsed.data.remark : undefined,
    visibility: metaParsed.success ? metaParsed.data.visibility : undefined,
  })
  // Audit the update: target id is the new-api token id; detail captures the
  // editorial fields the caller touched (never the raw key). Best-effort: the
  // write is awaited so the audit lands before the response, but `recordAudit`
  // swallows every error so a failed write never blocks or fails the update.
  await recordAudit(c, {
    action: 'token.update',
    target: { type: 'token', id: String(id) },
    detail: {
      name: newapiPayload.name ?? null,
      group: newapiPayload.group ?? null,
      remark: metaParsed.success ? metaParsed.data.remark ?? null : null,
      visibility: metaParsed.success ? metaParsed.data.visibility ?? null : null,
    },
  })
  return c.json({ success: true }, upstream.status as 200)
})

/**
 * DELETE /api/v1/tokens/:id — delete. new-api soft-deletes (gorm.DeletedAt);
 * we drop the local `token_meta` row so it stops appearing in the console.
 */
tokensRoutes.delete('/:id', async (c) => {
  const id = parseTokenId(c.req.param('id'))
  if (id === null) return fail(c, 400, 'invalid token id')
  const upstream = await proxyToNewapi(c, `/api/token/${id}`)
  if (!upstream.ok) return renderUpstream(c, upstream, String(id))
  await deleteTokenMeta(id)
  // Audit the delete (destructive — record after the upstream + local-meta
  // delete both succeed). Best-effort: the write is awaited so the audit lands
  // before the response, but `recordAudit` swallows every error so a failed
  // write never blocks or fails the delete.
  await recordAudit(c, {
    action: 'token.delete',
    target: { type: 'token', id: String(id) },
  })
  return c.json({ success: true }, upstream.status as 200)
})
