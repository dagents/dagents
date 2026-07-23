/**
 * Console → gateway prediction proxy (P1.10.T2).
 *
 * The browser chat view POSTs here; this route forwards to the gateway's
 * `/api/v1/flows/<id>/prediction` rewriting proxy (which in turn dials
 * Flowise). Keeping the gateway URL server-side avoids CORS and keeps the
 * Flowise origin out of the client bundle.
 *
 * Flowise streaming uses SSE. The gateway already passes the upstream body
 * through verbatim (`text/event-stream` is in its response allowlist), so this
 * route does the same: it does NOT await the full body — it pipes the upstream
 * ReadableStream straight back as a streaming Response. This is what makes
 * token-by-token rendering work.
 *
 * Request body (from the browser):
 *   { flowId: string, question: string, sessionId?: string, streaming?: boolean }
 *
 * The gateway expects Flowise's prediction body shape, which for a chatflow is
 * `{ question, streaming, overrideConfig: { sessionId } }` (see
 * apps/scheduler/src/prediction-client.ts and the proxy test fixtures). We
 * rebuild that body here so the browser only sends the high-level fields.
 *
 * `x-run-id` is threaded end-to-end: the browser sends one, this route
 * forwards it, the gateway echoes it, and it lands in Flowise/OTel traces.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'

export const runtime = 'nodejs'

const chatBodySchema = z.object({
  flowId: z.string().min(1).max(200),
  question: z.string().min(1).max(32_000),
  sessionId: z.string().max(200).optional(),
  streaming: z.boolean().optional(),
})

/** Build the Flowise prediction body from the console's higher-level fields. */
function buildUpstreamBody(input: z.infer<typeof chatBodySchema>): string {
  return JSON.stringify({
    question: input.question,
    streaming: input.streaming ?? true,
    overrideConfig: {
      // sessionId carries the conversation into Flowise's Flow State
      // (architecture v0.2 §6.5) so a resumed session lands on the right
      // memory. Falls back to a fresh session when omitted.
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let parsed: z.infer<typeof chatBodySchema>
  try {
    parsed = chatBodySchema.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'invalid chat body', detail: String(err) },
      { status: 400 },
    )
  }

  // M5b.4: forward the caller's run id if present + well-formed, otherwise
  // generate one (the gateway generates one too, but generating here means the
  // id the browser already shows in the inspector is the one that flows
  // through even when the browser omitted it). The chat path is special-cased
  // (not via `forwardSessionHeaders`) because it sets content-type from a
  // JSON body the gateway expects + echoes the run id on the response.
  const runId = resolveRunId(req.headers.get('x-run-id'))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-run-id': runId,
  }
  // Thread the SSO session cookie + caller auth to the gateway.
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth

  const upstreamUrl = `${gatewayUrl()}/api/v1/flows/${encodeURIComponent(parsed.flowId)}/prediction`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: buildUpstreamBody(parsed),
      // We want the raw streaming body, so do not let fetch buffer/parse it.
      cache: 'no-store',
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  // The gateway collapses every Flowise non-2xx to a sanitized 502 JSON
  // envelope (see apps/gateway/src/app.ts — upstream 4xx and 5xx alike become
  // 502), so in practice the only failure status we see here is 502. Pass it
  // (and a short, truncated body) through so the chat view can surface the
  // reason inline. The non-502 branch is kept defensive for a future gateway
  // that distinguishes caller errors from upstream errors.
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'prediction failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  // Stream the SSE body straight through. Preserve the content-type so the
  // browser's fetch().body reader (and any EventSource-ish consumer) sees
  // `text/event-stream`. Forward x-run-id so the client can correlate.
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  if (headers['x-run-id']) respHeaders.set('x-run-id', headers['x-run-id'])

  return new NextResponse(upstream.body, { status: 200, headers: respHeaders })
}
