/**
 * Console → gateway health probe (P1.10.T8).
 *
 * The settings "API Key" tab shows the new-api gateway connection card
 * (design/settings.html `.gateway`): connected / base URL / token count.
 * The gateway exposes `/health` (plain JSON `{ ok, svc }`) which we proxy
 * so the browser can tell "gateway up" from "gateway down" without the
 * gateway URL leaking client-side. We attach a short server-side timeout
 * so a dead gateway shows "unreachable" fast instead of hanging the UI.
 *
 * M5b.4: `/health` is a public unauthenticated endpoint (no session cookie
 * needed) and carries no run-scoped work, so it intentionally does NOT attach
 * an `x-run-id` or forward the session cookie — keeping the probe a pure
 * liveness check that 200s the same way regardless of auth state.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'

export const runtime = 'nodejs'

/** Probe timeout — a gateway that can't answer /health in 3s is effectively down. */
const PROBE_TIMEOUT_MS = 3_000

/**
 * GET /api/gateway-health — { ok: boolean, reachable: boolean }.
 *
 * Returns 200 with `reachable: true` when the gateway answered, 200 with
 * `reachable: false` on a network/timeout failure (so the UI can render a
 * degraded card rather than surfacing a fetch error), and surfaces the
 * gateway's own `svc` label when present for the connection card subtitle.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const upstream = await fetch(`${gatewayUrl()}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!upstream.ok) {
      return NextResponse.json({ ok: false, reachable: false, status: upstream.status })
    }
    const body = (await upstream.json().catch(() => ({}))) as { ok?: boolean; svc?: string }
    return NextResponse.json({ ok: body.ok === true, reachable: true, svc: body.svc })
  } catch {
    // AbortError (timeout) or network failure — either way, not reachable.
    return NextResponse.json({ ok: false, reachable: false })
  } finally {
    clearTimeout(timer)
  }
}
