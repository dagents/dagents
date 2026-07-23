/**
 * `GET /api/workspaces/[id]/threads` — conversation thread proxy (M5b.1 /
 * P1.10.T6).
 *
 * Forwards to the gateway's `GET /api/v1/workspaces/:id/threads`, which
 * returns the runs scoped to the workspace (the conversation thread — each
 * run is one turn carrying the OTel `run_id`). `limit` / `before` query
 * params are forwarded as-is for pagination. The gateway URL stays server-side.
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildWorkspaceUpstreamUrl(`/${encodeURIComponent(id)}/threads`, req.nextUrl.search),
      { method: 'GET', headers: forwardWorkspaceHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    workspaceLogProxyError('threads', err)
    return workspaceFail(502, 'gateway unavailable')
  }
  return pipeWorkspaceUpstream(upstream)
}
