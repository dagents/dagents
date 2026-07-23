/**
 * `GET /api/flows/runs/:runId/node-spans` — a run's node-level trace (M6.4).
 *
 * Server-side proxy: the browser hits this route, which fetches the gateway →
 * scheduler passthrough
 * (`/api/v1/scheduler/runs/:runId/node-spans` → scheduler's `run_node_spans`).
 * The scheduler's row shape + the gateway URL stay server-side; the browser
 * sees only the console's `RunNodeSpan[]` envelope.
 *
 * 200 + `{ spans: [] }` when the run has no node trace yet (a non-agentflow run,
 * or a run whose prediction hasn't been recorded by Flowise) — the inspector
 * then falls back to the Flowise-derived status. 404 when the scheduler reports
 * the run id matches no `runs` row (forwarded verbatim from the scheduler).
 */

import { NextResponse } from 'next/server'
import { gatewayUrl, MAX_RUN_ID_LEN } from '@/lib/config'
import type { NodeSpansEnvelope } from '@/lib/node-spans'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  if (!runId) {
    return NextResponse.json({ success: false, error: 'missing runId' }, { status: 400 })
  }

  const upstreamUrl = `${gatewayUrl()}/api/v1/scheduler/runs/${encodeURIComponent(runId)}/node-spans`

  const headers: Record<string, string> = { accept: 'application/json' }
  const forwardedRunId = req.headers.get('x-run-id')?.trim()
  if (forwardedRunId && forwardedRunId.length <= MAX_RUN_ID_LEN) {
    headers['x-run-id'] = forwardedRunId
  }
  const auth = req.headers.get('authorization')
  if (auth) headers.authorization = auth

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
    // 404 (run not found) is forwarded verbatim so the caller can distinguish
    // "no such run" from "scheduler down"; a 5xx is the gateway's sanitized 502.
    // The detail is capped but NOT echoed verbatim on 5xx — the gateway already
    // sanitized the scheduler body, but a console that re-forwards the raw
    // `detail` would re-leak whatever the gateway let through, so on 5xx we
    // send only the status, not the body.
    if (upstream.status >= 500) {
      return NextResponse.json(
        { success: false, error: 'node spans failed', status: upstream.status },
        { status: 502 },
      )
    }
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      {
        success: false,
        error: 'node spans failed',
        status: upstream.status,
        detail: detail.slice(0, 500),
      },
      { status: upstream.status },
    )
  }

  const body = (await upstream.json()) as NodeSpansEnvelope
  return NextResponse.json(body)
}
