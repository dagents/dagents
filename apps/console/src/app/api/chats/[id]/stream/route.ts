import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/chats/:id/stream — SSE proxy to gateway.
 *
 * The browser's chat-stream client subscribes here after POSTing a user message
 * to receive the assistant's reply as a token stream. We pipe the upstream
 * `text/event-stream` body straight back without buffering so token-by-token
 * rendering works (same posture as the legacy /api/chat route).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/chats/${encodeURIComponent(id)}/stream`

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
      { success: false, error: 'stream failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  // Pipe the SSE body straight through.
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  const runId = upstream.headers.get('x-run-id')
  if (runId) respHeaders.set('x-run-id', runId)
  respHeaders.set('cache-control', 'no-cache')

  return new NextResponse(upstream.body, { status: 200, headers: respHeaders })
}
