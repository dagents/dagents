/**
 * `GET /api/workspaces/[id]` — one workspace's detail proxy (M5b.1 / P1.10.T6).
 *
 * Forwards to the gateway's `GET /api/v1/workspaces/:id`, which returns the
 * workspace row + members + linked flows (enriched with live Flowise name/
 * status) + an artifact count rollup. The gateway URL stays server-side.
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
  // Forward the path segment verbatim; the gateway validates the UUID shape
  // (400 on malformed, 404 on missing). Encoding here is defensive against a
  // stray `/` in the segment.
  let upstream: Response
  try {
    upstream = await fetch(
      buildWorkspaceUpstreamUrl(`/${encodeURIComponent(id)}`, req.nextUrl.search),
      { method: 'GET', headers: forwardWorkspaceHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    workspaceLogProxyError('detail', err)
    return workspaceFail(502, 'gateway unavailable')
  }
  return pipeWorkspaceUpstream(upstream)
}
