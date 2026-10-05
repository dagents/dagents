/**
 * Console → gateway flow version restore proxy（2026-10-04 版本化回滚）。
 *
 * POST /api/workflows/:id/versions/:versionId/restore —— 回滚到指定快照
 * （gateway 侧回滚前自动存档当前结构，回滚本身可撤销）。
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

const VERSION_ID_RE = /^[0-9a-fA-F-]{36}$/

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  const { id, versionId } = await params
  if (!WORKFLOW_ID_RE.test(id) || !VERSION_ID_RE.test(versionId)) {
    return fail(400, 'invalid ids')
  }
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}/versions/${versionId}/restore`, ''), {
      method: 'POST',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('flow version restore', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
