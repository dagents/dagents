import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/directories${req.nextUrl.search}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable' },
      { status: 502 },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/directories${req.nextUrl.search}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')), true)

  const body = await req.text()

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'POST', cache: 'no-store', headers, body })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable' },
      { status: 502 },
    )
  }

  const responseBody = await upstream.text()
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
