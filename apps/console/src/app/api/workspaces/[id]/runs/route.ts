/**
 * `POST /api/workspaces/[id]/runs` — start a new Workspace conversation turn
 * (M5b.1 / P1.10.T6).
 *
 * The browser Workspace composer POSTs here; this route forwards to the
 * scheduler's `POST /api/v1/scheduler/runs/fanout` endpoint as a single-input
 * batch. The scheduler is the one path that writes a `runs` row carrying
 * `workspace_id` (the thread's scoping key): `fanOut`'s `createRun` stamps the
 * parent + the one child with the workspace id, so the next thread fetch
 * reconciles the optimistic message with the real run row — the agent answer
 * lands as the parent's aggregate `output` once the child settles. This is what
 * closes the "对话→线程" gap: the chat proxy path never wrote a run, so the
 * thread never received the turn; routing through fan-out makes the turn
 * end-to-end traceable via the OTel `run_id` (M6.1) and persistent in `runs`.
 *
 * The scheduler URL stays server-side (no CORS, no origin leak) — same posture
 * as the gateway proxies. `x-run-id` is forwarded so the console→scheduler hop
 * stays in the caller's trace; the body is built by the shared pure
 * `buildWorkspaceRunBody` so the route and the client share one builder with no
 * drift. Failures are sanitized: a scheduler dial error never carries the
 * internal host/port/path to the browser (logged server-side only); the
 * scheduler's own 502/400 envelopes are piped verbatim so the view can surface
 * the reason.
 *
 * Request body (from the browser) is the `buildWorkspaceRunBody` result; it is
 * forwarded verbatim (the scheduler's `fanOutBodySchema` validates it). The
 * `:id` path segment is injected as `workspaceId` so a browser can't spoof a
 * different workspace — the run is scoped to the project in the URL, full stop.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@mil/shared'
import { schedulerUrl, MAX_RUN_ID_LEN } from '@/lib/config'

const proxyLog = createLogger({ svc: 'console:workspaces-runs-proxy' })

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  // The browser sends the fan-out body minus workspaceId (it doesn't know the
  // id; the URL does). Parse defensively so a malformed body is a 400, not a
  // silent forward of garbage to the scheduler.
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'invalid run body', detail: String(err) },
      { status: 400 },
    )
  }

  // Inject the workspace id from the URL. A browser can't set this itself, so
  // the run is always scoped to the project in the path — no cross-workspace
  // spoofing. Overwriting any caller-supplied `workspaceId` is intentional.
  body = { ...body, workspaceId: id }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const runId = req.headers.get('x-run-id')?.trim()
  if (runId && runId.length <= MAX_RUN_ID_LEN) headers['x-run-id'] = runId
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  // M5b.4: thread the SSO session cookie so the gateway's session middleware
  // sees the caller. The scheduler endpoint is proxied through the gateway
  // (which gates non-public routes under REQUIRE_LOGIN=1), so without the
  // cookie the Workspace composer 401s for logged-in users.
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie

  let upstream: Response
  try {
    upstream = await fetch(`${schedulerUrl()}/api/v1/scheduler/runs/fanout`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (err) {
    // Scheduler unreachable. Sanitize: log the error class server-side, return
    // a generic 502 so the internal host/port never reaches the browser.
    proxyLog.error('scheduler dial failed', {
      stage: 'runs',
      error: err instanceof Error ? err.name : typeof err,
    })
    return NextResponse.json({ success: false, error: 'scheduler unavailable' }, { status: 502 })
  }

  // Pipe the scheduler's response verbatim (status + content-type). The
  // scheduler's envelope is `{ success, data: { parentRunId, ... } }` on 200 or
  // `{ success: false, error, detail? }` on 4xx/5xx; both are forwarded so the
  // client's `unwrap` can surface the reason.
  const respBody = await upstream.text()
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  return new NextResponse(respBody, { status: upstream.status, headers: respHeaders })
}
