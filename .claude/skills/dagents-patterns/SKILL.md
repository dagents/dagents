---
name: dagents-patterns
description: Conventions and workflow patterns for the dagents repo (Dagents 平台). Use when working in this repo — committing, adding docs/specs/plans, or making architecture decisions.
version: 2.0.0
source: local-git-analysis
last_updated: 2026-08-01
---

# dagents Repo Patterns

> Extracted from git history + repo docs. 项目已从 MVP 计划阶段进入 Trial Readiness 阶段：Chat-First UX、`@dagents/workflow` 引擎内聚、`vendor/flowise/` 移除、`flows` 表 + `/api/v1/workflows/*` API 落地。架构真相源在 `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md`。

## Commit Conventions

This project uses **conventional commits with Chinese descriptions**:

```
<type>: <中文描述>
```

- **Types in use**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`
- **Message language**: Chinese (简体中文). Multi-clause messages use `(` `)` and Chinese punctuation `、` `，`.
- Single-line, often with parenthetical detail.
- **No attribution trailer** (attribution disabled globally per user rules).

Recent examples from history:
- `refactor: 删除已被 Flowise 画布取代的自研画布死代码`
- `feat: 补全 agent flow 缺陷 — tool-calling loop + agent 引用检查 + 双读路径统一`
- `fix: 设计系统升级 + Daemon 列表重构 + Agent 详情宽度修复 + 网关安全加固`
- `feat: 全站 UI 文案统一为中文 (zh-CN)`

Merge commits use a role-signing format:
```
Merge: [<milestone>] <中文描述> (<reviewer-role> 对抗式评审通过)
```
Reviewer roles: `code-reviewer` (对抗式评审), `product-team`, `project-architect` (双签通过 = dual sign-off).

**Rule**: When committing in this repo, match the type + Chinese description style. Don't switch to English mid-project.

## Documentation Architecture

```
docs/
├── superpowers/                 # 当前活跃 spec/plan（brainstorm → spec → plan 流水线产出）
│   ├── specs/
│   │   ├── 2026-07-25-system-architecture-redesign.md   # 架构真相源 (Chat-First 双维度模型)
│   │   ├── 2026-07-28-trial-readiness.md                # Trial Readiness spec
│   │   └── flowise-migration-compat.md                  # Flowise 迁移期兼容承诺
│   └── plans/
│       ├── 2026-07-27-flowise-migration-v2-workflow.md  # Plan A/B/C（已完成）
│       └── 2026-07-28-trial-readiness.md                # Trial Readiness plan
└── archive/                     # 历史归档（已完成的 plans / 历史 specs / 验证记录 / 设计原型）
    ├── architecture/            # v0.1/v0.2/v0.3 架构文档 + Gate-2 决策记录
    ├── design/                  # 9 屏原型 + Chat-First 原型
    ├── design-audit/            # 设计保真审计
    ├── plans/                   # 已完成的 plans
    ├── specs/                   # 历史 specs
    └── verification/            # Gate-1/2、M0/M1/M2/M6.7 验证证据
CLAUDE.md                        # Claude Code 工作指南（保持与代码同步）
infra/README.md                  # 本地基础设施（Postgres/Redis/MinIO/Langfuse）
```

> 注：原 `INTERACTION-FLOW.md`（9 屏设计交互流程）已删除，被 `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` 的 Chat-First 双维度模型取代。

**Naming convention**: `YYYY-MM-DD-<topic>-<kind>.md` (date-prefixed, kind = `design`/`analysis`/`implementation`/`compat`/`readiness`).

**Rule**: 历史 spec/plan 不修改内容（它们是当时决策的快照）；当前状态以 `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` 顶部「实现状态总览」表为准。新工作产出新 spec/plan，不修改旧的。

## Workflow Patterns

### The brainstorm → spec → plan → issue pipeline

This repo follows a strict 4-stage pipeline (powered by superpowers skills). **Every new feature goes through all 4:**

1. **Brainstorm** (`superpowers:brainstorming`): one-question-at-a-time dialogue → produces a design spec saved to `docs/superpowers/specs/`. Includes: decision snapshot table, Gate definitions, trade-off analysis.
2. **Plan** (`superpowers:writing-plans`): expands spec into TDD task list saved to `docs/superpowers/plans/`. Each task has: files / failing test / implementation / commit.
3. **Issues**: plan tasks become trackable issues (currently in multica, project `f34a5b20`).
4. **Execute** (`superpowers:subagent-driven-development` or `executing-plans`): one task at a time, TDD, frequent commits.

**Rule**: Don't write code before a spec+plan exist for it. Don't skip stages. If asked to "just implement X", first check whether a spec/plan exists; if not, propose brainstorming.

### Decision + Gate pattern

Architecture decisions are recorded as **numbered decision tables** (`D1`, `D2`, …) in the spec, not scattered in prose. Each decision has: 决策点 / 锁定值 / 依据.

High-risk technical unknowns are recorded as **Gates** — explicit go/no-go checkpoints with:
- A spike scope (time-boxed)
- Pass criteria (checkable)
- A failure path (what happens if it fails — does it change architecture, or just delay?)

Historical Gates (both resolved):
- **Gate-1** (M2.4): dispatch↔daemon↔claude e2e 跑通 3 次 — ✅ 通过
- **Gate-2** (M0.9): Flow State 真实位置定位 — ✅ 通过，结论：Flow State 后端化在 `packages/workflow/` 引擎中实现，无需外置 Redis

**Rule**: When making a significant decision, add it to the decision table in the spec (don't leave it only in chat). When hitting a risky unknown, frame it as a Gate, not a TODO.

## Testing Patterns

- **TDD strictly**: write failing test → run (red) → minimal impl → run (green) → commit. Every task.
- **Vitest** for TS packages (contracts/shared/db/agent-adapters/daemon/repro/workflow/gateway/scheduler).
- **Type tests** (`expectTypeOf`) for pure-type packages like `contracts`.
- **Playwright E2E** in `apps/console/tests/e2e/`：36+ active tests 覆盖 Chat-First 用户旅程（UC-CHAT / UC-TRG / UC-DAE / UC-WF 系列）。
- **Full-chain trace E2E** in `packages/e2e/`：boots real Hono apps + stub LLM provider + real `runDaemon` + fake claude backend，验证 W3C traceparent + business run_id 跨进程透传。
- Test file location: `src/__tests__/` 或 `*.test.ts` co-located。

## Architecture Conventions

Locked decisions (from `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md` + 历史决策表):

- **Monorepo**: pnpm workspace + turbo. Apps in `apps/*`, packages in `packages/*`, vendored canvas in `vendor/agentflow/`.
- **All TypeScript/Node** (D6) — no Go/Python in self-built layers.
- **Web framework**: Hono for gateway.
- **Process architecture** (3 进程): console (:3000) / gateway (:8080, 含原 dispatch + scheduler 路由) / daemon. dispatch 服务已于 2026-08-01 (Plan A) 并入 gateway（原 :8081 端口废弃）；scheduler 服务随后也并入 gateway（原 :8082 端口 + Redis 依赖废弃）。
- **ORM**: TypeORM (D8) — 单一 migration 系统，与 Flowise 时代已完全脱钩（`flows` 表替代 `chatflows`）。
- **Workflow engine**: `@dagents/workflow`（in-repo，Plan A/B/C 完成），14 节点 + DAG 执行器 + SSE 流式 + 变量解析。Canvas 编辑器在 `vendor/agentflow/`（纯前端 React Flow 组件，从 Flowise Agentflow 抽取，无后端服务依赖）。
- **Chat-First UX** (B 范式共存): chat home (`/`) + chat detail (`/chats/{id}`) + agents / flows / daemons / settings / directories。已废弃路由：`/workspace` `/lab` `/tasks` `/dashboard` `/launcher` `/new-task`。
- **Daemons**: 升级为一级模块（`/daemons`），任务队列 + 执行时间线 + 统计面板。
- **Tasks 数据模型**: 双维度模型 — `directories`（项目目录）→ `chats`（对话）。Tasks 列表第一维按项目目录分组，第二维按对话分组。
- **Heterogeneous agents**: self-built daemon two-tier (central dispatch inlined in gateway + local daemon), translating multica's protocol to TS, **not** importing multica source (D12, modified Apache 2.0).
- **LLM Provider**: 用户自定义配置（已移除 new-api 依赖，gateway 直接代理转发到用户配置的 LLM Provider）。
- **Trace**: Langfuse v2 (pinned, v3 需 ClickHouse) + OTel，`run_id` 跨层透传。

**Rule**: Before proposing a different framework/ORM/approach, check the decision table — the decision is likely already locked with a rationale. Reopening it needs a new Gate or explicit user override.

## External References

- **multica** (`~/Projects/multica`): Go reference for daemon protocol. Read `server/pkg/agent/agent.go` (Backend interface), `server/internal/daemon/client.go` (claim/start/complete protocol), `server/pkg/agent/claude.go` (spawn + stream-json). License: modified Apache 2.0 — reference OK, no source import, no SaaS.
- **vendor/agentflow** (`vendor/agentflow/`): 从 Flowise `packages/agentflow` 抽取的纯前端 React Flow 画布组件库。Plan C 完成后是仓库内唯一的 Flowise 衍生代码。原 Flowise 仓库（`~/Projects/Flowise`）不再作为参考路径。

## Lessons Learned (from project_memory)

- 服务器端口 53984/61039 被环境回收 — 长驻前台进程模式可避免端口回收问题
- koa-connect 包装 Express 中间件导致 ctx.state 丢失 — 必须用原生 Koa 中间件
- Next.js SWC 在编辑期间可能缓存中间版本 — `touch` 触发重编译可修复 'Unexpected eof'
- 替换 Flowise 原生节点组件导致 MUI CardWrapper 样式与功能丢失（toolbar / model config / status indicators）
- macOS 默认 ulimit -n 不足以支撑 12 packages 的 turbo dev — 启动前 `ulimit -n 65536` 防 EMFILE
- Agentflow 节点必须使用三段式视觉结构（category 色带 + icon+title header + status bar）
- Platform Agent 节点必须实现完整工具调用循环（LLM call → tool execution → result 回填 → 迭代）
- Condition 节点输出 anchor 必须用 'name'（如 'true'/'false'）作为 handle id 匹配 edge sourceHandle
- API 请求 content 字段含 null byte 必须 400 拒绝；path 参数含 '..' 必须拒绝防 path traversal
- Agent 删除前必须检查 flow 节点引用，命中返回 409 + 引用清单
- 代理路由必须透传上游 4xx 状态码，不要转换为 502
