import { Hono } from 'hono'
import { llmRoutes } from './routes/llm.js'
import { auditRoutes } from './routes/audit.js'
import { directoryRoutes } from './routes/directories.js'
import { chatRoutes } from './routes/chats.js'
import { agentsRoutes } from './routes/agents.js'
import { llmProviderRoutes } from './routes/llm-providers.js'
import { workflowsRoutes } from './routes/workflows.js'
import { authRoutes, currentUser } from './routes/auth.js'
import { internalRunsRoutes } from './routes/internal-runs.js'
import { dispatchRoutes } from './routes/dispatch/index.js'
import { createLogger } from '@dagents/shared'
import { requireAuth, stampSsoUser, verifyApiKey, bearerFromRequest, type SsoContextVars } from './auth.js'

// `app` is exported separately from the `serve()` entry so tests can drive it
// via `app.request()` without binding a port. `index.ts` is the only place
// that actually listens. The SSO context vars (`ssoUser`) are typed so routes
// can `c.get('ssoUser')` without a cast.
export const app = new Hono<{ Variables: SsoContextVars }>()

app.get('/health', (c) => c.json({ ok: true, svc: 'gateway' }))

// Auth routes (M5b.4 / P1.4.T2) mount before the session gate so login/session/
// logout are reachable without a session — otherwise nobody could ever log in.
app.route('/api/v1/auth', authRoutes)

/**
 * Internal callback endpoints (Phase 1 / trial-readiness): daemons dial these
 * after an async task completes to write the assistant message + broadcast
 * chat:done. Mounted before the SSO session gate because internal services
 * authenticate via `x-internal-token` (matching INTERNAL_CALLBACK_TOKEN env),
 * not a browser session.
 *
 * ⚠️ Security: internal routes BYPASS SSO and rely SOLELY on `x-internal-token`
 * for auth. The gateway binds 0.0.0.0 by default (see index.ts), so this surface
 * IS reachable from the network — operators MUST restrict `/internal/*` at the
 * network layer (firewall / service mesh / reverse-proxy allowlist) in
 * production, and `INTERNAL_CALLBACK_TOKEN` must be a strong random secret.
 */
app.route('/internal', internalRunsRoutes)

/**
 * Gateway auth middleware (M5b.4 / P1.4.T2 + security hardening).
 *
 * Resolves the SSO session first (stamps `ssoUser` on the context for audit +
 * future RBAC). Then, when *any* auth is configured (`requireAuth()` true),
 * gates every non-public route. Auth is satisfied by EITHER a valid SSO
 * session OR a valid `GATEWAY_API_KEY` bearer token.
 *
 * Public routes (always reachable):
 *   - `/health`
 *   - `/api/v1/auth/*`  (login/session/logout)
 *   - `/api/v1/llm/*`   (LLM proxy; the upstream provider's own `sk-` token is the auth)
 *
 * Dispatch routes (`/api/v1/dispatch/*`) are passed through to per-route auth:
 *   - `register` requires `DAEMON_REGISTER_TOKEN` (when set)
 *   - `claim`/`heartbeat` require the daemon's own token (checked per-route)
 *
 * When no auth is configured (`requireAuth()` false) the middleware is a
 * no-op — the pre-M5b.4 open dev posture — so `pnpm test` + local dev without
 * any auth env keep working.
 */
app.use('*', async (c, next) => {
  // Resolve SSO session first (stamps user for audit).
  const user = currentUser(c)
  if (user) stampSsoUser(c, user)

  if (!requireAuth()) {
    await next()
    return
  }

  // Auth is configured. Check public routes.
  const path = new URL(c.req.url).pathname
  const isPublic =
    path === '/health' ||
    path.startsWith('/api/v1/auth/') ||
    path.startsWith('/api/v1/llm/')        // LLM proxy uses the provider's own API key as auth
  if (isPublic) {
    await next()
    return
  }

  // Check SSO session first.
  if (user) {
    await next()
    return
  }

  // Check API key (for programmatic access).
  const bearer = bearerFromRequest(c)
  if (verifyApiKey(bearer)) {
    await next()
    return
  }

  // Dispatch routes: check daemon token (not gateway API key).
  if (path.startsWith('/api/v1/dispatch/')) {
    // Daemon protocol routes are auth'd by daemon tokens, checked per-route
    // (register needs DAEMON_REGISTER_TOKEN, claim/heartbeat need daemon token).
    await next()
    return
  }

  return c.json({ success: false, error: 'authentication required' }, 401)
})

// LLM provider proxy: dynamically forwards to the user-configured LLM provider
// based on X-LLM-Provider-Id header (or first active provider).
app.route('/api/v1/llm', llmRoutes)

// Audit log query endpoint (M6.6 / P1.4.T6): read side of the audit trail.
// ⚠️ admin-only once SSO (P1.4.T2) lands — the trail names actors + targets,
// not for end users.
app.route('/api/v1/audit', auditRoutes)

/**
 * Directory CRUD API: directories list + detail + create + update + delete
 * with chat_count subquery. Parameterised raw SQL via `runQuery`.
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`,
 * same posture as the other gateway-owned routes.
 */
app.route('/api/v1/directories', directoryRoutes)

/**
 * Chat CRUD API: chat list + detail + create + update + delete with messages.
 * Parameterised raw SQL via `runQuery`; message creation uses a transactional
 * CTE to atomically insert the message and update chat counters.
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`,
 * same posture as the other gateway-owned routes.
 */
app.route('/api/v1/chats', chatRoutes)

/**
 * Agent catalogue read API (v0.3-M9.1 / 后端契约 1): the design-aligned
 * `GET /api/v1/agents` + `GET /api/v1/agents/:id` the console's agents page +
 * agent-detail page render. Source of truth is `design/js/agents-data.js`; the
 * route maps the platform-owned `agents` table 1:1 onto that single-agent
 * object shape (id/name/kind/roles/instructions/skills/visibility/concurrency/
 * model/runtime/owner/activity[{total,ok,fail}]/status/availability/summary +
 * the design's run-context + derived fields). This is a *new* gateway-owned
 * read surface — distinct from the legacy dispatch `/api/v1/dispatch/agents/*`
 * proxy below, which returns the snake_case `agent_daemons` join. Gated by the
 * SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`, same posture as the
 * other gateway-owned reads; membership scoping is a follow-up (RBAC).
 */
app.route('/api/v1/agents', agentsRoutes)

/**
 * LLM Provider CRUD API: llm provider list + detail + create + update + delete + test.
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`,
 * same posture as the other gateway-owned routes.
 */
app.route('/api/v1/llm-providers', llmProviderRoutes)

/**
 * Workflows CRUD API: workflow list + detail + create + update + delete.
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`,
 * same posture as the other gateway-owned routes.
 */
app.route('/api/v1/workflows', workflowsRoutes)

/**
 * Dispatch protocol routes (spec §1.5), merged into gateway (Plan A, 2026-08-01).
 *
 * Originally a separate `apps/dispatch/` Hono app on :8081; now mounted inline.
 * Daemon clients dial gateway (:8080) instead of a separate dispatch port.
 * The 20 routes (daemons/tasks/agents/invoke/runs-usage/fleet-stats) + 2 service
 * modules live in `src/routes/dispatch/`.
 *
 * SSO posture: `/api/v1/dispatch/*` is on the public allowlist above — daemon
 * protocol paths are machine-to-machine and rely on network isolation (gateway
 * binds 127.0.0.1) rather than session auth. Production deployments should put
 * a reverse proxy with IP allowlist in front for the dispatch paths.
 */
app.route('/api/v1/dispatch', dispatchRoutes)

// Unified error envelope — always JSON, never plain text. Hono's default 404
// and 500 handlers emit text/plain, which leaks the framework + gives callers
// nothing parseable; these wrap every error in the standard `{ success, error }`
// shape the rest of the API uses.
app.notFound((c) => c.json({ success: false, error: 'not found' }, 404))
app.onError((err, c) => {
  const log = createLogger({ svc: 'gateway:error' })
  log.error('unhandled error', { error: err.message, stack: err.stack })
  return c.json({ success: false, error: 'internal server error' }, 500)
})
