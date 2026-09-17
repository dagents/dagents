import { Hono } from 'hono'
import { daemonsRoutes } from './daemons.js'
import { tasksRoutes } from './tasks.js'
import { invokeRoutes } from './invoke.js'
import { runsUsageRoutes } from './runs-usage-route.js'
import { fleetStatsRoutes } from './fleet-stats-route.js'

// Single-source envelope helpers (routes/dispatch family re-exports for its
// subroutes — import from './index.js' as before).
export { ok, fail } from '../../lib/http.js'

/**
 * Dispatch protocol routes (spec §1.5), merged into gateway (Plan A, 2026-08-01).
 *
 * Originally a separate `apps/dispatch/` Hono app on :8081; now mounted under
 * `/api/v1/dispatch` on the gateway. The remaining routes + 2 service modules
 * (runs-usage.ts, fleet-stats.ts) are co-located here. daemon clients dial the
 * gateway port (:8080) instead of a separate dispatch port.
 *
 * Auth posture: daemon protocol paths are machine-to-machine and rely on
 * network isolation (gateway binds 127.0.0.1) plus per-route daemon tokens
 * rather than session auth (there is no login — 本机模式).
 *
 * Route files use the shared `ok` / `fail` envelope helpers re-exported above
 * (canonical definitions live in src/lib/http.ts).
 */

export const dispatchRoutes = new Hono()

dispatchRoutes.route('/', daemonsRoutes)
dispatchRoutes.route('/', tasksRoutes)
dispatchRoutes.route('/', invokeRoutes)
dispatchRoutes.route('/', runsUsageRoutes)
dispatchRoutes.route('/', fleetStatsRoutes)
