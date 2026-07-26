/**
 * Console → gateway LLM provider connection test proxy.
 *
 * POST /api/llm-providers/:id/test — tests connectivity to the provider
 * by fetching /models from its base URL with the stored API key.
 */

import { type NextRequest } from 'next/server'
import {
  buildUpstreamUrl,
  fail,
  forwardHeaders,
  logProxyError,
  pipeUpstream,
  PROVIDER_ID_RE,
} from '@/lib/llm-provider-proxy'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  if (!PROVIDER_ID_RE.test(id)) {
    return fail(400, 'invalid provider id')
  }

  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}/test`, ''), {
      method: 'POST',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('test', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
