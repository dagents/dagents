import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppDataSource } from '@mil/db'
import { createLogger } from '@mil/shared'
import { invokeRoutes } from './routes/invoke.js'
import { daemonsRoutes } from './routes/daemons.js'
import { tasksRoutes } from './routes/tasks.js'
import { agentsRoutes } from './routes/agents.js'
import { runsUsageRoutes } from './routes/runs-usage.js'
import { fleetStatsRoutes } from './routes/fleet-stats.js'

/**
 * Central dispatch server — pull-based multi-agent protocol (spec §1.5).
 *
 * `app` is exported separately from the `serve()` entry so tests drive it via
 * `app.request()` without binding a port, mirroring the gateway's split.
 *
 * Routes mount under `/api/v1/dispatch/*` (spec contract). DB is initialized
 * once at bootstrap; every route reuses the shared `AppDataSource` and queries
 * with parameterised raw SQL (no entity-class runtime dependency).
 */
export const app = new Hono()

const log = createLogger({ svc: 'dispatch' })

app.get('/health', (c) => c.json({ ok: true, svc: 'dispatch', db: AppDataSource.isInitialized }))

/** Standard envelope (CLAUDE.md API convention): { success, data?, error? }. */
export const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

app.route('/api/v1/dispatch', invokeRoutes)
app.route('/api/v1/dispatch', daemonsRoutes)
app.route('/api/v1/dispatch', tasksRoutes)
app.route('/api/v1/dispatch', agentsRoutes)
// M6.2 — daemon usage landed into runs.agent_daemon_calls; read routes for the
// resource panel / agents drawer. Mounted alongside the dispatch protocol.
app.route('/api/v1/dispatch', runsUsageRoutes)
// M6.5 — fleet resource-dashboard aggregation (status / throughput / region /
// cost), the data backing the resource panel (M5b.3). Mounted alongside the
// dispatch protocol + usage read routes.
app.route('/api/v1/dispatch', fleetStatsRoutes)

export async function bootstrap(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  log.info('dispatch db initialized', { initialized: AppDataSource.isInitialized })
}
