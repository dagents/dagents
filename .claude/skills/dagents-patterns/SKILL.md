---
name: dagents-patterns
description: Conventions and workflow patterns for the dagents repo (Dagents 平台 MVP). Use when working in this repo — committing, adding docs/specs/plans, or making architecture decisions.
version: 1.0.0
source: local-git-analysis
analyzed_commits: 8
last_updated: 2026-07-08
---

# dagents Repo Patterns

> Extracted from git history + repo docs. The repo is pre-code (8 commits, all docs/design), so these patterns describe **how this project plans and records work**, not code structure (which lives in `docs/superpowers/plans/`).

## Commit Conventions

This project uses **conventional commits with Chinese descriptions**:

```
<type>: <中文描述>
```

- **Types in use**: `docs` (dominant — spec/plan writing), `feat` (design assets), `chore` (infra/skeleton, planned)
- **Message language**: Chinese (简体中文). Multi-clause messages use `(` `)` and Chinese punctuation `、` `，`.
- **No body/footer** so far; messages are single-line, often with parenthetical detail.
- **No attribution trailer** (attribution disabled globally per user rules).

Examples from history:
- `docs: MVP 实现计划 (M0-M6 全量, 46 任务/120 步骤)`
- `docs: 纳入原型功能 (A1 完整控制台 + B1 new-api + C1 Lab/Workspace)`
- `docs: 锁定 D8 为 TypeORM (自研表与 Flowise 同库同 ORM)`
- `feat: design`

**Rule**: When committing in this repo, match the type + Chinese description style. Don't switch to English mid-project.

## Documentation Architecture

```
docs/
├── architecture-v0.2.md          # 上游架构设计 (v0.2, 基于 Flowise 重构)
├── architecture.md               # v0.1 (保留供对照评审)
└── superpowers/
    ├── specs/                    # brainstorming 产出的设计稿
    │   ├── 2026-07-08-mvp-execution-plan-design.md   # 主 spec (决策表+Gate+轨道+时序)
    │   └── 2026-07-08-prototype-coverage-analysis.md # 原型覆盖分析
    └── plans/                    # writing-plans 产出的可执行 TDD 计划
        └── 2026-07-08-mvp-implementation.md          # M0-M6 全量任务
design/                           # 原型 (open-design 产出, 7 页 + 数据文件)
infra/                            # docker-compose 等 (规划中, M0 落地)
```

**Naming convention**: `YYYY-MM-DD-<topic>-<kind>.md` (date-prefixed, kind = `design`/`analysis`/`implementation`).

## Workflow Patterns

### The brainstorm → spec → plan → issue pipeline

This repo follows a strict 4-stage pipeline (powered by superpowers skills). **Every new feature goes through all 4:**

1. **Brainstorm** (`superpowers:brainstorming`): one-question-at-a-time dialogue → produces a design spec saved to `docs/superpowers/specs/`. Includes: decision snapshot table, Gate definitions, trade-off analysis.
2. **Plan** (`superpowers:writing-plans`): expands spec into TDD task list saved to `docs/superpowers/plans/`. Each task has: files / failing test / implementation / commit.
3. **Issues**: plan tasks become trackable issues (currently in multica, project `f34a5b20`).
4. **Execute** (`superpowers:subagent-driven-development` or `executing-plans`): one task at a time, TDD, frequent commits.

**Rule**: Don't write code before a spec+plan exist for it. Don't skip stages. If asked to "just implement X", first check whether a spec/plan exists; if not, propose brainstorming.

### Decision + Gate pattern (from the spec)

Architecture decisions are recorded as **numbered decision tables** (`D1`, `D2`, …) in the spec, not scattered in prose. Each decision has: 决策点 / 锁定值 / 依据.

High-risk technical unknowns are recorded as **Gates** — explicit go/no-go checkpoints with:
- A spike scope (time-boxed, e.g. "2 days")
- Pass criteria (checkable)
- A failure path (what happens if it fails — does it change architecture, or just delay?)

Current Gates:
- **Gate-1** (M2.4): dispatch↔daemon↔claude e2e 跑通 3 次. Fails → M2 翻倍.
- **Gate-2** (M0.9): Flow State 真实位置定位. Fails → 触发 D1 重评.

**Rule**: When making a significant decision, add it to the decision table in the spec (don't leave it only in chat). When hitting a risky unknown, frame it as a Gate, not a TODO.

## Testing Patterns (planned, not yet in code)

From the spec/plan, the project will use:
- **TDD strictly**: write failing test → run (red) → minimal impl → run (green) → commit. Every task.
- **Vitest** for TS packages (contracts/shared/db/agent-adapters/daemon/repro).
- **Type tests** (`expectTypeOf`) for pure-type packages like `contracts`.
- **Coverage target**: 80%+ (per user global rules).
- Test file location: `src/__tests__/` or `*.test.ts` co-located.

## Architecture Conventions (planned)

Locked decisions (from spec §0.1 decision table):

- **Monorepo**: pnpm workspace + turbo. Apps in `apps/*`, packages in `packages/*`, forked Flowise in `vendor/flowise/`.
- **All TypeScript/Node** (D6) — no Go/Python in self-built layers.
- **Web framework**: Hono for gateway/dispatch.
- **ORM**: TypeORM (D8) — shared with Flowise, single migration system, same DB.
- **Flowise**: full fork at `vendor/flowise/`, modify source directly, no trimming (D1/D15).
- **Heterogeneous agents**: self-built daemon two-tier (central dispatch + local daemon), translating multica's protocol to TS, **not** importing multica source (D12, modified Apache 2.0).
- **LLM gateway**: new-api (local `~/Projects/new-api`), tokens managed by new-api, platform stores only metadata.
- **Trace**: Langfuse + OTel, `run_id` threaded through every layer.

**Rule**: Before proposing a different framework/ORM/approach, check the decision table — the decision is likely already locked with a rationale. Reopening it needs a new Gate or explicit user override.

## External References

- **multica** (`~/Projects/multica`): Go reference for daemon protocol. Read `server/pkg/agent/agent.go` (Backend interface), `server/internal/daemon/client.go` (claim/start/complete protocol), `server/pkg/agent/claude.go` (spawn + stream-json). License: modified Apache 2.0 — reference OK, no source import, no SaaS.
- **Flowise** (`~/Projects/Flowise`): the fork source. 3.1.3, pnpm+turbo monorepo. `packages/server` (execution + Prediction API), `packages/agentflow` (React canvas component, NOT the execution engine).
- **new-api** (`~/Projects/new-api`): Go LLM gateway, docker port 3000.

## Key Insight: "Flow State 后端化" is unverified

The v0.2 architecture doc claims "Agentflow V2 is a born-backend state machine engine" and "Flow State defaults to in-process, needs Redis externalization". **Gate-2 (M0.9) exists because勘察 found this might be wrong** — `flowState` grep in `packages/server/src` returns zero hits; state appears to live in the agentflow React reducer, not the server.

**Rule**: Don't build plans assuming "外置 Flow State to Redis" until Gate-2 resolves. The plan marks M3.3 (the Redis externalization task) as dependent on Gate-2's conclusion.
