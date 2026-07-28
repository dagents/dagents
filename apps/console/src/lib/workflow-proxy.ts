/**
 * Shared helpers for the `/api/workflows/*` gateway proxy routes.
 *
 * Both the collection route (`/api/workflows`) and the item route
 * (`/api/workflows/:id`) forward to the gateway's `/api/v1/workflows/*`
 * CRUD API. The wiring is identical except for the path segment, so the
 * URL-building / header-forwarding / response-piping live here once.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@dagents/shared'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'

const proxyLog = createLogger({ svc: 'console:workflow-proxy' })

export const WORKFLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/workflows${path}`
  return search ? `${base}${search}` : base
}

export function forwardHeaders(req: NextRequest, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'x-run-id': resolveRunId(req.headers.get('x-run-id')),
  }
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  if (hasBody) headers['content-type'] = req.headers.get('content-type') ?? 'application/json'
  return headers
}

export function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

export function logProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

export async function pipeUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
