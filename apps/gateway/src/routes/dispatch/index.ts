import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { daemonsRoutes } from './daemons.js'
import { tasksRoutes } from './tasks.js'
import { agentsRoutes } from './agents.js'
import { invokeRoutes } from './invoke.js'
import { runsUsageRoutes } from './runs-usage-route.js'
import { fleetStatsRoutes } from './fleet-stats-route.js'

/**
 * Dispatch protocol routes (spec §1.5), merged into gateway (Plan A, 2026-08-01).
 *
 * Originally a separate `apps/dispatch/` Hono app on :8081; now mounted under
 * `/api/v1/dispatch` on the gateway. The 20 routes + 2 service modules
 * (runs-usage.ts, fleet-stats.ts) are co-located here. daemon clients dial the
 * gateway port (:8080) instead of a separate dispatch port.
 *
 * SSO posture: `/api/v1/dispatch/*` is on the gateway's SSO public allowlist
 * (see app.ts) — daemon protocol paths are machine-to-machine and rely on
 * network isolation (gateway binds 127.0.0.1) rather than session auth.
 *
 * Route files use the shared `ok` / `fail` envelope helpers exported below
 * (moved verbatim from the old dispatch `app.ts`).
 */

/** Standard envelope (CLAUDE.md API convention): { success, data?, error? }. */
export const ok = <T>(c: Context, data: T): Response => c.json({ success: true, data })
export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
): Response => c.json({ success: false, error, ...extra }, status)

export const dispatchRoutes = new Hono()

dispatchRoutes.route('/', daemonsRoutes)
dispatchRoutes.route('/', tasksRoutes)
dispatchRoutes.route('/', agentsRoutes)
dispatchRoutes.route('/', invokeRoutes)
dispatchRoutes.route('/', runsUsageRoutes)
dispatchRoutes.route('/', fleetStatsRoutes)
