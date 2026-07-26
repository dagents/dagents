# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dagents 平台 (Dagents Platform) — a TS/Node monorepo with Chat-First UX and a **central dispatch + local daemon** two-tier design for heterogeneous coding agents (claude, codex, …). Migrated from Flowise-vendored architecture to in-repo `@dagents/workflow` engine; Flowise vendored fork remains for canvas editing only until Plan C removes it.

The architectural source of truth is `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` (Chat-First 双维度模型，顶部含实现状态总览). 所有已完成的 plans / 历史 specs / 验证记录 / 设计原型均已归档至 `docs/archive/{plans,specs,verification,design}/`。

Two local skills are auto-discovered and should be invoked when relevant:
- `dagents-patterns` — repo commit/doc/workflow conventions (read this before committing or adding docs).
- `multica-ops` — driving the multica CLI (the issue tracker this repo's plan tasks are mirrored into).

## Commands

Root (turbo, runs across all workspaces):
```bash
pnpm install      # NOTE: .npmrc sets ignore-scripts=true — vendored Flowise has no .git,
                   #   so its `postinstall: husky install` would fail. Scripts are skipped globally.
pnpm build        # turbo run build   (tsup → dist/, next build for console)
pnpm test         # turbo run test    (vitest run, per-package)
pnpm typecheck    # turbo run typecheck (tsc --noEmit, depends on ^build)
pnpm lint         # turbo run lint
pnpm dev          # turbo run dev --parallel  (all apps at once — rarely what you want)
```

Per-workspace (preferred for dev):
```bash
pnpm --filter @dagents/gateway dev          # tsx watch, :8080
pnpm --filter @dagents/dispatch dev         # :8081
pnpm --filter @dagents/scheduler dev        # :8082
pnpm --filter @dagents/console dev          # next dev, :3000
pnpm --filter @dagents/daemon dev -- http://localhost:8081 dev-laptop claude   # daemon CLI
```

Single test file / single test:
```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/auth.test.ts
pnpm --filter @dagents/gateway exec vitest run -t "rejects missing session"
```

DB migrations (TypeORM, `packages/db`):
```bash
pnpm --filter @dagents/db migration:generate    # generate from entity changes
pnpm --filter @dagents/db migration:run          # apply pending
pnpm --filter @dagents/db migration:revert       # roll back the last
```

Local infra (Postgres + Redis + MinIO + Langfuse):
```bash
cd infra && docker compose up -d && docker compose ps
```
Flowise is **vendored separately** at `vendor/flowise/` and run from source (`pnpm --filter flowise start`, port 3101) — it is deliberately **not** in the compose stack. Migration to the in-repo `packages/workflow` engine is in progress (Plan A complete; see `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md`); Flowise stays vendored until Plan C removes it.

## Ports & env (defaults)

| Service | Port | Notes |
|---|---|---|
| gateway | 8080 | `GATEWAY_URL` |
| dispatch | 8081 | `DISPATCH_PORT` |
| scheduler | 8082 | `SCHEDULER_URL` |
| console (Next) | 3000 | `apps/console` |
| Flowise | 3101 | vendored, own `.env` at `vendor/flowise/packages/server/.env` (migration to `packages/workflow` in progress) |
| Langfuse | 3001 | v2.x pinned — **v3 requires ClickHouse**; see `infra/README.md` |
| MinIO | 9000 / 9001 | `MINIO_ENDPOINT`, bucket `dagents` |
| Postgres | host **15432** → 5432 | remapped to avoid host collisions; `POSTGRES_URL` |
| Redis | host **16479** → 6379 | `--requirepass dagents_dev` baked in dev; `REDIS_URL` |

Env templates: `infra/.env.example` (infra) and per-app reads in `apps/*/src/index.ts`. Gateway dev SSO: `SSO_DEV_USERNAME` / `SSO_DEV_PASSWORD` / `SSO_SESSION_SECRET` + `REQUIRE_LOGIN=1` to gate routes.

## Architecture

### Layered flow (the "big picture")

```
console (Next) → gateway (Hono) → Flowise prediction → dispatch HTTP node
   → dispatch server (Hono) → [claim] → local daemon → claude/codex CLI → LLM Provider (用户自定义配置)
```
- **scheduler** sits alongside: it owns the Redis queue (`dagents:tasks`), the concurrency semaphore (`dagents:sem`), and does batch **fanOut** (one parent run + N child runs). It calls gateway for predictions.
- Every hop carries a business `run_id` (via `x-run-id` header) **and** a W3C `traceparent` (via OTel auto-instrumentation of `fetch`/`http`). These are different: `run_id` is the platform's; `traceId` is OTel's. Both must thread end-to-end.
- Every run is snapshotted + bound to a `pipeline_version_hash` (`@dagents/repro`) inline at `createRun` time; output is archived to MinIO (`runs.artifact_uri`). `POST /api/v1/scheduler/runs/:runId/reproduce` re-executes a terminal run with the same hash + input and structurally compares outputs.

### Monorepo & dependency direction (enforced, no cycles)

```
contracts  ←  agent-adapters  ←  daemon
contracts  ←  dispatch
contracts  ←  db ← repro
shared     ←  (all)
workflow   ←  (node implementers; depends on shared only)
db         ←  gateway / dispatch / scheduler
vendor/flowise  ← (canvas editor only, not an npm dep; being phased out by packages/workflow)
```
- `@dagents/contracts` is **zero-dependency** and built first — every layer depends on its types.
- `dispatch` depends **only** on `contracts` (not `daemon`) — they're decoupled by the HTTP claim/complete protocol in `packages/contracts/src/protocol.ts`.
- Package build outputs are ESM via `tsup` (`--format esm --dts`); apps use `tsx watch` for dev and `tsup`/`next build` for prod. All read `tsconfig.base.json`.

### Key contracts (read these before touching agent code)

- `packages/contracts/src/agent.ts` — `AgentBackend.execute()`, `ExecOptions` (cwd/model/timeoutMs/inactivityTimeoutMs/resumeSessionId/extraArgs/customArgs/mcpConfig/thinkingLevel), `AgentEvent` (discriminated union incl. `log`), `AgentResult`, `TokenUsage`. Translated from multica `server/pkg/agent/agent.go`.
- `packages/contracts/src/protocol.ts` — dispatch↔daemon DTOs: `RegisterRequest`/`Response`, `HeartbeatPayload`, `DispatchTask`, `ClaimTaskResponse`, `TaskMessageBatch`, `TaskComplete`, `TaskFail`. The daemon is **pull-based**: it POSTs `/tasks/claim`.
- `packages/daemon/src/main.ts` — `runDaemon()` loop: `register → heartbeat → poll/claim → execute → reportMessages (best-effort) → completeTask/failTask (authoritative)`. A 409 from a terminal endpoint is the expected "already done" signal — swallow it. SIGINT/SIGTERM → graceful drain (finish in-flight, stop claiming). Only `register` failing is fatal.
- `packages/agent-adapters/src/claude.ts` — the **only** adapter implemented today (MVP). A daemon started for any non-claude `AgentType` fails loudly at execute time, not silently. New adapters land as their own files (`codex.ts`, …).

### Apps

- **gateway** (`apps/gateway`): Hono. SSO (dev: HMAC stateless session), route/audit, Flowise **read** proxy (`/api/v1/chatflows`, `/api/v1/executions`), dispatch proxy, LLM Provider CRUD + 动态代理转发, directories/chats/agents routes (chat-first model). `app.ts` exports `app` separately from `index.ts` so tests drive it via `app.request()`. Boots OTel → `initDb()` → `serve()`.
- **dispatch** (`apps/dispatch`): Hono. Task queue + daemon registry + claim/complete. Routes in `src/routes/` (`agents`, `daemons`, `tasks`, `invoke`, `fleet-stats`, `runs-usage`).
- **scheduler** (`apps/scheduler`): Hono. `startWorker` (BRPOP `dagents:tasks`) + HTTP `fanOut` share one Redis semaphore + one `runs` table. `recoverStaleRuns` on boot re-seeds slots leaked by a SIGKILL'd process (disable with `SCHEDULER_RECOVER_ON_START=0` for multi-instance). Reproduce route in `src/reproduce.ts`.
- **console** (`apps/console`): Next.js App Router. **Never dials Flowise directly** — every prediction goes through the gateway (`src/lib/config.ts: gatewayUrl()`). Chat-First layout: chat home (`/`) + chat detail (`/chats/{id}`) + agents / flows / daemons / settings / directories. Canvas editing still uses Flowise native UI (D4/D5) until Plan C. Vitest alias `@/` mirrors tsconfig `paths`.

### Shared infra code (`@dagents/shared`)

- `otel.ts` — `startTracing(svcName)`: must be called **before any I/O** in each app's `index.ts` so auto-instrumentations patch `fetch`/`http` before the first request. Attaches a real OTLP/HTTP exporter **only if** `OTEL_EXPORTER_OTLP_ENDPOINT` is set (dev/test stay collector-free). Tests inject an `InMemorySpanExporter`. Note: Langfuse v2 does **not** expose OTLP ingestion — setting `OTEL_EXPORTER_OTLP_ENDPOINT` to Langfuse v2 will **not** land traces there (needs v3/ClickHouse or a collector).
- `trace.ts` — `TraceContext { runId, traceId, parentRunId? }`.
- `logger.ts` — pino logger; explicit `runId` on the context wins over the span's.
- `redis.ts` — `createRedis()`.

### DB (`@dagents/db`)

- `AppDataSource` (TypeORM, postgres). Entities in `src/entities/`, migrations in `src/migrations/` (timestamp-prefixed, e.g. `1720000002000-create-runs.ts`). Same DB/schema as Flowise (D8) — single migration system.
- **Use `runQuery()`** (in `data-source.ts`), not `AppDataSource.query()`. `query()` drops the structured-result arg, so raw results come back inconsistently shaped (bare rows vs `[rows, rowCount]`). `runQuery()` always returns `{ records, affected }` and wraps in a short-lived transaction.
- `initDb()` is idempotent; called once at each app's bootstrap.

## Workflow & conventions

### Brainstorm → spec → plan → issue → execute (mandatory)

Every new feature goes through all 4 stages (powered by superpowers skills). **Don't write code before a spec + plan exist for it.** If asked to "just implement X", first check `docs/superpowers/specs/` + `docs/superpowers/plans/`; if none exist, propose brainstorming.
- Specs → `docs/superpowers/specs/` (decision snapshot table, Gate definitions, trade-offs).
- Plans → `docs/superpowers/plans/` (TDD task list; each task: files / failing test / implementation / commit).
- Plan tasks are mirrored into multica issues (project `f34a5b20`).

### Two Gates

- **Gate-1** (M2): dispatch↔daemon protocol spike — `register/heartbeat/claim/start/messages/complete/fail/usage/session` translated from multica.
- **Gate-2** (M0, parallel): Flowise fork builds + "where does Flow Execution State live?" — 历史决策，已归档见 `docs/archive/architecture/gate-2-flow-state.md`。当前工作流引擎迁移至 `packages/workflow/`，见 `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` §1.4。

### Commits — conventional commits, **Chinese descriptions**

```
<type>: <中文描述>
```
Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`. Single-line, parenthetical detail with `()` `、` `，`. **No attribution trailer** (globally disabled). Don't switch to English mid-project.

Merge commits follow a role-signing format observed throughout history:
```
Merge: [<milestone>] <中文描述> (<reviewer-role> 对抗式评审通过)
```
Reviewer roles seen: `code-reviewer` (adversarial review / 对抗式评审), `product-team`, `project-architect` (双签通过 = dual sign-off). Code review is expected before merge — use the `code-reviewer` agent.

### Testing

- Vitest, per-package. `*.test.ts` colocated with source (or in `__tests__/`).
- E2E in `packages/e2e`: **boots real Hono apps on ephemeral ports** with stub Flowise/LLM/new-api as real `node:http` servers + a real `runDaemon` with a fake claude backend. Why real `serve()` and not `app.request()`: the W3C `traceparent` that undici auto-instrumentation injects is only extracted on the receiving hop by the `http` server instrumentation — in-process `app.request()` calls cannot exercise cross-process propagation.
- E2E requires the docker-compose dev stack up (PG :15432, Redis :16479); `setup.ts` runs pending migrations before tests. `fileParallelism: false`, 60s timeouts.

## CodeGraph

This project has a `.codegraph/` index. For structural questions (callers, callees, trace path X→Y, impact of changing Z) prefer the `codegraph_*` MCP tools over grep+read loops. See the global CLAUDE.md for the full tool selection table.
