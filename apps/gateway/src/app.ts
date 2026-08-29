import { Hono } from 'hono'
import { llmRoutes } from './routes/llm.js'
import { auditRoutes } from './routes/audit.js'
import { directoryRoutes } from './routes/directories.js'
import { chatRoutes } from './routes/chats.js'
import { agentsRoutes } from './routes/agents.js'
import { agentInvokeRoutes } from './routes/agent-invoke.js'
import { agentLibraryTeamRoutes } from './routes/agent-library-teams.js'
import { agentLibraryRoutes } from './routes/agent-library.js'
import { flowTemplateRoutes } from './routes/flow-templates.js'
import { flowGeneratorRoutes } from './routes/flow-generator.js'
import { chatCancelRoutes, runCancelRoutes } from './routes/execution-cancel.js'
import { llmProviderRoutes } from './routes/llm-providers.js'
import { workflowsRoutes } from './routes/workflows.js'
import { runsRoutes } from './routes/runs.js'
import { usageRoutes } from './routes/usage.js'
import { cliRuntimeRoutes } from './routes/cli-runtimes.js'
import { skillsRoutes } from './routes/skills.js'
import { internalRunsRoutes } from './routes/internal-runs.js'
import { dispatchRoutes } from './routes/dispatch/index.js'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { requireAuth, verifyApiKey, bearerFromRequest } from './auth.js'

// `app` is exported separately from the `serve()` entry so tests can drive it
// via `app.request()` without binding a port. `index.ts` is the only place
// that actually listens.
export const app = new Hono()

// Liveness/readiness probe: HTTP 层活着返回 ok:true，同时探测 Postgres ——
// DB 挂掉时返回 503，避免编排器把一个所有业务路由都在 502 的实例当成健康。
app.get('/health', async (c) => {
  try {
    await runQuery('SELECT 1')
    return c.json({ ok: true, svc: 'gateway', db: 'up' })
  } catch {
    return c.json({ ok: false, svc: 'gateway', db: 'down' }, 503)
  }
})

/**
 * Gateway auth middleware.
 *
 * The gateway is a local-machine service and runs open by default (no login).
 * The only optional gate is `GATEWAY_API_KEY`: when set (16+ chars), every
 * non-public route requires it as a bearer token — for operators who expose
 * the gateway beyond localhost.
 *
 * Public routes (always reachable):
 *   - `/health`
 *   - `/api/v1/llm/*`   (LLM proxy; the upstream provider's own `sk-` token is the auth)
 *
 * NOTE: this middleware must be registered BEFORE any route that should be
 * gated (Hono runs matched handlers in registration order — a route registered
 * above this block would skip the gate entirely).
 *
 * Dispatch daemon-protocol routes (`/api/v1/dispatch/*`) carry their own
 * per-route token auth and are exempted below:
 *   - `register` requires `DAEMON_REGISTER_TOKEN` (when set)
 *   - `heartbeat`/`claim` require the daemon's own token (checked per-route)
 *   - task lifecycle (`start`/`progress`/`messages`/`complete`/`fail`) requires
 *     the claiming daemon's token (checked per-route)
 * Everything else under dispatch/* (fleet reads, invoke, agent/task reads)
 * falls through to the gateway key like any other route.
 */
app.use('*', async (c, next) => {
  if (!requireAuth()) {
    await next()
    return
  }

  // API key gate is configured. Check public routes.
  const path = new URL(c.req.url).pathname
  const isPublic =
    path === '/health' ||
    path.startsWith('/api/v1/llm/')        // LLM proxy uses the provider's own API key as auth
  if (isPublic) {
    await next()
    return
  }

  // Check API key (for programmatic access).
  const bearer = bearerFromRequest(c)
  if (verifyApiKey(bearer)) {
    await next()
    return
  }

  // Daemon protocol routes: token-authed per route (see block comment above).
  const daemonProtocol =
    path === '/api/v1/dispatch/daemons/register' ||
    path === '/api/v1/dispatch/daemons/heartbeat' ||
    /^\/api\/v1\/dispatch\/daemons\/[^/]+\/tasks\/claim$/.test(path) ||
    /^\/api\/v1\/dispatch\/tasks\/[^/]+\/(start|progress|messages|complete|fail)$/.test(path)
  if (daemonProtocol) {
    await next()
    return
  }

  return c.json({ success: false, error: 'authentication required' }, 401)
})

/**
 * Internal callback endpoints (Phase 1 / trial-readiness): daemons dial these
 * after an async task completes to write the assistant message + broadcast
 * chat:done. Internal services authenticate via `x-internal-token`
 * (matching INTERNAL_CALLBACK_TOKEN env), not a browser session. The token
 * check fails closed when INTERNAL_CALLBACK_TOKEN is unset; when
 * `GATEWAY_API_KEY` is configured, the middleware above gates this surface
 * too (defense in depth).
 *
 * Registered AFTER the auth middleware so the gate applies to it.
 */
app.route('/internal', internalRunsRoutes)

// LLM provider proxy: dynamically forwards to the user-configured LLM provider
// based on X-LLM-Provider-Id header (or first active provider).
app.route('/api/v1/llm', llmRoutes)

// Audit log query endpoint (M6.6 / P1.4.T6): read side of the audit trail.
// The trail names actors + targets — meant for the local operator, not end users.
app.route('/api/v1/audit', auditRoutes)

/**
 * Directory CRUD API: directories list + detail + create + update + delete
 * with chat_count subquery. Parameterised raw SQL via `runQuery`.
 */
app.route('/api/v1/directories', directoryRoutes)

/**
 * Chat CRUD API: chat list + detail + create + update + delete with messages.
 * Parameterised raw SQL via `runQuery`; message creation uses a transactional
 * CTE to atomically insert the message and update chat counters.
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
 * proxy below, which returns the snake_case `agent_daemons` join.
 */
app.route('/api/v1/agents', agentsRoutes)

/**
 * Synchronous one-shot agent invoke (POST /:id/invoke): spawn the agent's CLI
 * backend and return the final text. Mounted at the same prefix as the
 * catalogue routes above (Hono merges routers) — used by the canvas AI flow
 * generator and any "run agent, get text" caller.
 */
app.route('/api/v1/agents', agentInvokeRoutes)

/**
 * Agent Template Library (one-click agent creation): static catalogue of
 * pre-configured agent templates + an `instantiate` endpoint that writes a
 * real `agents` row from a template. Mounted alongside `/api/v1/agents` so
 * the console's template gallery proxy can sit next to the agents proxy.
 */
  // agent-templates 已退役（2026-08-23）：5 个预设翻译为 quickstart-library 人格，见 routes/agent-library.ts

/**
 * Agent Library (docs/agent-library.md): registry-not-database 人格库目录 +
 * instantiate（启用 = fork 成 agents 行）+ drift/reimport（上游同步三态）。
 * 与 agent-templates 相邻：同一「一键创建 Agent」UX 家族，只是真相源从
 * in-repo 静态目录换成挂载的文件系统库（如 agency-agents 的 git clone）。
 *
 * teams 子路由必须先挂：`/team-templates/:id/instantiate` 与本组的
 * `/:division/:slug/instantiate` 同形，Hono 按注册顺序匹配。
 */
app.route('/api/v1/agent-library', agentLibraryTeamRoutes)
app.route('/api/v1/agent-library', agentLibraryRoutes)

/**
 * Flow Templates（docs/flow-templates.md）：内置（in-repo JSON）+ 用户（表）
 * 双源模板中心 —— list / from-flow（画布另存为模板）/ instantiate（persona
 * 重绑或降级 LLM 节点）/ delete（仅用户模板）。
 */
app.route('/api/v1/flow-templates', flowTemplateRoutes)

/**
 * Unified AI flow-generation pipeline (docs/product-plan.md 方案 A1): the
 * chat `@workflow` command calls the service in-process; the canvas
 * GenerateFlowDialog BFF proxies this route. One prompt, one engine policy
 * (CLI-first + HTTP insurance), one validator — no second implementation.
 */
app.route('/api/v1/flow-generator', flowGeneratorRoutes)

/**
 * Execution cancellation (spec D5): POST /chats/:id/cancel and
 * POST /workflows/runs/:runId/cancel find the live execution in the
 * in-process registry and abort it. 409 when nothing is running.
 */
app.route('/api/v1/chats', chatCancelRoutes)
app.route('/api/v1/workflows', runCancelRoutes)

/**
 * LLM Provider CRUD API: llm provider list + detail + create + update + delete + test.
 */
app.route('/api/v1/llm-providers', llmProviderRoutes)

/**
 * Workflows CRUD API: workflow list + detail + create + update + delete.
 */
app.route('/api/v1/workflows', workflowsRoutes)

/**
 * 跨 Flow 运行历史（PRD F5）：runs 按时间倒序 + 流程名 + 失败摘要。
 */
app.route('/api/v1/runs', runsRoutes)

/**
 * Usage & cost billing API (方案 D / AD-3): SQL aggregation over the
 * append-only `usage_events` table — the billing truth source written by the
 * chat / workflow-run / dispatch terminal states. Console's Settings →
 * 用量与成本 tab reads this via its BFF proxy.
 */
app.route('/api/v1/usage', usageRoutes)

/**
 * CLI Runtime detection (open-design parity): scans the gateway host's PATH
 * for installed CLI agent binaries and returns real-time install status.
 * The console's settings → CLI 运行时 tab calls this instead of showing
 * a hardcoded "未配置" for every row.
 */
app.route('/api/v1/cli-runtimes', cliRuntimeRoutes)

/**
 * Skills catalog (registry-not-database): runtime discovery of local agent
 * skills (`~/.agents/skills` + `DAGENTS_SKILL_DIRS`), the cross-client
 * convention shared by Cursor / Gemini CLI / Copilot CLI. Read-only — the
 * filesystem is the source of truth, nothing is persisted.
 */
app.route('/api/v1/skills', skillsRoutes)

/**
 * Dispatch protocol routes (spec §1.5), merged into gateway (Plan A, 2026-08-01).
 *
 * Originally a separate `apps/dispatch/` Hono app on :8081; now mounted inline.
 * Daemon clients dial gateway (:8080) instead of a separate dispatch port.
 * The 20 routes (daemons/tasks/agents/invoke/runs-usage/fleet-stats) + 2 service
 * modules live in `src/routes/dispatch/`.
 *
 * Auth posture: `/api/v1/dispatch/*` routes are machine-to-machine and rely
 * on network isolation (gateway binds 127.0.0.1) plus per-route daemon tokens
 * rather than session auth. Production deployments should put a reverse proxy
 * with IP allowlist in front for the dispatch paths.
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
