/**
 * Console → gateway flow versions proxy（2026-10-04 版本化回滚）。
 *
 * GET /api/workflows/:id/versions —— 快照列表（最近 20 版）。
 * restore 的 POST 在子路由 [versionId]/restore/route.ts。
 */

import { type NextRequest } from 'next/server'
import {
  buildUpstreamUrl,
  fail,
  forwardHeaders,
  logProxyError,
  pipeUpstream,
  WORKFLOW_ID_RE,
} from '@/lib/workflow-proxy'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  if (!WORKFLOW_ID_RE.test(id)) {
    return fail(400, 'invalid workflow id')
  }
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}/versions`, ''), {
      headers: forwardHeaders(_req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('flow versions', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
