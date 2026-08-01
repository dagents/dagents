# 架构简化：dispatch 并入 gateway（方案 A）

> **日期**: 2026-08-01
> **状态**: Active（待评审）
> **基于**: 用户架构简化诉求 + `2026-07-25-system-architecture-redesign.md` §6 服务层职责
> **决策模式**: 风险驱动（机械搬迁优先，SSO 边界单独 Gate）
> **关联 Plan**: `docs/superpowers/plans/2026-08-01-dispatch-merge-into-gateway.md`

## 实现状态总览

| 章节 | 内容 | 状态 |
|------|------|------|
| §2 | 路由迁移（20 路由 × 6 文件） | ⏳ Plan 阶段 |
| §3 | SSO 公开路径白名单 + daemon 鉴权策略 | ⏳ Plan 阶段 |
| §4 | gateway 内部 fetch 改本地调用 | ⏳ Plan 阶段 |
| §5 | dispatch 包删除 + 配置清理 | ⏳ Plan 阶段 |
| §6 | daemon + dev 脚本 + 文档同步 | ⏳ Plan 阶段 |

---

## 1. 背景与目标

### 1.1 现状

项目当前 5 个进程：console (3000) / gateway (8080) / dispatch (8081) / scheduler (8082) / daemon。trial-readiness 阶段评估认为中间 3 个 Hono 服务对单机 trial 是过度工程：

- **dispatch** 仅 1680 行，全是 Hono 路由，无独立业务逻辑
- **gateway** 已经在 `/api/v1/dispatch/*` 上做 blind proxy（[app.ts:191-254](file:///Users/rowan/Projects/mil-agents-main/apps/gateway/src/app.ts#L191)），并已在 `chats.ts` / `chat-execute.ts` 内部用 `fetch(DISPATCH_URL)` 调用 dispatch
- 三个服务共用同一 PG + 同一 Redis，无独立 schema
- 跨服务 fetch 增加延迟 + 一套多余的健康检查 + DISPATCH_URL 配置面

### 1.2 目标

- 把 `apps/dispatch/` 的 20 个路由（6 个文件）整体迁入 `apps/gateway/src/routes/dispatch/`
- 删除 `apps/dispatch/` 包、`DISPATCH_URL` / `DISPATCH_PORT` 环境变量、gateway 的 `/api/v1/dispatch/*` 代理路由
- daemon 连接地址从 `:8081` 改为 `:8080`（gateway 端口）
- gateway 内部对 dispatch 的 `fetch()` 调用改为直接调用 Hono 路由处理函数或共享 service 函数

### 1.3 非目标

- **不合并 scheduler**（方案 B/C）：scheduler 的 HTTP 面先保留代理形态，worker 进程保留独立。本期只动 dispatch。
- **不改 daemon 协议**：`/api/v1/dispatch/*` 路径形状不变，daemon 代码只改默认端口。
- **不改 dispatch 的数据库表结构**：`dispatch_tasks` / `agent_daemons` 表保持原样。
- **不引入内部 token 鉴权**：daemon 路径用 SSO 白名单 + 网络隔离，不新增 `x-internal-token` 机制（已有 internal-runs 用过，但 daemon 路径量大，先用白名单简化）。

### 1.4 验收 Gate

**Gate-Merge-1（合并完成）**：
1. `pnpm --filter @dagents/gateway dev` 单进程启动后，daemon 用 `http://localhost:8080` 注册成功、心跳正常、claim/complete 闭环
2. `@daemon` chat trigger e2e（UC-TRG-04）仍 active
3. `apps/dispatch/` 目录从仓库删除，`@dagents/dispatch` 不再出现在 `pnpm-workspace.yaml`、`turbo.json`、`.env.example`、`scripts/dev.sh`、`CLAUDE.md`
4. `DISPATCH_URL` / `DISPATCH_PORT` 环境变量从所有非归档文件移除
5. `pnpm typecheck` + `pnpm test` 全绿（dispatch 原 4 个测试文件迁移到 gateway 后通过）

---

## 2. 路由迁移清单

### 2.1 dispatch 路由全景（20 个）

| 文件 | 路由 | 方法 | 用途 |
|---|---|---|---|
| daemons.ts | `/daemons/register` | POST | daemon 注册 |
| daemons.ts | `/daemons/heartbeat` | POST | daemon 心跳 |
| daemons.ts | `/daemons` | GET | daemon 列表 |
| daemons.ts | `/daemons/:id` | DELETE | daemon 删除 |
| daemons.ts | `/daemons/:id/tasks/claim` | POST | daemon 拉任务 |
| tasks.ts | `/tasks/:id` | GET | 任务详情 |
| tasks.ts | `/tasks/:id/start` | POST | 任务开始 |
| tasks.ts | `/tasks/:id/progress` | POST | 任务进度 |
| tasks.ts | `/tasks/:id/messages` | POST | 任务消息批量 |
| tasks.ts | `/tasks/:id/complete` | POST | 任务完成 |
| tasks.ts | `/tasks/:id/fail` | POST | 任务失败 |
| tasks.ts | `/tasks/:id/events` | GET | 任务事件流 |
| agents.ts | `/agents` | GET | dispatch agent 列表（snake_case `agent_daemons` join） |
| agents.ts | `/agents` | POST | 创建 agent daemon 关联 |
| agents.ts | `/agents/:id` | GET | 单个 agent daemon |
| agents.ts | `/agents/:id/logs` | GET | agent 日志 |
| invoke.ts | `/invoke` | POST | 入队任务 |
| runs-usage.ts | `/runs/:runId/usage` | GET | run 用量 |
| runs-usage.ts | `/runs/:runId/usage/by-agent` | GET | run 按 agent 用量 |
| fleet-stats.ts | `/fleet-stats` | GET | 机队统计 |

### 2.2 命名冲突说明

dispatch 的 `/agents` 路由（`agent_daemons` 表的 snake_case 形状）与 gateway 已有的 `/api/v1/agents` 路由（platform `agents` 表的 design-aligned 形状）**不同源**。迁移后 dispatch agents 路由仍挂载在 `/api/v1/dispatch/agents`，**不与 `/api/v1/agents` 合并**——前者是 daemon 协议侧的 agent_daemons 关联，后者是平台 agent 目录。

### 2.3 迁移目标结构

```
apps/gateway/src/routes/dispatch/
├── daemons.ts          # 从 apps/dispatch/src/routes/daemons.ts 迁入，路由前缀不变
├── tasks.ts            # 同上
├── agents.ts           # 同上（dispatch 协议侧，不与 gateway 顶层 agents.ts 合并）
├── invoke.ts           # 同上
├── runs-usage.ts       # 同上
├── fleet-stats.ts      # 同上
└── index.ts            # 聚合 + 导出 dispatchRoutes Hono 实例
```

gateway `app.ts` 挂载：
```ts
app.route('/api/v1/dispatch', dispatchRoutes)
```

### 2.4 共享代码迁移

dispatch `app.ts` 中的 `ok` / `fail` envelope helpers 与 gateway 重复——迁移后**删除 dispatch 版本**，复用 gateway 已有的 envelope（如有）或抽到 `apps/gateway/src/routes/dispatch/index.ts` 内部。

---

## 3. SSO 公开路径白名单 + daemon 鉴权

### 3.1 问题

gateway `app.ts:106-121` 的 SSO 中间件公开路径白名单：
```ts
const isPublic = path === '/health' || path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/llm/')
```

`/api/v1/dispatch/*` **不在白名单**。当前 dev 模式 `REQUIRE_LOGIN` 未启用所以工作；trial 启用 SSO 后，daemon 的 register/heartbeat/claim 会被 401 拒绝。

### 3.2 决策

把 `/api/v1/dispatch/*` 加入 SSO 公开路径白名单：

```ts
const isPublic =
  path === '/health' ||
  path.startsWith('/api/v1/auth/') ||
  path.startsWith('/api/v1/llm/') ||
  path.startsWith('/api/v1/dispatch/')  // ← 新增：daemon 协议路径，机器对机器，用网络隔离保护
```

### 3.3 安全约束（写入 project_memory）

- daemon 路径**仅靠网络隔离保护**：gateway 必须绑定 `127.0.0.1`（已在 project_memory 约束中），或部署在反向代理后做 IP allowlist
- **生产部署**：在 gateway 前置反向代理，对 `/api/v1/dispatch/*` 做 IP allowlist（仅允许 daemon 机器）
- 不在 dispatch 路径上加 `x-internal-token`：daemon 协议路径多、GET/POST 混合，加 token 改动面大；网络隔离是 trial 阶段的最简解

### 3.4 失败回滚

若 trial 反馈 SSO 白名单暴露面过大，回滚方案：把 `/api/v1/dispatch/daemons/register` 等 daemon 入口路径单独加 `x-internal-token` 校验（参考 `internal-runs.ts` 已有实现）。但这是 Plan B，不在本期。

---

## 4. gateway 内部 fetch 改本地调用

### 4.1 现状

gateway 内部两处通过 `fetch(DISPATCH_URL)` 调用 dispatch：

1. **`apps/gateway/src/routes/chats.ts:462-528`** — `@daemon` chat trigger：
   - `POST ${DISPATCH_URL}/api/v1/dispatch/invoke`
   - `GET ${DISPATCH_URL}/api/v1/dispatch/tasks/${taskId}` （轮询状态）
   - `GET ${DISPATCH_URL}/api/v1/dispatch/tasks/${taskId}/events?after=${lastSeq}` （拉事件）

2. **`apps/gateway/src/routes/chat-execute.ts:575`** — `routeCommand` 内 `@daemon` 分支：
   - `POST ${DISPATCH_URL}/api/v1/dispatch/invoke`

### 4.2 决策

迁移后改为**直接调用 Hono 路由处理函数**或抽 service 函数。两种方案：

**方案 4.2a（推荐）：抽 service 函数**

把 dispatch 路由的 SQL 逻辑抽成纯函数，路由层只做 HTTP 解析 + 调用 service。例如：

```ts
// apps/gateway/src/routes/dispatch/invoke-service.ts
export async function enqueueTask(input: { agentDaemonId: string; runId: string; prompt: string; execOptions: unknown }): Promise<{ taskId: string }>
```

gateway 内部调用：`await enqueueTask({...})`，不走 HTTP。

**方案 4.2b：内网 fetch**

保留 `fetch('http://localhost:8080/api/v1/dispatch/invoke')`（gateway 自己 dial 自己）。简单但有开销，且测试要起真实 server。

**选 4.2a**：service 函数化是更干净的工程实践，测试直接调函数。代价是 dispatch 路由要重构一遍抽 service——但 dispatch 路由都很短（10-30 行），机械工作。

### 4.3 影响范围

- `chats.ts:462-528` — 3 处 fetch 改 service 调用
- `chat-execute.ts:575` — 1 处 fetch 改 service 调用
- `__tests__/dispatch.test.ts` — gateway 已有的 dispatch 代理测试，合并后改为直接测 service 函数

---

## 5. dispatch 包删除 + 配置清理

### 5.1 删除清单

| 路径 | 操作 |
|---|---|
| `apps/dispatch/` | 整目录删除 |
| `pnpm-workspace.yaml` | 无需改（apps/* 通配） |
| `turbo.json` `globalEnv` | 删除 `DISPATCH_URL`、`DISPATCH_PORT` |
| `.env.example` | 删除 `DISPATCH_URL`、`DISPATCH_PORT` 两行 |
| `scripts/dev.sh:75` | `DISPATCH_URL` 默认值改为 `http://localhost:8080`（gateway 端口），或删除该行（daemon 直接传 8080） |
| `CLAUDE.md` | 删除 dispatch 端口行、`pnpm --filter @dagents/dispatch dev` 命令、Layered flow 图中的 dispatch hop |
| `apps/gateway/src/app.ts:24-26, 178-254` | 删除 `dispatchUrl()` 函数 + 整个 `/api/v1/dispatch/*` 代理路由 |
| `apps/gateway/src/__tests__/dispatch.test.ts` | 删除（代理测试无意义了），替换为 dispatch service 函数测试 |

### 5.2 保留清单

- `packages/contracts/src/protocol.ts` — dispatch↔daemon DTO 类型，不变
- `packages/daemon/src/client.ts` — `/api/v1/dispatch/*` 路径不变，只改默认端口
- `docs/archive/**` — 历史文档不动
- `docs/superpowers/specs/2026-07-28-trial-readiness.md:100` — 已归档决策快照，不改

---

## 6. daemon + dev 脚本 + 文档同步

### 6.1 daemon 改动

| 文件 | 改动 |
|---|---|
| `packages/daemon/src/cli.ts:37,42` | 帮助文本默认 URL `http://localhost:8081` → `http://localhost:8080` |
| `packages/daemon/src/cli.test.ts:31,35,52` | 测试断言默认 URL 改 8080 |
| `packages/daemon/src/client.ts:52` | 注释默认 URL 改 8080 |
| `packages/daemon/src/main.ts:41` | 注释默认 URL 改 8080 |
| `CLAUDE.md:34` | `pnpm --filter @dagents/daemon dev -- http://localhost:8081 ...` → `:8080` |

### 6.2 dev 脚本

`scripts/dev.sh:75`：
```bash
# 旧
export DISPATCH_URL="${DISPATCH_URL:-http://localhost:8081}"
# 新（删除该行，daemon 直接传 gateway URL）
export DISPATCH_URL="${DISPATCH_URL:-http://localhost:8080}"
```

实际上 `scripts/dev.sh` 的 `--with-daemon` 分支启动 daemon 时传的是 `$DISPATCH_URL`，合并后这个变量名语义不符（不再是 dispatch 服务，是 gateway）。**决策**：保留 `DISPATCH_URL` 变量名作为 daemon 连接地址的别名，默认值改 8080——避免改所有 dev 脚本和文档里的变量名。

### 6.3 文档同步

- `CLAUDE.md` — 删除 dispatch 端口表行、dev 命令行、Layered flow 图里的 dispatch hop、依赖图里的 dispatch
- `.claude/skills/dagents-patterns/SKILL.md` — 架构约定章节更新
- `infra/README.md` — 无需改（不含 dispatch）

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| SSO 白名单暴露 dispatch 路径 | gateway 绑 127.0.0.1（已有约束）；trial 阶段单机部署够用；生产前置反向代理 |
| dispatch 测试迁移后断言失败 | 4 个测试文件机械迁移，路由路径不变，断言不改 |
| daemon 已注册的 `agent_daemons` 行失效 | 不影响——表结构和路径不变，daemon 重启后重新注册即可 |
| gateway 启动时间增加 | dispatch 仅 1680 行路由，启动时间增量可忽略 |
| `@daemon` chat trigger e2e 断裂 | UC-TRG-04 在 plan 的 Phase 4 单独验证 |

---

## 8. 决策快照

| 决策点 | 锁定值 | 依据 |
|---|---|---|
| D1 | dispatch 20 路由全部迁入 gateway | 代码量小、无独立业务逻辑、gateway 已代理 |
| D2 | 路径前缀 `/api/v1/dispatch/*` 不变 | daemon 协议契约不动，减少改动面 |
| D3 | dispatch agents 路由不与 gateway agents 合并 | 不同源（agent_daemons vs agents 表） |
| D4 | SSO 白名单加 `/api/v1/dispatch/*` | 最简解，网络隔离保护 |
| D5 | gateway 内部 fetch 改 service 函数调用 | 工程实践干净，测试友好 |
| D6 | 保留 `DISPATCH_URL` 环境变量名 | 别名语义，避免改所有 dev 脚本 |
| D7 | 不合并 scheduler | 方案 B 留待 trial 反馈 |
