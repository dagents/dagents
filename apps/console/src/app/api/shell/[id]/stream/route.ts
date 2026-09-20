/**
 * GET /api/shell/:id/stream — shell 会话 SSE 代理（流式透传，不缓冲）。
 *
 * 与 chats/[id]/stream 同姿势：PTY 输出以 base64 data 帧回放 + 实时推送，
 * 必须逐块透传才能保证终端逐字符渲染的「真终端感」。
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/shell/${encodeURIComponent(id)}/stream`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
  headers['accept'] = 'text/event-stream'

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable' },
      { status: 502 },
    )
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'shell stream failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  respHeaders.set('cache-control', 'no-cache')

  return new NextResponse(upstream.body, { status: 200, headers: respHeaders })
}
