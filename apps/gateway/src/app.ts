import { Hono } from 'hono'
import { context, trace } from '@opentelemetry/api'
import { createLogger, getTracer } from '@dagents/shared'
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
import { requireLogin, stampSsoUser, type SsoContextVars } from './auth.js'

// `app` is exported separately from the `serve()` entry so tests can drive it
// via `app.request()` without binding a port. `index.ts` is the only place
// that actually listens. The SSO context vars (`ssoUser`) are typed so routes
// can `c.get('ssoUser')` without a cast.
export const app = new Hono<{ Variables: SsoContextVars }>()

const log = createLogger({ svc: 'gateway' })

// Scheduler listens on 8082 (see apps/scheduler/src/index.ts). Override with
// SCHEDULER_URL. The scheduler exposes run trace data through the gateway →
// scheduler proxy below, so the scheduler stays behind the gateway's single
// port / auth surface.
const schedulerUrl = (): string => process.env.SCHEDULER_URL ?? 'http://localhost:8082'

// Hop-by-hop / client-specific headers. Per RFC 7230 §6.1 these must not be
// forwarded by a proxy; `host` and `content-length` are dropped too because
// undici sets its own based on the upstream URL and the body we send.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
])

// Parse the comma-separated list in a `Connection` header (RFC 7230 §6.1:
// "A sender MUST remove [Connection-listed] header fields before forwarding").
// Returns lowercased field names; unknown/empty → [].
const connectionListedFields = (connectionHeader: string | null | undefined): string[] => {
  if (!connectionHeader) return []
  return connectionHeader
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== 'close' && s !== 'keep-alive')
}

// Response headers we pass through to the client. Allowlist (not blocklist):
// internal `x-*` debug headers, `set-cookie`, server banners, etc. are dropped.
const ALLOW_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
])

app.get('/health', (c) => c.json({ ok: true, svc: 'gateway' }))

// Auth routes (M5b.4 / P1.4.T2) mount before the session gate so login/session/
// logout are reachable without a session — otherwise nobody could ever log in.
app.route('/api/v1/auth', authRoutes)

/**
 * Internal callback endpoints (Phase 1 / trial-readiness): scheduler/dispatch
 * dial these after an async run completes to write the assistant message +
 * broadcast chat:done. Mounted before the SSO session gate because internal
 * services authenticate via `x-internal-token` (matching INTERNAL_CALLBACK_TOKEN
 * env), not a browser session.
 *
 * ⚠️ Security: internal routes BYPASS SSO and rely SOLELY on `x-internal-token`
 * for auth. The gateway binds 0.0.0.0 by default (see index.ts), so this surface
 * IS reachable from the network — operators MUST restrict `/internal/*` at the
 * network layer (firewall / service mesh / reverse-proxy allowlist) in
 * production, and `INTERNAL_CALLBACK_TOKEN` must be a strong random secret.
 */
app.route('/internal', internalRunsRoutes)

/**
 * SSO session middleware (M5b.4 / P1.4.T2).
 *
 * Resolves the session token off the cookie/bearer (`currentUser`), stamps the
 * `ssoUser` on the context when valid (so audit + future RBAC see the actor),
 * and — when `REQUIRE_LOGIN=1` — 401s any non-public route without a valid
 * session. Public routes: `/health`, `/api/v1/auth/*`, and the LLM
 * passthrough (the caller's own `sk-` token is its auth, not the session).
 *
 * When SSO isn't configured (`SSO_SESSION_SECRET` unset) the middleware is a
 * no-op — the pre-M5b.4 open dev posture — so `pnpm test` + local dev without
 * SSO keep working. `REQUIRE_LOGIN` is only honored when SSO is configured, so
 * a stray `REQUIRE_LOGIN=1` without a secret can't lock everything out.
 */
app.use('*', async (c, next) => {
  const user = currentUser(c)
  if (user) stampSsoUser(c, user)
  if (!requireLogin()) {
    await next()
    return
  }
  // REQUIRE_LOGIN is on. Exempt the public surface so login is reachable.
  const path = new URL(c.req.url).pathname
  const isPublic =
    path === '/health' ||
    path.startsWith('/api/v1/auth/') ||
    path.startsWith('/api/v1/llm/') ||
    path.startsWith('/api/v1/dispatch/')  // daemon protocol — machine-to-machine, network-isolated (gateway binds 127.0.0.1)
  if (isPublic || user) {
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

/**
 * Gateway → scheduler proxy (M6.4 / P1.11.T5): a read-only passthrough for a
 * run's node-level trace.
 *
 * The scheduler owns `run_node_spans` and exposes
 * `GET /api/v1/scheduler/runs/:runId/node-spans`. The console's workflows
 * detail page reads that trace through here so the scheduler stays behind the
 * gateway's single port / auth surface (same posture as the dispatch proxy
 * above) instead of being dialed directly on 8082.
 *
 * Blind passthrough — no path rewrite: the scheduler mounts its routes under
 * `/api/v1/scheduler/*`, so `/api/v1/scheduler/<rest>` is forwarded verbatim to
 * `${SCHEDULER_URL}/api/v1/scheduler/<rest>`. A caller-supplied `x-run-id` is
 * forwarded like any other non-hop-by-hop header (M6.1 trace correlation).
 *
 * Scope is deliberately narrow: only the node-spans read path is contracted for
 * M6.4. The fan-out / rerun / reproduce write routes stay internal to the
 * scheduler (a producer LPUSHes the Redis queue or calls the scheduler directly),
 * so this proxy is GET-only on `/api/v1/scheduler/runs/:runId/node-spans` — a
 * POST/PUT/DELETE here is a 405, and any other scheduler path 404s (bounded
 * surface, no open proxy to scheduler writes).
 */
app.all('/api/v1/scheduler/runs/:runId/node-spans', async (c) => {
  const inbound = new URL(c.req.url)
  const upstreamPath = inbound.pathname

  // GET-only read path — a non-GET hits the handler and is rejected with 405
  // (a 404 would imply the path doesn't exist, misleading for a caller that
  // POSTs to a read-only resource).
  if (c.req.method !== 'GET') {
    return c.json({ success: false, error: 'method not allowed' }, 405)
  }

  // Hop-by-hop headers (static set) PLUS any field the client named in its
  // `Connection` header (RFC 7230 §6.1 requires stripping those too).
  const dropReq = new Set(DROP_REQUEST_HEADERS)
  for (const f of connectionListedFields(c.req.raw.headers.get('connection'))) {
    dropReq.add(f)
  }
  const fwdHeaders = new Headers()
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (dropReq.has(k.toLowerCase())) continue
    fwdHeaders.set(k, v)
  }

  const upstreamUrl = new URL(upstreamPath, schedulerUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', headers: fwdHeaders })
  } catch (err) {
    log.error('scheduler proxy failed', { path: upstreamPath, error: String(err) })
    return c.json({ success: false, error: 'upstream unavailable' }, 502)
  }

  // Upstream *application* non-2xx: collapse to a sanitized 502 for 5xx (a 4xx
  // from the scheduler — 400 invalid runId / 404 run not found — is forwarded
  // verbatim so the console can distinguish "bad id" / "no such run" from
  // "scheduler down", mirroring how the agents proxy forwards dispatch 404s).
  if (upstream.status >= 500) {
    log.warn('scheduler upstream error', { path: upstreamPath, status: upstream.status })
    return c.json(
      { success: false, error: 'upstream error', upstreamStatus: upstream.status },
      502,
    )
  }

  // Success / 4xx: allowlist response headers (no upstream x-* / set-cookie
  // leak), then pass the body through.
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  log.info('proxy scheduler', { path: upstreamPath, status: upstream.status })
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
})
