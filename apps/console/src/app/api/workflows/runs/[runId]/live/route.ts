import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/workflows/runs/:runId/live — 运行实时终端 SSE 代理。
 *
 * 网关 run-live 帧流（hello 回放 + frame 实时 + runEnd 关流）的流式透传，
 * 姿态与 chats/:id/stream 一致：不缓冲、直通 body，帧级实时到达。
 * 上游 404（无进程内条目 —— run 未知 / 网关重启过 / 保留期已过）原样
 * 透传，客户端据此回退 node-spans 轮询渲染。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/workflows/runs/${encodeURIComponent(runId)}/live`
  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
  headers['accept'] = 'text/event-stream'

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch {
    return NextResponse.json({ success: false, error: 'gateway unavailable' }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'run live stream unavailable', status: upstream.status, detail: detail.slice(0, 300) },
      { status: upstream.status },
    )
  }

  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  respHeaders.set('cache-control', 'no-cache')
  respHeaders.set('x-accel-buffering', 'no')
  return new NextResponse(upstream.body, { status: 200, headers: respHeaders })
}
