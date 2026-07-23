/**
 * `GET /api/workspaces` — workspace project list proxy (M5b.1 / P1.10.T6).
 *
 * The browser Workspace view GETs this route; it forwards to the gateway's
 * `/api/v1/workspaces` read API (`apps/gateway/src/routes/workspaces.ts`),
 * which lists projects (active by default) with member/flow counts. The
 * gateway URL stays server-side (no CORS, no origin leak) — same posture as
 * the `/api/agents` / `/api/fleet-stats` proxies.
 *
 * Query params (`includeArchived`, `limit`) are forwarded as-is; the gateway
 * validates + clamps them. `x-run-id` is threaded through for trace
 * correlation. Read-only — no body, no writes.
 */

import { type NextRequest } from 'next/server'
import {
  buildWorkspaceUpstreamUrl,
  forwardWorkspaceHeaders,
  pipeWorkspaceUpstream,
  workspaceFail,
  workspaceLogProxyError,
} from '@/lib/workspace-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/workspaces — list. Forwards the gateway's project list verbatim. */
export async function GET(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildWorkspaceUpstreamUrl('', req.nextUrl.search), {
      method: 'GET',
      headers: forwardWorkspaceHeaders(req),
      cache: 'no-store',
    })
  } catch (err) {
    workspaceLogProxyError('list', err)
    return workspaceFail(502, 'gateway unavailable')
  }
  return pipeWorkspaceUpstream(upstream)
}
