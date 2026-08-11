/**
 * Browser-side audit log client.
 *
 * Thin fetch wrapper over the console's `/api/audit` proxy route (which
 * forwards to the gateway's `GET /api/v1/audit`). Kept in a small module,
 * rather than inline in the component, so the fetch + envelope-unwrap logic is
 * testable in isolation and the component stays focused on rendering.
 *
 * Envelope: the gateway uses `{ success, data?, error? }` (CLAUDE.md API
 * convention). `unwrap()` lifts `data` out on success and throws an `Error`
 * carrying `error` on failure.
 *
 * Naming note: the gateway response uses `{ items, nextBefore }` (snake-case
 * DB rows → camelCased at the route boundary). This module renames to
 * `{ entries, nextCursor }` to match the spec's audit-list vocabulary and
 * keep the cursor semantics self-documenting.
 */

/** A single audit log row — camelCased from the gateway's response. */
export interface AuditEntry {
  id: string
  actorType: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  runId: string | null
  workspaceId: string | null
  detail: Record<string, unknown> | null
  ip: string | null
  userAgent: string | null
  createdAt: string
}

/** Paginated audit list — `entries` + an opaque cursor for the next page. */
export interface AuditListResponse {
  entries: AuditEntry[]
  nextCursor: string | null
}

/** Query params for `fetchAudit`. All optional; absent filters are omitted. */
export interface AuditQuery {
  actorType?: string
  action?: string
  targetType?: string
  targetId?: string
  before?: string
  limit?: number
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
  detail?: unknown
}

/** Raw gateway response shape (before the items/nextBefore rename). */
interface GatewayAuditData {
  items: AuditEntry[]
  nextBefore: string | null
}

async function unwrap(res: Response): Promise<GatewayAuditData> {
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new Error(`审计日志请求失败 (${res.status})`)
  }
  const body = (await res.json()) as Envelope<GatewayAuditData>
  if (!body.success || !body.data) {
    throw new Error(body.error ?? `审计日志请求失败 (${res.status})`)
  }
  return body.data
}

/**
 * Fetch a page of audit entries from the gateway (via the console proxy).
 *
 * Returns `{ entries, nextCursor }`. `nextCursor` is `null` on the last page.
 * Callers walk older pages by passing `before: nextCursor` on the next call.
 */
export async function fetchAudit(
  params: AuditQuery,
  signal?: AbortSignal,
): Promise<AuditListResponse> {
  const search = new URLSearchParams()
  if (params.actorType) search.set('actorType', params.actorType)
  if (params.action) search.set('action', params.action)
  if (params.targetType) search.set('targetType', params.targetType)
  if (params.targetId) search.set('targetId', params.targetId)
  if (params.before) search.set('before', params.before)
  if (params.limit != null) search.set('limit', String(params.limit))

  const qs = search.toString()
  const url = qs ? `/api/audit?${qs}` : '/api/audit'

  const res = await fetch(url, { method: 'GET', cache: 'no-store', signal })
  const data = await unwrap(res)
  return {
    entries: data.items,
    nextCursor: data.nextBefore,
  }
}
