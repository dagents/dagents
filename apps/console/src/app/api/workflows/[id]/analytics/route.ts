/**
 * Console → gateway flow analytics proxy（2026-10-04 节点类型画像/趋势）。
 *
 * GET /api/workflows/:id/analytics —— run_node_spans + runs 的只读聚合：
 * 每类节点的执行数/失败率/平均与 P95 耗时/token 总量 + 最近 30 次运行趋势。
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
    upstream = await fetch(buildUpstreamUrl(`/${id}/analytics`, ''), {
      headers: forwardHeaders(_req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('flow analytics', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
