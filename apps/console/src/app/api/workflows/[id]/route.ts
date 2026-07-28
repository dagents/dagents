/**
 * Console → gateway workflow item proxy.
 *
 * Handles GET / PUT / DELETE for a single workflow by id.
 * Forwards to the gateway's `/api/v1/workflows/:id` API.
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

function validateId(id: string): Response | null {
  if (!WORKFLOW_ID_RE.test(id)) {
    return fail(400, 'invalid workflow id')
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const idErr = validateId(id)
  if (idErr) return idErr

  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'GET',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('get', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const idErr = validateId(id)
  if (idErr) return idErr

  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'PUT',
      headers: forwardHeaders(req, true),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('update', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const idErr = validateId(id)
  if (idErr) return idErr

  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'DELETE',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('delete', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
