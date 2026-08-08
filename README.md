# Dagents 平台

Chat-First 的异构 coding agent 平台。**中央调度（gateway）+ 本地 daemon** 两层架构，统一编排 claude / codex 等 CLI agent；工作流引擎内聚在 `@dagents/workflow`，画布编辑器使用 vendored `agentflow`。

## 架构

```
console (Next) → gateway (Hono) → @dagents/workflow → dispatch 路由（已并入 gateway）
                                              → 本地 daemon → claude/codex CLI → LLM Provider
```

- **gateway** (`apps/gateway`, :8080) — Hono。SSO、路由/审计、工作流执行入口（`/api/v1/workflows/*`）、dispatch 协议路由、LLM Provider CRUD + 动态代理转发。
- **console** (`apps/console`, :3000) — Next.js App Router。Chat-First：`/` 首页 + `/chats/{id}` 详情 + agents / flows / daemons / settings / directories；画布编辑在 `/workflows/[id]/canvas`。**所有后端调用都经 gateway**。
- **daemon** (`packages/daemon`) — pull-based：`register → heartbeat → claim → execute → complete`。

依赖方向（无环）：`contracts ← {agent-adapters, daemon, db} ← gateway`；`workflow ← gateway`；`vendor/agentflow ← console`。

## 跑起来

```bash
pnpm install                       # .npmrc 设 ignore-scripts=true，跳过 vendor 的 husky
cd infra && docker compose up -d   # Postgres :15432 + Langfuse :3001
pnpm --filter @dagents/db migration:run
pnpm --filter @dagents/gateway dev          # :8080
pnpm --filter @dagents/console dev          # :3000
pnpm dev:daemon                             # daemon CLI → http://localhost:8080
```

| 服务 | 端口 | 说明 |
|---|---|---|
| gateway | 8080 | `GATEWAY_URL` |
| console | 3000 | Next.js |
| Langfuse | 3001 | v2（v3 需 ClickHouse） |
| Postgres | host **15432** → 5432 | `POSTGRES_URL` |

## 常用命令

```bash
pnpm build / test / typecheck      # turbo，跨所有 workspace
pnpm --filter @dagents/gateway exec vitest run src/__tests__/auth.test.ts      # 单文件
pnpm --filter @dagents/gateway exec vitest run -t "rejects missing session"   # 单测试
pnpm --filter @dagents/db migration:generate                                    # 从 entity 改动生成迁移
```

## 文档

- **CLAUDE.md** — Claude Code 工作指南（架构分层、关键契约、命令、约定）。
- **架构真相源** — `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md`（顶部「实现状态总览」表反映当前进度）。
- **活跃 plans** — `docs/superpowers/plans/`；历史决策 / 验证记录 / 设计原型归档在 `docs/archive/`。
- **工作流** — 新功能走 brainstorm → spec → plan → issue → execute（见 CLAUDE.md）。
- **CI** — `.github/workflows/ci.yml`（push/PR 跑 build • typecheck • test，含 Postgres service + migration）。
