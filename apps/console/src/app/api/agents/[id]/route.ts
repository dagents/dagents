/**
 * Console → gateway agent-detail proxy (M5a.2 / P1.10.T4).
 *
 * Forwards `GET /api/agents/:id` to
 * `${gatewayUrl()}/api/v1/agents/:id` (gateway unified agents detail route).
 * The gateway 404s for an unknown agent id; that 404 is forwarded verbatim
 * so the drawer can show "agent not found" rather than a generic 502.
 *
 * `x-run-id` is always forwarded (generated if absent), via the shared
 * `forwardSessionHeaders`.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/agents/${encodeURIComponent(id)}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'agent detail failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

/**
 * DELETE /api/agents/:id — proxy agent deletion to the gateway.
 * Forwards to `${gatewayUrl()}/api/v1/agents/:id` (DELETE).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/agents/${encodeURIComponent(id)}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'DELETE', headers })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

/**
 * PATCH /api/agents/:id — proxy agent updates (e.g. archive) to the gateway.
 * Forwards to `${gatewayUrl()}/api/v1/agents/:id` (PATCH).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/agents/${encodeURIComponent(id)}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
  // Forward the request body for PATCH
  const bodyText = await req.text()

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': req.headers.get('content-type') ?? 'application/json' },
      body: bodyText,
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  const respBody = await upstream.text()
  return new NextResponse(respBody, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
