import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

/**
 * Proxy to gateway's native OS directory picker. The browser cannot read
 * absolute paths via showDirectoryPicker() (web security boundary), but the
 * gateway runs locally on the user's machine and can spawn osascript /
 * zenity / PowerShell to get the real path. See
 * apps/gateway/src/routes/directories.ts GET /pick.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // picker may wait for user interaction

export async function GET(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/directories/pick`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      cache: 'no-store',
      headers,
    })
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: 'gateway unavailable',
        detail: String(err),
      },
      { status: 502 },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
    },
  })
}
