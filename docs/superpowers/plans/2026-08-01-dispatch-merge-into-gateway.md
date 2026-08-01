# Dispatch Merge Into Gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/dispatch/` 的 20 个路由（6 文件）整体迁入 `apps/gateway/src/routes/dispatch/`，删除 dispatch 包 + 配置，daemon 连接地址改 8080，gateway 内部 fetch 改 service 函数调用。

**Architecture:** 4 个独立 Phase，每个 Phase 自成可测试单元。Phase 1/2 并行（路由迁移 + SSO 白名单），Phase 3 依赖 Phase 1（service 抽取改 gateway 内部调用），Phase 4 依赖全部（清理 + 验证）。所有改动复用现有 schema，无 DB migration。

**Tech Stack:** TypeScript, Hono, TypeORM, PostgreSQL, Vitest, zod

**Spec:** `docs/superpowers/specs/2026-08-01-dispatch-merge-into-gateway.md`

---

## File Structure

| File | 责任 | 操作 |
|------|------|------|
| `apps/gateway/src/routes/dispatch/index.ts` | 聚合 dispatch 路由 | Create |
| `apps/gateway/src/routes/dispatch/daemons.ts` | 从 dispatch 迁入 | Create (from move) |
| `apps/gateway/src/routes/dispatch/tasks.ts` | 同上 | Create (from move) |
| `apps/gateway/src/routes/dispatch/agents.ts` | 同上（dispatch 协议侧） | Create (from move) |
| `apps/gateway/src/routes/dispatch/invoke.ts` | 同上 | Create (from move) |
| `apps/gateway/src/routes/dispatch/runs-usage.ts` | 同上 | Create (from move) |
| `apps/gateway/src/routes/dispatch/fleet-stats.ts` | 同上 | Create (from move) |
| `apps/gateway/src/routes/dispatch/service.ts` | 抽取的 service 函数（enqueueTask 等） | Create |
| `apps/gateway/src/app.ts` | 挂载 dispatch 路由 + 删除代理 + SSO 白名单 | Modify |
| `apps/gateway/src/routes/chats.ts` | `@daemon` trigger fetch 改 service 调用 | Modify |
| `apps/gateway/src/routes/chat-execute.ts` | `@daemon` routeCommand fetch 改 service 调用 | Modify |
| `apps/gateway/src/__tests__/dispatch-merged.test.ts` | 迁移后的 dispatch 路由测试 | Create |
| `apps/gateway/src/__tests__/dispatch.test.ts` | 删除（旧代理测试） | Delete |
| `apps/dispatch/**` | 整目录删除 | Delete |
| `packages/daemon/src/cli.ts` | 默认端口 8081→8080 | Modify |
| `packages/daemon/src/cli.test.ts` | 断言默认端口 | Modify |
| `packages/daemon/src/client.ts` | 注释默认端口 | Modify |
| `packages/daemon/src/main.ts` | 注释默认端口 | Modify |
| `turbo.json` | 删除 DISPATCH_URL/DISPATCH_PORT | Modify |
| `.env.example` | 删除 DISPATCH_URL/DISPATCH_PORT | Modify |
| `scripts/dev.sh` | DISPATCH_URL 默认值改 8080 | Modify |
| `CLAUDE.md` | 端口表 + 命令 + Layered flow + 依赖图 | Modify |
| `.claude/skills/dagents-patterns/SKILL.md` | 架构约定更新 | Modify |

---

## Phase 1: 路由迁移（机械搬迁）

### Task 1.1: 创建 dispatch 路由目录 + 迁移 6 个路由文件

**Files:**
- Create: `apps/gateway/src/routes/dispatch/index.ts`
- Create: `apps/gateway/src/routes/dispatch/daemons.ts` (from `apps/dispatch/src/routes/daemons.ts`)
- Create: `apps/gateway/src/routes/dispatch/tasks.ts` (from `apps/dispatch/src/routes/tasks.ts`)
- Create: `apps/gateway/src/routes/dispatch/agents.ts` (from `apps/dispatch/src/routes/agents.ts`)
- Create: `apps/gateway/src/routes/dispatch/invoke.ts` (from `apps/dispatch/src/routes/invoke.ts`)
- Create: `apps/gateway/src/routes/dispatch/runs-usage.ts` (from `apps/dispatch/src/routes/runs-usage.ts`)
- Create: `apps/gateway/src/routes/dispatch/fleet-stats.ts` (from `apps/dispatch/src/routes/fleet-stats.ts`)

- [ ] **Step 1: 迁移 6 个路由文件**

  逐文件复制 `apps/dispatch/src/routes/*.ts` → `apps/gateway/src/routes/dispatch/*.ts`。改动点：
  - import 路径：`../app.js`（dispatch 的 ok/fail）→ 改为本地定义或从 `./index.js` 导入
  - 删除 dispatch `app.ts` 里 `ok`/`fail` 的导入，每个路由文件内联或从 `./index.js` 复用
  - 路由路径前缀不变（仍是 `/daemons/register`、`/tasks/:id` 等，由 `index.ts` 挂载到 `/api/v1/dispatch`）

- [ ] **Step 2: 创建 `index.ts` 聚合路由**

```typescript
// apps/gateway/src/routes/dispatch/index.ts
import { Hono } from 'hono'
import { daemonsRoutes } from './daemons.js'
import { tasksRoutes } from './tasks.js'
import { agentsRoutes } from './agents.js'
import { invokeRoutes } from './invoke.js'
import { runsUsageRoutes } from './runs-usage.js'
import { fleetStatsRoutes } from './fleet-stats.js'

export const dispatchRoutes = new Hono()

dispatchRoutes.route('/', daemonsRoutes)
dispatchRoutes.route('/', tasksRoutes)
dispatchRoutes.route('/', agentsRoutes)
dispatchRoutes.route('/', invokeRoutes)
dispatchRoutes.route('/', runsUsageRoutes)
dispatchRoutes.route('/', fleetStatsRoutes)
```

  在 `index.ts` 中导出共享的 `ok` / `fail` envelope helpers（从 dispatch `app.ts` 迁入）。

- [ ] **Step 3: 暂不删除 `apps/dispatch/`，先验证迁移无误**

### Task 1.2: gateway app.ts 挂载 dispatch 路由

**Files:**
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 1: 挂载 dispatch 路由**

  在 `app.ts` 中 import `dispatchRoutes` 并挂载。**注意**：要挂在 SSO 中间件**之后**（dispatch 路径需要 SSO 白名单豁免，见 Phase 2），但在 `/api/v1/dispatch/*` 代理路由**之前**——否则代理会拦截。

  实际上合并后代理路由要删除，所以挂载位置就是原代理路由的位置（line 191 附近）。

```typescript
// 删除 app.all('/api/v1/dispatch/*', ...) 代理路由（line 191-254）
// 替换为：
app.route('/api/v1/dispatch', dispatchRoutes)
```

- [ ] **Step 2: 删除 `dispatchUrl()` 函数（line 24-26）**

  合并后不再需要跨服务 URL。

- [ ] **Step 3: typecheck 验证**

```bash
pnpm --filter @dagents/gateway typecheck
```

---

## Phase 2: SSO 白名单 + 安全约束

### Task 2.1: dispatch 路径加入 SSO 公开白名单

**Files:**
- Modify: `apps/gateway/src/app.ts` (SSO 中间件 isPublic 判断)

- [ ] **Step 1: 写失败测试**

```typescript
// apps/gateway/src/__tests__/dispatch-sso.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'

describe('SSO public path: /api/v1/dispatch/*', () => {
  const savedRequire = process.env.REQUIRE_LOGIN
  const savedSecret = process.env.SSO_SESSION_SECRET

  beforeAll(() => {
    process.env.SSO_SESSION_SECRET = 'test-secret'
    process.env.REQUIRE_LOGIN = '1'
  })

  afterAll(() => {
    if (savedRequire === undefined) delete process.env.REQUIRE_LOGIN
    else process.env.REQUIRE_LOGIN = savedRequire
    if (savedSecret === undefined) delete process.env.SSO_SESSION_SECRET
    else process.env.SSO_SESSION_SECRET = savedSecret
  })

  it('allows POST /api/v1/dispatch/daemons/register without session', async () => {
    const res = await app.request('/api/v1/dispatch/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    // 401 means SSO blocked; 422 (validation) means SSO passed and route ran
    expect(res.status).not.toBe(401)
  })
})
```

- [ ] **Step 2: 跑测试确认失败（401）**

```bash
pnpm --filter @dagents/gateway exec vitest run src/__tests__/dispatch-sso.test.ts
```

- [ ] **Step 3: 修改 SSO 白名单**

```typescript
// apps/gateway/src/app.ts line 115
const isPublic =
  path === '/health' ||
  path.startsWith('/api/v1/auth/') ||
  path.startsWith('/api/v1/llm/') ||
  path.startsWith('/api/v1/dispatch/')  // ← 新增
```

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 更新 app.ts 顶部 SSO 中间件的注释，说明 dispatch 路径的鉴权策略**

---

## Phase 3: gateway 内部 fetch 改 service 函数

### Task 3.1: 抽取 dispatch service 函数

**Files:**
- Create: `apps/gateway/src/routes/dispatch/service.ts`

- [ ] **Step 1: 抽取 invoke 逻辑为 service 函数**

  从 `invoke.ts` 路由中抽出 `enqueueTask()` 纯函数：

```typescript
// apps/gateway/src/routes/dispatch/service.ts
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'

export interface EnqueueTaskInput {
  agentDaemonId: string
  runId: string
  prompt: string
  execOptions: unknown
}

export async function enqueueTask(input: EnqueueTaskInput): Promise<{ taskId: string }> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, exec_options, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', NOW())`,
    [id, input.agentDaemonId, input.runId, input.prompt, JSON.stringify(input.execOptions)],
  )
  return { taskId: id }
}
```

- [ ] **Step 2: 抽取 task 状态查询 + 事件查询为 service 函数**

```typescript
export async function getTask(taskId: string): Promise<TaskRow | null>
export async function getTaskEvents(taskId: string, afterSeq: number): Promise<TaskEvent[]>
```

- [ ] **Step 3: `invoke.ts` 路由改为调用 service 函数**

  路由层只做 HTTP 解析 + zod 校验 + 调用 `enqueueTask()`。

### Task 3.2: gateway 内部调用点改 service

**Files:**
- Modify: `apps/gateway/src/routes/chats.ts` (line 462-528)
- Modify: `apps/gateway/src/routes/chat-execute.ts` (line 575)

- [ ] **Step 1: 写失败测试（chats.ts 的 @daemon trigger）**

  已有 `chat-execute.test.ts:283` 断言 `fetchUrl === 'http://localhost:8081/...'`。改为断言 service 函数被调用或 task 被创建。

- [ ] **Step 2: `chats.ts` 3 处 fetch 改 service 调用**

```typescript
// 旧：const res = await fetch(`${DISPATCH_URL()}/api/v1/dispatch/invoke`, {...})
// 新：
import { enqueueTask, getTask, getTaskEvents } from './dispatch/service.js'

const { taskId } = await enqueueTask({ agentDaemonId, runId, prompt, execOptions })
const task = await getTask(taskId)
const events = await getTaskEvents(taskId, lastSeq)
```

- [ ] **Step 3: `chat-execute.ts` 1 处 fetch 改 service 调用**

- [ ] **Step 4: 删除 `DISPATCH_URL` 局部变量定义（chats.ts:462、chat-execute.ts:575）**

- [ ] **Step 5: 跑 gateway 全部测试**

```bash
pnpm --filter @dagents/gateway test
```

---

## Phase 4: 清理 + 验证

### Task 4.1: 迁移 dispatch 测试

**Files:**
- Create: `apps/gateway/src/__tests__/dispatch-merged.test.ts` (from `apps/dispatch/src/__tests__/*.ts`)
- Delete: `apps/gateway/src/__tests__/dispatch.test.ts` (旧代理测试)

- [ ] **Step 1: 迁移 dispatch 的 4 个测试文件**

  `apps/dispatch/src/__tests__/{agents,dispatch,fleet-stats,runs-usage}.test.ts` → 合并到 `apps/gateway/src/__tests__/dispatch-merged.test.ts` 或分文件迁移。

  改动点：
  - import `app` 从 `../../app.js`（dispatch）→ 从 `../../app.js`（gateway）
  - 路径断言不变（仍 `/api/v1/dispatch/...`）

- [ ] **Step 2: 删除旧代理测试 `apps/gateway/src/__tests__/dispatch.test.ts`**

### Task 4.2: 删除 dispatch 包

**Files:**
- Delete: `apps/dispatch/` (整目录)

- [ ] **Step 1: 确认 dispatch 路由在 gateway 完全工作**

```bash
pnpm --filter @dagents/gateway test
pnpm --filter @dagents/gateway typecheck
```

- [ ] **Step 2: 删除 `apps/dispatch/` 整目录**

- [ ] **Step 3: 验证 pnpm-workspace 仍能解析（apps/* 通配，无需改）**

```bash
pnpm install
```

### Task 4.3: 配置清理

**Files:**
- Modify: `turbo.json`
- Modify: `.env.example`
- Modify: `scripts/dev.sh`

- [ ] **Step 1: `turbo.json` 删除 `DISPATCH_URL`、`DISPATCH_PORT`**

  从 `globalEnv` 数组删除这两个条目。

- [ ] **Step 2: `.env.example` 删除 `DISPATCH_URL`、`DISPATCH_PORT` 两行**

- [ ] **Step 3: `scripts/dev.sh:75` 默认值改 8080**

```bash
export DISPATCH_URL="${DISPATCH_URL:-http://localhost:8080}"
```

### Task 4.4: daemon 端口 + 文档同步

**Files:**
- Modify: `packages/daemon/src/cli.ts`
- Modify: `packages/daemon/src/cli.test.ts`
- Modify: `packages/daemon/src/client.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/dagents-patterns/SKILL.md`

- [ ] **Step 1: daemon 默认端口 8081→8080**

  `cli.ts:37,42` 帮助文本、`client.ts:52` 注释、`main.ts:41` 注释。

- [ ] **Step 2: daemon 测试断言改 8080**

  `cli.test.ts:31,35,52` 三处 `http://localhost:8081` → `http://localhost:8080`。

- [ ] **Step 3: 跑 daemon 测试**

```bash
pnpm --filter @dagents/daemon test
```

- [ ] **Step 4: CLAUDE.md 更新**

  - 端口表删除 dispatch 行
  - `pnpm --filter @dagents/dispatch dev` 命令行删除
  - Layered flow 图删除 dispatch hop：`gateway (Hono) → @dagents/workflow → dispatch HTTP node → dispatch server` 改为 `gateway (Hono) → @dagents/workflow → [dispatch routes inline] → local daemon`
  - 依赖图删除 dispatch 行
  - Apps 章节删除 dispatch 条目，gateway 描述增加"含原 dispatch 协议路由（/api/v1/dispatch/*）"

- [ ] **Step 5: dagents-patterns SKILL.md 更新**

  架构约定章节：`apps/*` 列表删除 dispatch，注明 dispatch 已并入 gateway。

### Task 4.5: 全量验证

- [ ] **Step 1: 全量 typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 2: 全量测试**

```bash
pnpm test
```

- [ ] **Step 3: 手动启动验证**

```bash
# 终端 1：infra
cd infra && docker compose up -d

# 终端 2：gateway（含原 dispatch）
pnpm --filter @dagents/gateway dev

# 终端 3：daemon（连 8080）
pnpm --filter @dagents/daemon dev -- http://localhost:8080 dev-laptop claude

# 终端 4：console
pnpm --filter @dagents/console dev
```

  验证：
  - daemon 日志显示注册成功（`POST /api/v1/dispatch/daemons/register` 200）
  - 心跳正常
  - console 触发 `@daemon <cmd>` 后 task 入队、daemon claim、完成回写

- [ ] **Step 4: e2e 验证**

```bash
pnpm --filter @dagents/console exec playwright test tests/e2e/09-chat-trigger.spec.ts
```

  UC-TRG-04（@daemon trigger）应 active。

- [ ] **Step 5: 提交**

```
refactor: dispatch 并入 gateway — 路由迁移 + SSO 白名单 + service 函数化 + 配置清理
```

---

## Phase 间依赖

```
Phase 1 (路由迁移) ─┬─→ Phase 3 (service 抽取) ─┬─→ Phase 4 (清理 + 验证)
Phase 2 (SSO 白名单) ─┘                          ┘
```

Phase 1 和 Phase 2 可并行（不同文件）。Phase 3 依赖 Phase 1（service 抽取自迁移后的路由）。Phase 4 依赖全部。
