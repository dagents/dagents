# Dagents 平台

Chat-First 的异构 coding agent 平台。**中央调度（gateway）+ 本地 daemon** 两层架构，统一编排 claude / codex 等 CLI agent；工作流引擎内聚在 `@dagents/workflow`，画布编辑器使用 vendored `agentflow`。

## ⚠️ 安全须知 — 部署前必读

> **默认配置下，gateway 绑定 `127.0.0.1`（仅本机访问）。**
> 如果你计划将 gateway 暴露到网络（反代、k8s Service、Cloudflare Tunnel 等），**必须**配置以下环境变量之一：

### 方案 A：API Key 鉴权（最简单）
```bash
# 生成一个强随机 key（≥16 字符）
GATEWAY_API_KEY=$(openssl rand -hex 32)
```
设置后，所有非公开 API 路由需要 `Authorization: Bearer <key>` 头。
Daemon 注册需要额外的 `DAEMON_REGISTER_TOKEN`。

### 方案 B：SSO 会话鉴权（浏览器 + Console）
```bash
SSO_DEV_USERNAME=admin
SSO_DEV_PASSWORD=<strong-password>
SSO_SESSION_SECRET=$(openssl rand -base64 48)  # ≥32 bytes
REQUIRE_LOGIN=1
```

### 必须配置的安全变量
| 变量 | 用途 | 生成方式 |
|---|---|---|
| `GATEWAY_API_KEY` | API 路由鉴权 | `openssl rand -hex 32` |
| `DAEMON_REGISTER_TOKEN` | Daemon 注册令牌 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | LLM API Key 加密（AES-256-GCM） | `openssl rand -hex 32` |
| `SSO_SESSION_SECRET` | SSO 会话签名 | `openssl rand -base64 48` |

**不设 `ENCRYPTION_KEY` 时，LLM API Key 以 Base64 存储（可逆，不安全），gateway 会打印警告。**

## 架构

```
console (Next) → gateway (Hono) → @dagents/workflow → dispatch 路由（已并入 gateway）
                                              → 本地 daemon → claude/codex CLI → LLM Provider
```

- **gateway** (`apps/gateway`, :8080) — Hono。SSO、路由/审计、工作流执行入口（`/api/v1/workflows/*`）、dispatch 协议路由、LLM Provider CRUD + 动态代理转发。
- **console** (`apps/console`, :3000) — Next.js App Router。Chat-First：`/` 首页 + `/chats/{id}` 详情 + agents / flows / daemons / settings / directories；画布编辑在 `/workflows/[id]/canvas`。**所有后端调用都经 gateway**。
- **daemon** (`packages/daemon`) — pull-based：`register → heartbeat → claim → execute → complete`。
- **CLI 第一性（2026-08-18）** — 本地 CLI agent 是基线执行引擎，HTTP LLM Provider 只是可选加速：`@workflow` 生成默认走 CLI spawn，工作流 LLM/Agent 节点未配置 provider 时用 CLI 兜底，零配置可跑。
- **模板生态（2026-08-20）** — 三层资产一键成军：**Agent 人格库**（挂载 [agency-agents](https://github.com/msitarzewski/agency-agents) 类人格库，270+ 专家人格按需启用，`docs/agent-library.md`）· **流程模板中心**（内置模板开箱即用、画布跑通的流程一键「另存为模板」，personaName 重绑 + 未挂库自动降级 LLM 节点，`docs/flow-templates.md`）· Agent 模板。

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

文档地图见 **`docs/README.md`**。核心入口：

- **CLAUDE.md** — Claude Code 工作指南（架构分层、关键契约、命令、约定）。
- **架构真相源** — `docs/superpowers/specs/2026-07-25-system-architecture-redesign.md`（顶部「实现状态总览」表反映当前进度）。
- **主题文档** — 工作流引擎 `docs/workflow-engine.md` · 技能库 `docs/skills-registry.md` · Agent 人格库 `docs/agent-library.md` · 流程模板中心 `docs/flow-templates.md` · 测试用例 `docs/test-cases.md` · e2e 测试计划 `docs/e2e-test-plan.md`。
- **活跃 plans** — `docs/superpowers/plans/`；历史决策 / 验证记录 / 测试报告 / 设计原型归档在 `docs/archive/`。
- **新功能流程** — brainstorm → spec → plan → issue → execute（见 CLAUDE.md）。
- **CI** — `.github/workflows/ci.yml`（push/PR 跑 build • typecheck • test，含 Postgres service + migration）。
