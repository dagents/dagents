/**
 * Console → gateway run-message proxy（可操作终端 2026-09-08）。
 *
 * POST /api/workflows/runs/:runId/message → gateway
 * POST /api/v1/workflows/runs/:runId/message —— 把用户插话路由到目标节点的
 * 活 CLI 会话。同步回执（sent/unsupported/not_running）与 4xx 原样转发：
 * 409（run 已无活执行）由调用方映射为 stdin 行的结束态。
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/workflows/runs/${encodeURIComponent(runId)}/message`
  const headers: Record<string, string> = {
    ...forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id'))),
    'content-type': 'application/json',
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: await req.text(),
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  const body = await upstream.text().catch(() => '')
  if (upstream.status >= 500) {
    return NextResponse.json(
      { success: false, error: 'upstream error', upstreamStatus: upstream.status },
      { status: 502 },
    )
  }
  // 200（三态回执）/ 400 / 409 原样转发 —— 回执语义属于调用方
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
