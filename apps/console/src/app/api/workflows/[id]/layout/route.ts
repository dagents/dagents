/**
 * Console → gateway workflow layout proxy（2026-09-06 画布布局自动保存）。
 *
 * PUT /api/workflows/:id/layout —— 画布拖拽停/视口停后 debounce 静默提交
 * positions+viewport，gateway 服务端 merge 进 flow_data（只动坐标与视口，
 * 不触碰节点配置 —— 配置编辑仍走显式保存管线）。
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

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  if (!WORKFLOW_ID_RE.test(id)) {
    return fail(400, 'invalid workflow id')
  }

  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}/layout`, ''), {
      method: 'PUT',
      headers: forwardHeaders(req, true),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('layout update', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
