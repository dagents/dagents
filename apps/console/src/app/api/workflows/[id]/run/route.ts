/**
 * Console → gateway workflow run proxy.
 *
 * Forwards POST /api/workflows/:id/run to the gateway's
 * `/api/v1/workflows/:id/run` endpoint, which executes the workflow
 * using the @dagents/workflow DAG executor.
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

export async function POST(
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
    upstream = await fetch(buildUpstreamUrl(`/${id}/run`, req.nextUrl.search), {
      method: 'POST',
      headers: forwardHeaders(req, true),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('run', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
