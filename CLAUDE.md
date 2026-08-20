# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dagents 平台 (Dagents Platform) — a TS/Node monorepo with Chat-First UX and a **central dispatch + local daemon** two-tier design for heterogeneous coding agents (claude, codex, …). 工作流引擎已内聚到 `@dagents/workflow`（Plan A/B/C 全部完成）；画布编辑器使用 `vendor/agentflow/`（从 Flowise 抽出的 Agentflow 组件，纯前端 React Flow，无后端服务）。

The architectural source of truth is `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` (Chat-First 双维度模型，顶部含实现状态总览). 所有已完成的 plans / 历史 specs / 验证记录 / 设计原型均已归档至 `docs/archive/{plans,specs,verification,design}/`。

Two local skills are auto-discovered and should be invoked when relevant:
- `dagents-patterns` — repo commit/doc/workflow conventions (read this before committing or adding docs).
- `multica-ops` — driving the multica CLI (the issue tracker this repo's plan tasks are mirrored into).

## Commands

Root (turbo, runs across all workspaces):
```bash
pnpm install      # NOTE: .npmrc sets ignore-scripts=true — vendored agentflow has no .git,
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
pnpm --filter @dagents/console dev          # next dev, :3000
pnpm --filter @dagents/daemon dev -- http://localhost:8080 dev-laptop claude   # daemon CLI
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

Local infra (Postgres + Langfuse):
```bash
cd infra && docker compose up -d && docker compose ps
```
画布编辑器 vendored 在 `vendor/agentflow/`（从 Flowise Agentflow 抽取的纯前端 React 组件库，不依赖任何后端服务）。Plan A/B/C 已全部完成：工作流引擎迁至 `packages/workflow/`、`flows` 表 + `/api/v1/workflows/*` API 落地、console `/workflows/[id]/canvas` 替代旧 `/flows` 编辑入口、gateway 不再有任何 Flowise proxy 路由。

## Ports & env (defaults)

| Service | Port | Notes |
|---|---|---|
| gateway | 8080 | `GATEWAY_URL` |
| console (Next) | 3000 | `apps/console` |
| Langfuse | 3001 | v2.x pinned — **v3 requires ClickHouse**; see `infra/README.md` |
| Postgres | host **15432** → 5432 | remapped to avoid host collisions; `POSTGRES_URL` |

Env templates: `infra/.env.example` (infra) and per-app reads in `apps/*/src/index.ts`. Gateway dev SSO: `SSO_DEV_USERNAME` / `SSO_DEV_PASSWORD` / `SSO_SESSION_SECRET` + `REQUIRE_LOGIN=1` to gate routes.

## Architecture

### Layered flow (the "big picture")

```
console (Next) → gateway (Hono) → @dagents/workflow engine (in-repo)
   → [dispatch routes inline] → local daemon → claude/codex CLI → LLM Provider (用户自定义配置)
```
- Every hop carries a business `run_id` (via `x-run-id` header) **and** a W3C `traceparent` (via OTel auto-instrumentation of `fetch`/`http`). These are different: `run_id` is the platform's; `traceId` is OTel's. Both must thread end-to-end.
- **Workflow engine** lives in `packages/workflow/` (Plan A/B/C 完成)。14 节点 + DAG 执行器 + SSE 流式 + 变量解析。Canvas 编辑器在 `vendor/agentflow/`（前端组件），数据持久化在 `flows` 表，通过 gateway `/api/v1/workflows/*` 路由 CRUD。架构与执行模型详见 `docs/workflow-engine.md`。
- **CLI 第一性（2026-08-18）**：本地 CLI agent 是基线执行引擎，HTTP LLM Provider 只是可选加速 —— `@workflow` 生成默认走 CLI spawn（失败才降级 HTTP）；工作流执行的 llmClient 无 provider 时用 CLI 兜底（`createDefaultLlmClient`），LLM/Agent 节点零配置可跑。
- **fs-registry 家族（同构模式：文件系统即真相源 + TTL 缓存 + warn-and-skip + rank 去重）**：技能库 `skills-registry.ts`（`~/.agents/skills`）→ Agent 人格库 `agent-library-registry.ts`（`~/.agents/agent-library`，挂 agency-agents 类人格库；启用 = fork 成 agents 行，drift 三态同步）→ 流程模板中心 `flow-templates/`（内置 JSON import 内联 + 用户模板表；personaName 重绑、未挂库降级 LLM 节点）。详见 `docs/skills-registry.md` / `docs/agent-library.md` / `docs/flow-templates.md`。

### Monorepo & dependency direction (enforced, no cycles)

```
contracts  ←  agent-adapters  ←  daemon
contracts  ←  db
shared     ←  (all)
workflow   ←  gateway (engine + 14 nodes)
db         ←  gateway
vendor/agentflow  ← console (canvas editor, not an npm dep)
```
- `@dagents/contracts` is **zero-dependency** and built first — every layer depends on its types.
- Dispatch routes (now inlined in `gateway` at `src/routes/dispatch/`) depend **only** on `contracts` (not `daemon`) — they're decoupled by the HTTP claim/complete protocol in `packages/contracts/src/protocol.ts`.
- `@dagents/workflow` is consumed by `gateway` (server-side execution) and indirectly by `console` (type-only, for the canvas shape).
- `vendor/agentflow/` is consumed by `console` directly (file: dep) — pure frontend React Flow canvas, no server.
- Package build outputs are ESM via `tsup` (`--format esm --dts`); apps use `tsx watch` for dev and `tsup`/`next build` for prod. All read `tsconfig.base.json`.

### Key contracts (read these before touching agent code)

- `packages/contracts/src/agent.ts` — `AgentBackend.execute()`, `ExecOptions` (cwd/model/timeoutMs/inactivityTimeoutMs/resumeSessionId/extraArgs/customArgs/mcpConfig/thinkingLevel), `AgentEvent` (discriminated union incl. `log`), `AgentResult`, `TokenUsage`. Translated from multica `server/pkg/agent/agent.go`.
- `packages/contracts/src/protocol.ts` — dispatch↔daemon DTOs: `RegisterRequest`/`Response`, `HeartbeatPayload`, `DispatchTask`, `ClaimTaskResponse`, `TaskMessageBatch`, `TaskComplete`, `TaskFail`. The daemon is **pull-based**: it POSTs `/tasks/claim`.
- `packages/daemon/src/main.ts` — `runDaemon()` loop: `register → heartbeat → poll/claim → execute → reportMessages (best-effort) → completeTask/failTask (authoritative)`. A 409 from a terminal endpoint is the expected "already done" signal — swallow it. SIGINT/SIGTERM → graceful drain (finish in-flight, stop claiming). Only `register` failing is fatal.
- `packages/agent-adapters/src/factory.ts` — `AgentType` → 具体适配器映射。17 种 CLI 适配器已实现（claude / codex / qwen / copilot / opencode / codebuddy / cursor / deveco / antigravity / openclaw / pi / hermes / kimi / kiro / grok / qoder / traecli），每种一个文件。注意：codex / codebuddy / copilot / qwen 本机未安装，适配器按官方文档格式实现、未经真实 CLI 回归。

### Apps

- **gateway** (`apps/gateway`): Hono. SSO (dev: HMAC stateless session), route/audit, in-repo `@dagents/workflow` 执行入口（`/api/v1/workflows/*` CRUD + run，含 `run_node_spans` 读写），含原 dispatch 协议路由（`/api/v1/dispatch/*`，20 路由 + 2 service 模块在 `src/routes/dispatch/`），LLM Provider CRUD + 动态代理转发，directories/chats/agents routes (chat-first model). `app.ts` exports `app` separately from `index.ts` so tests drive it via `app.request()`. Boots OTel → `initDb()` → `serve()`. scheduler 服务已于 2026-08-01 (Plan A) 并入 gateway，原 :8082 端口 + Redis 依赖废弃。
- **console** (`apps/console`): Next.js App Router. **Never dials backend services directly** — every prediction / workflow run goes through the gateway (`src/lib/config.ts: gatewayUrl()`). Chat-First layout: chat home (`/`) + chat detail (`/chats/{id}`) + agents / flows / daemons / settings / directories. Workflow 画布编辑在 `/workflows/[id]/canvas`（使用 `vendor/agentflow/`），浏览在 `/flows`。Vitest alias `@/` mirrors tsconfig `paths`.

### Shared infra code (`@dagents/shared`)

- `otel.ts` — `startTracing(svcName)`: must be called **before any I/O** in each app's `index.ts` so auto-instrumentations patch `fetch`/`http` before the first request. Attaches a real OTLP/HTTP exporter **only if** `OTEL_EXPORTER_OTLP_ENDPOINT` is set (dev/test stay collector-free). Tests inject an `InMemorySpanExporter`. Note: Langfuse v2 does **not** expose OTLP ingestion — setting `OTEL_EXPORTER_OTLP_ENDPOINT` to Langfuse v2 will **not** land traces there (needs v3/ClickHouse or a collector).
- `trace.ts` — `TraceContext { runId, traceId, parentRunId? }`.
- `logger.ts` — pino logger; explicit `runId` on the context wins over the span's.

### DB (`@dagents/db`)

- `AppDataSource` (TypeORM, postgres). Entities in `src/entities/`, migrations in `src/migrations/` (timestamp-prefixed, e.g. `1720000002000-create-runs.ts`). 同库同 ORM 模型已与 Flowise 时代完全脱钩（Plan C 完成，`flows` 表替代 `chatflows`）。
- **Use `runQuery()`** (in `data-source.ts`), not `AppDataSource.query()`. `query()` drops the structured-result arg, so raw results come back inconsistently shaped (bare rows vs `[rows, rowCount]`). `runQuery()` always returns `{ records, affected }` and wraps in a short-lived transaction.
- `initDb()` is idempotent; called once at each app's bootstrap.

## Workflow & conventions

### Brainstorm → spec → plan → issue → execute (mandatory)

Every new feature goes through all 4 stages (powered by superpowers skills). **Don't write code before a spec + plan exist for it.** If asked to "just implement X", first check `docs/superpowers/specs/` + `docs/superpowers/plans/`; if none exist, propose brainstorming.
- Specs → `docs/superpowers/specs/` (decision snapshot table, Gate definitions, trade-offs).
- Plans → `docs/superpowers/plans/` (TDD task list; each task: files / failing test / implementation / commit).
- Plan tasks are mirrored into multica issues (project `f34a5b20`).

### Two Gates

- **Gate-1** (M2): dispatch↔daemon protocol spike — `register/heartbeat/claim/start/messages/complete/fail/usage/session` translated from multica. 已通过。
- **Gate-2** (M0, parallel): Flowise fork builds + "where does Flow Execution State live?" — 历史决策，已归档见 `docs/archive/architecture/gate-2-flow-state.md`。工作流引擎已迁移至 `packages/workflow/`（Plan A/B/C 完成），见 `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` §1.4。

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

- Vitest, per-package. `*.test.ts` colocated with source (or in `__tests__/`). Gateway tests drive the Hono app via `app.request()`（`app.ts` 与 `index.ts` 分离导出即为此设计）；集成测试需要 Postgres dev 栈（PG :15432）在线。
- Playwright E2E in `apps/console/tests/e2e/`: 11 个 spec 文件覆盖 Chat-First 用户旅程（chat home/detail、directories、agents、agentflows 等），需 console + gateway 运行中。
- 原 `packages/e2e`（跨进程 traceparent 透传验证）已于 2026-08-16 审计删除——空壳无断言；如需跨进程传播验证需重新引入。

## CodeGraph

This project has a `.codegraph/` index. For structural questions (callers, callees, trace path X→Y, impact of changing Z) prefer the `codegraph_*` MCP tools over grep+read loops. See the global CLAUDE.md for the full tool selection table.
