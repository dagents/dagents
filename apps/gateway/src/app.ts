import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { context, trace } from '@opentelemetry/api'
import { createLogger, getTracer } from '@mil/shared'
import { tokensRoutes } from './routes/tokens.js'
import { llmRoutes } from './routes/llm.js'
import { auditRoutes } from './routes/audit.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { labRoutes } from './routes/lab.js'
import { agentsRoutes } from './routes/agents.js'
import { tasksRoutes } from './routes/tasks.js'
import { authRoutes, currentUser } from './routes/auth.js'
import { requireLogin, stampSsoUser, type SsoContextVars } from './auth.js'
import {
  fetchFlowiseJson,
  FlowiseFetchError,
  flowiseChatflowSchema,
} from './routes/workspace-flowise.js'
import {
  mapFlowiseToDesignShape,
  flowiseExecutionSchema,
  type DesignFlowShape,
} from './flowise-shape.js'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

// `app` is exported separately from the `serve()` entry so tests can drive it
// via `app.request()` without binding a port. `index.ts` is the only place
// that actually listens. The SSO context vars (`ssoUser`) are typed so routes
// can `c.get('ssoUser')` without a cast.
export const app = new Hono<{ Variables: SsoContextVars }>()

const log = createLogger({ svc: 'gateway' })

// Flowise listens on 3101 in this stack (3100 is taken by loki — see
// docs/m1-flowise-agent-verification.md). Override with FLOWISE_URL.
const flowiseUrl = (): string => process.env.FLOWISE_URL ?? 'http://localhost:3101'

// Dispatch listens on 8081 (see packages/daemon — daemons dial it directly at
// `http://localhost:8081`). Override with DISPATCH_URL. Same lazy-reader
// pattern as flowiseUrl() so tests can repoint it via process.env at runtime.
const dispatchUrl = (): string => process.env.DISPATCH_URL ?? 'http://localhost:8081'

// Scheduler listens on 8082 (see apps/scheduler/src/index.ts). Override with
// SCHEDULER_URL. The console's AgentFlows browse page reads a run's node-level
// trace (M6.4) through the gateway → scheduler proxy below, so the scheduler
// stays behind the gateway's single port / auth surface like dispatch.
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
// anything Flowise emits that isn't here is dropped, so internal `x-*` debug
// headers, `set-cookie`, server banners, etc. can't leak. `x-run-id` is set
// explicitly below.
const ALLOW_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
])

// Upper bound on a caller-supplied x-run-id — protects against absurd inputs
// being echoed into logs / forwarded upstream. 128 fits a UUID (36) + room.
const MAX_RUN_ID_LEN = 128

app.get('/health', (c) => c.json({ ok: true, svc: 'gateway' }))

// Auth routes (M5b.4 / P1.4.T2) mount before the session gate so login/session/
// logout are reachable without a session — otherwise nobody could ever log in.
app.route('/api/v1/auth', authRoutes)

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
  const isPublic = path === '/health' || path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/llm/')
  if (isPublic || user) {
    await next()
    return
  }
  return c.json({ success: false, error: 'authentication required' }, 401)
})

/**
 * Gateway → Flowise proxy.
 *
 * Our REST convention nests the chatflow id under `/flows`:
 *   /api/v1/flows/<chatflowId>/prediction
 * whereas Flowise serves prediction the other way around:
 *   /api/v1/prediction/<chatflowId>
 *
 * So this is a *rewriting* proxy, not a blind passthrough. An `x-run-id` is
 * threaded end-to-end: generated if the caller didn't send one, forwarded to
 * Flowise, and echoed on the response so callers can correlate logs/traces.
 *
 * Only `<id>/prediction` is contracted for M1.4; anything else under
 * `/api/v1/flows/` 404s — bounded surface, no open proxy.
 *
 * M9.2 adds the sibling `GET /api/v1/flows/:id` (design-fidelity DAG shape),
 * registered *before* this wildcard so Hono matches the more-specific param
 * route first; the `:id/prediction` suffix still falls through to the wildcard
 * below for the prediction rewrite.
 */
app.get('/api/v1/flows/:id', flowsDesignShapeHandler)

app.all('/api/v1/flows/*', async (c) => {
  const inbound = new URL(c.req.url)
  const rest = inbound.pathname.replace(/^\/api\/v1\/flows\//, '')

  // <chatflowId>/prediction  →  /api/v1/prediction/<chatflowId>
  // Tighten to a UUID-shaped segment so `/api/v1/flows/.../prediction` can't
  // forward a garbage id upstream. `..` / `%2e%2e` / `%2f` are rejected here
  // too (they contain `/` or `.`), so no path traversal reaches Flowise.
  const match = rest.match(/^([0-9a-fA-F-]{36})\/prediction\/?$/)
  if (!match) {
    return c.json(
      { success: false, error: `unsupported flow path: /api/v1/flows/${rest}` },
      404,
    )
  }
  const upstreamPath = `/api/v1/prediction/${match[1]}`

  // x-run-id: trim + length cap. An empty/whitespace value falls back to a
  // fresh UUID — empty run-ids would silently break trace correlation and
  // risk empty-key writes if an upstream keys on run-id.
  const rawRunId = c.req.header('x-run-id')?.trim()
  const runId = rawRunId && rawRunId.length <= MAX_RUN_ID_LEN ? rawRunId : randomUUID()
  const method = c.req.method
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)

  // M6.1: wrap the proxy hop in a run-entry span tagged with `run.id`. The
  // undici instrumentation auto-injects W3C `traceparent` into the outbound
  // `fetch` below from the active span, so Flowise (and downstream daemon→LLM)
  // join this trace without header plumbing here. `run.id` is read back by
  // `currentRunId()` so log lines and downstream spans share the run id.
  const tracer = getTracer('gateway')
  const span = tracer.startSpan('gateway.proxy', {
    attributes: { 'run.id': runId, 'http.request.method': method },
  })
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await proxyFlowRequest(c, runId, method, hasBody, upstreamPath)
    } finally {
      span.end()
    }
  })
})

/**
 * Inner Flowise proxy body (M6.1 factored out of the route so the run-entry
 * span in the route handler can wrap the whole hop). Header/body/forwarding
 * logic is unchanged from the pre-M6.1 inline handler.
 */
async function proxyFlowRequest(
  c: Context,
  runId: string,
  method: string,
  hasBody: boolean,
  upstreamPath: string,
): Promise<Response> {
  const inbound = new URL(c.req.url)

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
  fwdHeaders.set('x-run-id', runId)

  // Prediction bodies are tiny JSON; buffer so undici sets an accurate
  // content-length and we avoid `duplex: 'half'` streaming complexity.
  const body = hasBody ? await c.req.text() : undefined

  const upstreamUrl = new URL(upstreamPath, flowiseUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers: fwdHeaders, body })
  } catch (err) {
    log.error('flowise proxy failed', {
      path: upstreamPath,
      runId,
      method,
      error: String(err),
    })
    return c.json({ success: false, error: 'upstream unavailable' }, 502)
  }

  // Upstream *application* 5xx: don't forward the body/headers verbatim —
  // Flowise error bodies can carry stacks, DB strings, internal hostnames.
  // Collapse to a sanitized 502; the real detail stays in the server log.
  if (!upstream.ok) {
    log.warn('upstream error', {
      path: upstreamPath,
      runId,
      method,
      status: upstream.status,
    })
    c.header('x-run-id', runId)
    return c.json(
      { success: false, error: 'upstream error', upstreamStatus: upstream.status },
      502,
    )
  }

  // Success path: allowlist response headers (no upstream `x-*` / `set-cookie`
  // / server banner leak), then force x-run-id so the client always sees it.
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  respHeaders.set('x-run-id', runId)

  log.info('proxy flow', { path: upstreamPath, runId, method, status: upstream.status })

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

/**
 * `GET /api/v1/flows/:id` — design-fidelity DAG shape (v0.3-M9.2).
 *
 * Returns the design `flows-data` shape (`{ id, name, nodes:[{id,type,…}],
 * edges:[{from,to,label?}], runs }`) instead of Flowise's raw `flowData` JSON.
 * Fetches the chatflow row (carrying `flowData` — the React Flow nodes/edges)
 * plus its recent executions through the same read-only `fetchFlowiseJson`
 * the workspace route uses, then runs `mapFlowiseToDesignShape` to translate
 * the 14 agentflow node `data.name` values into the design `type` vocabulary
 * (`Start`/`Agent`/`LLM`/`Tool`/`HTTP`/`Condition`/`Condition Agent`/
 * `Iteration`/`Loop`/`Human Input`/`Direct Reply`/`Custom Function`/
 * `Execute Flow`/`Retriever`).
 *
 * Why the gateway owns this map (not the console): the design audit
 * (`docs/v0.3-fidelity-audit.md` 后端契约 2) pinned this as a *backend*
 * contract — the gateway is the single choke point for the Flowise key, and
 * pushing the design shape here means the console's `/api/flows/:id` route can
 * later passthrough the gateway verbatim instead of re-deriving the shape from
 * the raw chatflow row (the v0.3-M9 milestone).
 *
 * Failure posture mirrors the other Flowise read paths: 503 when the key is
 * unset (so the key's shape isn't advertised), 502 on any upstream failure / 404
 * / shape-miss (Flowise error bodies can carry stacks / DB strings — collapsed
 * to a sanitized `upstream error`). 400 on a malformed id. Registered before
 * the `/api/v1/flows/*` prediction wildcard so the `:id` param route wins for a
 * bare id; `<id>/prediction` still falls through to the wildcard.
 *
 * Standard envelope (CLAUDE.md API convention): `{ success, data?, error? }`.
 */
async function flowsDesignShapeHandler(c: Context): Promise<Response> {
  const id = c.req.param('id')
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return failDesign(c, 400, 'invalid flow id', { id })
  }

  const encId = encodeURIComponent(id)
  let flowRow: unknown
  let execsRaw: unknown
  try {
    flowRow = await fetchFlowiseJson<unknown>(`/api/v1/chatflows/${encId}`)
    // Recent executions for the flow (newest-first on the Flowise side). A
    // page of 20 covers the design run-history panel; the design's synthetic
    // RUN_HISTORY is 3–5 rows, real usage is the same order.
    execsRaw = await fetchFlowiseJson<unknown>(
      `/api/v1/executions?agentflowId=${encId}&page=1&limit=20`,
    )
  } catch (err) {
    // 503 = key not configured (do not advertise the key's shape as a 401);
    // anything else (upstream down / 404 on the flow / non-JSON) → sanitized 502.
    if (err instanceof FlowiseFetchError && err.status === 503) {
      return failDesign(c, 503, 'flowise api key not configured')
    }
    return failDesign(c, 502, 'flow fetch failed')
  }

  const flowParsed = flowiseChatflowSchema.safeParse(flowRow)
  if (!flowParsed.success) {
    // The upstream returned 200 but the row doesn't look like a chatflow — a
    // shape drift on the Flowise side. Surface as 502 (infrastructure), not a
    // 500 leaking the zod error (which can echo field names).
    return failDesign(c, 502, 'flow shape unrecognized')
  }

  // Flowise's `getAllExecutions` always returns the `{ data, total }` envelope
  // when paginated, but tolerate a bare array too (mirrors the console route).
  const execArr = Array.isArray(execsRaw)
    ? execsRaw
    : execsRaw && Array.isArray((execsRaw as { data?: unknown }).data)
      ? (execsRaw as { data: unknown[] }).data
      : []
  const execs = execArr
    .map((row) => flowiseExecutionSchema.safeParse(row))
    .filter((r): r is { success: true; data: ReturnType<typeof flowiseExecutionSchema.parse> } => r.success)
    .map((r) => r.data)

  const shape: DesignFlowShape = mapFlowiseToDesignShape(flowParsed.data, execs)
  return c.json({ success: true, data: shape })
}

/** Sanitized envelope helper local to the flows shape route. */
function failDesign(
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
): Response {
  return c.json({ success: false, error, ...extra }, status)
}

// new-api token admin proxy + local token_meta sync (P1.4.T5). Mounted before
// the LLM passthrough so `/api/v1/tokens/*` (admin-authed) doesn't fall
// through to the caller-token LLM route.
app.route('/api/v1/tokens', tokensRoutes)

/**
 * Gateway → Flowise READ-ONLY passthrough for flow monitoring (P1.9.T5).
 *
 * The `prediction` proxy above only handles `<id>/prediction`. The console's
 * AgentFlows browse page (P1.10.T5) also needs to LIST flows and read a flow's
 * DAG definition + recent executions — Flowise serves those at
 *   GET /api/v1/chatflows          (list, ?type=AGENTFLOW)
 *   GET /api/v1/chatflows/:id      (one flow, incl. flowData DAG JSON)
 *   GET /api/v1/executions         (run history, ?agentflowId=&state=&page=&limit=)
 *
 * These are NOT in Flowise's public auth whitelist (`/api/v1/prediction/` and a
 * handful of public-* paths are — see vendor/.../utils/constants.ts), so they
 * require a Flowise API key. The gateway holds that key (`FLOWISE_API_KEY`), so
 * this route:
 *   - is GET-only (these are read paths; a POST/PUT/DELETE here is a 405),
 *   - injects `Authorization: Bearer <FLOWISE_API_KEY>` on the upstream call
 *     (the caller never sees the key),
 *   - forwards the path + query verbatim (no rewrite — Flowise's paths already
 *     match), and
 *   - collapses any non-2xx to a sanitized 502 (Flowise error bodies can carry
 *     stacks / DB strings / internal hostnames — same posture as the other
 *     proxies). 401/403 from Flowise is surfaced as 502, not 401, so the key's
 *     existence / shape is never advertised to the browser.
 *
 * When `FLOWISE_API_KEY` is unset the route returns 503 ("flowise api key not
 * configured") rather than 401 — matching the tokens route's "admin not
 * configured" posture.
 */
const FLOWISE_READONLY_PATHS = ['/api/v1/chatflows', '/api/v1/executions']
const flowiseApiKey = (): string => process.env.FLOWISE_API_KEY ?? ''

// Registered with `app.all` (not `.get`) so a non-GET hits the handler and is
// rejected with 405 "method not allowed" — a 404 would imply the path doesn't
// exist, which is misleading for a caller that POSTs to a read-only resource.
app.all('/api/v1/chatflows/*', (c) => proxyFlowiseRead(c))
app.all('/api/v1/chatflows', (c) => proxyFlowiseRead(c))
app.all('/api/v1/executions/*', (c) => proxyFlowiseRead(c))
app.all('/api/v1/executions', (c) => proxyFlowiseRead(c))

async function proxyFlowiseRead(c: Context): Promise<Response> {
  if (!flowiseApiKey()) {
    return c.json({ success: false, error: 'flowise api key not configured' }, 503)
  }

  const inbound = new URL(c.req.url)
  // Defensive: the registered routes already constrain the path, but the
  // allowlist is the security boundary — never proxy anything outside the two
  // read-only Flowise prefixes.
  if (!FLOWISE_READONLY_PATHS.some((p) => inbound.pathname === p || inbound.pathname.startsWith(p + '/'))) {
    return c.json({ success: false, error: `unsupported flowise read path: ${inbound.pathname}` }, 404)
  }

  const method = c.req.method
  if (method !== 'GET') {
    return c.json({ success: false, error: 'method not allowed' }, 405)
  }

  // Hop-by-hop headers (static set) PLUS any field the client named in its
  // Connection header (RFC 7230 §6.1 requires stripping those too). Also drop
  // the caller's authorization — the gateway injects its own Flowise key.
  const dropReq = new Set(DROP_REQUEST_HEADERS)
  dropReq.add('authorization')
  for (const f of connectionListedFields(c.req.raw.headers.get('connection'))) {
    dropReq.add(f)
  }
  const fwdHeaders = new Headers()
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (dropReq.has(k.toLowerCase())) continue
    fwdHeaders.set(k, v)
  }
  fwdHeaders.set('authorization', `Bearer ${flowiseApiKey()}`)
  fwdHeaders.set('accept', 'application/json')

  const upstreamUrl = new URL(inbound.pathname, flowiseUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers: fwdHeaders })
  } catch (err) {
    log.error('flowise read proxy failed', { path: inbound.pathname, error: String(err) })
    return c.json({ success: false, error: 'upstream unavailable' }, 502)
  }

  if (!upstream.ok) {
    log.warn('flowise read upstream error', { path: inbound.pathname, status: upstream.status })
    return c.json(
      { success: false, error: 'upstream error', upstreamStatus: upstream.status },
      502,
    )
  }

  // Success: allowlist response headers (no upstream x-* / set-cookie leak).
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  log.info('proxy flowise read', { path: inbound.pathname, status: upstream.status })
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

// new-api LLM passthrough (P1.4.T10): caller's own sk- token forwarded to
// new-api /v1/*. Flowise/daemon/console point here so new-api is the single
// LLM upstream.
app.route('/api/v1/llm', llmRoutes)

// Audit log query endpoint (M6.6 / P1.4.T6): read side of the audit trail the
// token routes + scheduler version-lock path write. ⚠️ admin-only once SSO
// (P1.4.T2) lands — the trail names actors + targets, not for end users.
app.route('/api/v1/audit', auditRoutes)

/**
 * Workspace project read API (M5b.1 / P1.10.T6): the project list + members +
 * linked flows + conversation thread + quota the console Workspace page
 * renders. Read-only, parameterised raw SQL via `runQuery`; the conversation
 * thread reuses `runs` scoped by `workspace_id` so the OTel `run_id` threads
 * end-to-end. ⚠️ membership-scoped once SSO RBAC lands — the SSO session
 * middleware (M5b.4) gates this route under `REQUIRE_LOGIN=1` (401 without a
 * valid session), but does not yet scope rows to the caller's membership; the
 * console proxy forwards the session cookie so logged-in users reach it.
 */
app.route('/api/v1/workspaces', workspaceRoutes)

/**
 * Lab multi-agent chat room API (M5b.2 / P1.10.T7): the experiment session
 * list + threaded messages the console Lab page renders. Read + append-only
 * write, parameterised raw SQL via `runQuery`; each message carries the OTel
 * `run_id` (M6.1) so a turn is end-to-end traceable. ⚠️ membership-scoped once
 * SSO RBAC lands — the SSO session middleware (M5b.4) gates this route under
 * `REQUIRE_LOGIN=1`, but does not yet scope rows to the caller's membership;
 * the console proxy forwards the session cookie so logged-in users reach it.
 */
app.route('/api/v1/lab', labRoutes)

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
 * Task creation API (v0.3-M9.3 / 后端契约 3): the design-aligned
 * `POST /api/v1/tasks` the console's new-task composer will submit to. Accepts
 * the design submit body (`title`/`description`/`assigneeType`/`assigneeId`/
 * `creatorId`/`workspaceId`/`contextRefs`/`priority`/`dueDate`), persists a
 * `tasks` row + a `runs` placeholder, and returns
 * `{ task:{id,status,runId}, runId, path }` where `path` routes the task onto
 * Path A (flow fan-out, `assigneeType='flow'`) or Path B (direct-agent
 * dispatch, `assigneeType='agent'|'squad'`). MVP does NOT trigger real
 * dispatch here — only persists + returns the path; real dispatch is driven
 * downstream by the scheduler fan-out (Path A) / dispatch claim (Path B).
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`, same
 * posture as the other gateway-owned writes.
 */
app.route('/api/v1/tasks', tasksRoutes)

/**
 * Gateway → dispatch proxy (M2.9b / P1.9).
 *
 * Unlike the Flowise proxy above, this is a *blind* passthrough — no path
 * rewrite. Dispatch mounts its own routes under `/api/v1/dispatch/*` (see
 * packages/daemon/src/client.ts: `/api/v1/dispatch/daemons/...`,
 * `/api/v1/dispatch/tasks/...`, `/api/v1/dispatch/invoke`, …), so the path is
 * forwarded verbatim: `/api/v1/dispatch/<rest>` → `${DISPATCH_URL}/api/v1/dispatch/<rest>`.
 *
 * The Flowise DispatchInvoke node (M2.9 Step 2) POSTs
 * `/api/v1/dispatch/invoke` through here so dispatch stays behind the gateway's
 * single port / auth surface instead of being dialed directly on 8081.
 *
 * No `x-run-id` is generated — dispatch keys its own runs by taskId — but a
 * caller-supplied `x-run-id` is forwarded like any other non-hop-by-hop
 * header (it isn't in DROP_REQUEST_HEADERS).
 */
app.all('/api/v1/dispatch/*', async (c) => {
  const inbound = new URL(c.req.url)
  const upstreamPath = inbound.pathname

  const method = c.req.method
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)

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

  // Buffer the body so undici sets an accurate content-length and we avoid
  // `duplex: 'half'` streaming complexity. Dispatch bodies (invoke payload,
  // task messages) are small JSON.
  const body = hasBody ? await c.req.text() : undefined

  const upstreamUrl = new URL(upstreamPath, dispatchUrl())
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers: fwdHeaders, body })
  } catch (err) {
    log.error('dispatch proxy failed', { path: upstreamPath, method, error: String(err) })
    return c.json({ success: false, error: 'upstream unavailable' }, 502)
  }

  // Upstream *application* 5xx: don't forward the body/headers verbatim —
  // dispatch error bodies can carry stacks, DB strings, internal hostnames.
  // Collapse to a sanitized 502; the real detail stays in the server log.
  if (!upstream.ok) {
    log.warn('upstream error', { path: upstreamPath, method, status: upstream.status })
    return c.json({ success: false, error: 'upstream error', upstreamStatus: upstream.status }, 502)
  }

  // Success path: allowlist response headers (no upstream `x-*` / `set-cookie`
  // / server banner leak). No x-run-id is forced here — dispatch owns its own
  // run/task id model.
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }

  log.info('proxy dispatch', { path: upstreamPath, method, status: upstream.status })

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
})

/**
 * Gateway → scheduler proxy (M6.4 / P1.11.T5): a read-only passthrough for a
 * run's node-level trace.
 *
 * The scheduler owns `run_node_spans` (it ingests Flowise's per-node trace on
 * run completion) and exposes `GET /api/v1/scheduler/runs/:runId/node-spans`.
 * The console's AgentFlows browse page reads that trace through here so the
 * scheduler stays behind the gateway's single port / auth surface (same posture
 * as the dispatch proxy above) instead of being dialed directly on 8082.
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
