<div align="center">

# Dagents 平台

**Chat-First 的异构 coding agent 编排平台 —— 跑在你自己的机器上，对接你自己的 LLM Provider。**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)

在一个聊天界面里调度 `claude`、`codex` 等 17 种 CLI agent · 编排成可视化工作流 · 零配置起步，数据全部留在本地。

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

## 为什么是 Dagents

多数 agent 平台想自己做后端，Dagents 相反：**本地 CLI agent 就是基线执行引擎**，其他一切都是可选加速。

- **CLI 第一性** —— 聊天与工作流默认 spawn 本地 CLI agent（claude / codex / gemini / qwen / …，17 种适配器）；HTTP LLM Provider 是可选快路径而非依赖。没配 provider？照样跑。
- **Chat-First UX** —— 聊天主页 `/` + 聊天详情 `/chats/{id}`。输入 `@workflow …` 从一句话编译多 Agent 工作流；按名字 @ agent，带着人格与技能派活。
- **可视化工作流画布** —— 14 节点 DAG 引擎：并行波次、条件路由、循环、人机协同、SSE 流式，画布编辑在 `/workflows/[id]/canvas`（React Flow）。
- **Agent 人格库** —— 文件系统挂载任意 [agency-agents](https://github.com/msitarzewski/agency-agents) 类人格库（270+ 专家人格），按需启用、drift 三态同步上游；库里只装「已启用」的，天然不爆。
- **流程模板中心** —— 内置模板 / 团队场景模板 / 画布「另存为模板」三层收拢；实例化按 personaName 重绑人格，缺的自动降级 LLM 节点，模板永远可跑。
- **本地优先、隐私为王** —— Postgres 在本机，无遥测、无账号、不回传。LLM API Key 落库加密（AES-256-GCM）。
- **中英双语界面** —— 侧栏一键切换。

## 架构

```
console (Next.js :3000) → gateway (Hono :8080) → @dagents/workflow 引擎
                                              → [dispatch 路由已并入 gateway] → 本地 daemon → CLI agent
```

| 组成 | 位置 | 说明 |
|---|---|---|
| Console | `apps/console` | Next.js App Router，所有后端调用经 gateway |
| Gateway | `apps/gateway` | Hono：SSO/认证、工作流 CRUD 与执行、dispatch 协议、LLM Provider CRUD + 动态代理 |
| 工作流引擎 | `packages/workflow` | 14 节点、DAG 执行器、SSE 流式、变量解析 |
| CLI 适配器 | `packages/agent-adapters` | claude / codex / qwen / copilot / opencode / codebuddy / cursor / deveco / antigravity / openclaw / pi / hermes / kimi / kiro / grok / qoder / traecli |
| Daemon | `packages/daemon` | pull-based（register → heartbeat → claim → execute），remote 执行用；inline 是默认执行路径 |
| 画布 | `vendor/agentflow` | vendored 自 [Flowise](https://github.com/FlowiseAI/Flowise)（Apache-2.0），纯前端 |

依赖方向无环：`contracts ← {agent-adapters, daemon, db} ← gateway`；`workflow ← gateway`。

## 跑起来

### Docker 全栈

```bash
git clone https://github.com/dagents/dagents.git
cd dagents
docker compose up        # Postgres + gateway + console
```

打开 http://localhost:3000 —— 迁移在启动时自动执行；所有端口只绑定
`127.0.0.1`。compose 中 `image: ghcr.io/dagents/dagents:latest` 与 `build: .`
并存：先 `docker compose pull dagents` 拉取预构建多架构镜像，`up` 即跳过本地
构建（否则首次构建需要几分钟）。

### 开发模式

```bash
pnpm install                       # .npmrc 设 ignore-scripts=true（vendored 画布跳过 husky）
cd infra && docker compose up -d   # Postgres :15432 + Langfuse :3001
pnpm --filter @dagents/db migration:run
pnpm --filter @dagents/gateway dev          # :8080
pnpm --filter @dagents/console dev          # :3000
pnpm dev:daemon                             # 可选，remote Agent 才需要
```

前置：Node ≥ 22、pnpm 10（`corepack enable`）、Docker。PATH 上有 `claude`
CLI 时，聊天主页零配置即可用 —— 这就是 CLI 第一性的含义。

| 服务 | 端口 | 说明 |
|---|---|---|
| Gateway | 8080 | 默认绑定 `127.0.0.1` |
| Console | 3000 | |
| Postgres | host **15432** → 5432 | 重映射避免端口冲突 |
| Langfuse | 3001 | 可选观测 profile |

## ⚠️ 安全须知 —— 对外暴露前必读

默认一切只监听本机。若计划把 gateway 挂到反代或网络上，先配好认证：

| 变量 | 用途 | 生成方式 |
|---|---|---|
| `GATEWAY_API_KEY` | API 路由鉴权 | `openssl rand -hex 32` |
| `DAEMON_REGISTER_TOKEN` | Daemon 注册令牌 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | LLM API Key 加密（AES-256-GCM） | `openssl rand -hex 32` |
| `SSO_SESSION_SECRET` | SSO 会话签名 | `openssl rand -base64 48` |

不设 `ENCRYPTION_KEY` 时，LLM API Key 以 Base64 存储（可逆、不安全），
gateway 会打印警告。完整说明与 SSO 方案见文档。

## 已知限制（诚实清单）

我们宁可先说清楚：

- **JS 节点非沙箱** —— `CustomFunction` / 工具 / 循环条件走 `new Function`。flow 的信任对象是机器所有者；不要把 flow 编排开放给不受信任的用户。
- **LLM 请求无超时/取消** —— 上游 provider 挂起会挂住整个 run（HTTP 节点已有 15s 超时 + 32KB 截断）。
- **普通 `LLM` 节点是单次调用** —— 需要工具循环请用 `PlatformAgent` 节点。
- **Retriever 是关键词检索**（chat 历史 ILIKE），不是向量 RAG —— 节点契约已为向量后端替换预留。
- **HumanInput 挂起态在内存** —— gateway 重启会丢挂起中的输入（流随超时失败）。
- 部分 CLI 适配器（codex / codebuddy / copilot / qwen）按官方文档格式实现，未经真实 CLI 回归。

完整取舍清单与升级路径：`docs/workflow-engine.md` § 现状与限制。

## 文档

文档地图见 [`docs/README.md`](./docs/README.md)。核心入口：

- [`docs/workflow-engine.md`](./docs/workflow-engine.md) —— 引擎架构 / 执行模型 / Langfuse 开启方式
- [`docs/skills-registry.md`](./docs/skills-registry.md) —— 技能发现与 system prompt 注入
- [`docs/agent-library.md`](./docs/agent-library.md) —— 人格库挂载 / drift 同步 / 团队场景模板
- [`docs/flow-templates.md`](./docs/flow-templates.md) —— 三层模板中心
- [`docs/e2e-test-plan.md`](./docs/e2e-test-plan.md) —— 执行态 e2e 与 Mock LLM 测试地基
- [`CLAUDE.md`](./CLAUDE.md) · [`AGENTS.md`](./AGENTS.md) —— AI coding agent（和人类）的工作约定

## 贡献

欢迎 PR —— 环境搭建、测试与约定见
[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)（英文版
[CONTRIBUTING.md](./CONTRIBUTING.md)）。参与即表示同意
[行为准则](./CODE_OF_CONDUCT.md)。安全报告走 [SECURITY.md](./SECURITY.md)
—— 私密披露，7 个工作日内响应。

## 许可

Apache-2.0 —— 见 [LICENSE](./LICENSE)。

`vendor/agentflow/` 中的画布组件 vendored 自
[FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) 的
`packages/agentflow`（Apache-2.0），归属说明见 `vendor/agentflow/NOTICE`。
