# Dagents 架构总览（现状真相源）

> 更新：2026-09-23。本文回答"系统今天长什么样"，决策过程见各专题文档。
> 分层契约与命令以 `AGENTS.md` 为准，本文提供全景与关键链路。

---

## 1. 系统分层

```
console (Next.js App Router, :3000)
   │  /api/* BFF 直转发网关（gateway URL 只在服务端，单源 lib/gateway-proxy）
   │  自研 Canvas Kit 画布（flow-canvas/）+ 悬浮副驾 FloatingChat
   ▼
gateway (Hono, :8080)                    装配一切：路由/执行/持久化
   │  routes/ HTTP 关注点 + repositories/ 表访问单源
   │  @dagents/workflow DagExecutor       DB-free DAG 引擎（executor 已拆解：
   │  span-writer 增量节点进度           波次调度/迭代体/节点运行为显式方法）
   ▼
packages/                                contracts · workflow · agent-adapters · db · shared
   │
   ▼
本地 CLI（claude/codex/qwen/copilot…17 种）· Postgres(:15432) · Langfuse(:3001 可选)
```

- **无登录本机模式**：仅可选 `GATEWAY_API_KEY`（≥16 字符生效）
- **浏览器 Origin 防线（2026-09-17）**：默认模式也校验 Origin —— 同源/环回
  （localhost/127.0.0.1/::1）自动放行，其余需 `GATEWAY_ALLOWED_ORIGINS` 白名单；
  非浏览器客户端（curl/CLI/服务端 fetch）无 Origin 不受影响。WS 握手同款。
- **CLI 第一性**：无 LLM Provider 配置时，LLM/Agent 节点与聊天全部走本地 CLI（零配置基线）；配了 Provider 则走 HTTP 加速
- **IA（2026-09-06 定稿）**：`/` = Flows 工作台（Workflow-First）；聊天入口 = 悬浮副驾 + 侧栏会话树

## 2. 执行链路（画布运行全景）

```
点「▶ 运行」→ 运行输入面板（输入 + 项目目录选择）
   │  POST /workflows/:id/run?async=1   ← 自带 x-run-id，立即返回（64ms 实测）
   ▼
gateway 后台执行 DagExecutor（并行波次）
   │  onNodeStart/onNodeEnd 钩子 → span-writer 按节点串行化增量写 run_node_spans
   │  （(run_id,node_id) 唯一索引 + 幂等 upsert，防终态被并发覆盖）
   ▼
console watchLoop 轮询 GET /runs/:runId/node-spans（700ms）
   │  ├─ 节点徽章（INPROGRESS 旋转 / FINISHED 绿 / ERROR 红）
   │  ├─ 连线点亮（完成段绿色渐变 / 活动段 dash 流动）
   │  └─ 结果面板（正文直出 + 预览 + tokens 徽章 + 失败即时检测；
   │       failed 终态附带 runError —— 源 run_checkpoints.snapshot.failedAt，
   │       零 span 整体失败如拓扑成环时前端唯一可解释线索）
   ▼
终态（runs 行 runStatus）→ 执行卡/结果面板定格
```

- **DAG 禁环**：引擎是 Kahn 拓扑排序执行器，边不得回指成环——校验门 `validateFlowTopology`（生成/保存同源）拒环并具名路径；「循环直到 X」用 iteration 有界轮次逼近或写进 agent systemPrompt 内部迭代（详见 AGENTS.md 节点体系段）

- **chat 路径同源**：`GET /chats/:id/stream`（SSE）同样注入 span-writer + 会话目录 cwd；聊天内「⚡工作流执行卡」与画布同一数据源
- **旁观模式**：`/workflows/:id/canvas?run=<runId>` 可旁观任意运行（chat @flow 触发的也行）
- **实时直播 + 轨迹时间线（2026-10-01）**：引擎钩子在 `assembleWorkflowEngine` 收口旁路进 `run-live-registry`，`GET /runs/:runId/live` SSE 帧流（hello.replay 前缀 + 直播帧，runEnd 关流，断点续跑同 runId 重开）；帧带服务端 `at` 时间戳（registry `emit()` 单点打点）。结果面板三视图：摘要 / 终端 / **轨迹**——`lib/run-trace-model.ts` 纯函数层把直播帧与 DB spans 两路数据收敛为同一 `RunTraceModel`（三投影 sequence/duration/actual），`canvas-trace-view.tsx` 渲染节点泳道甘特 + 事件台账 + Inspector（详见 AGENTS.md 轨迹视图段）
- **项目目录语境**：run body `directoryId` → 解析 `directories.path` → CLI client 闭包注入 cwd（Agent 在选定项目里干活）

## 3. 权限模型（非交互 CLI 授权）

| CLI | 非交互权限 | 覆盖开关 |
|---|---|---|
| claude | `--permission-mode bypassPermissions`（默认） | `DAGENTS_CLAUDE_PERMISSION_MODE`（acceptEdits/default/none） |
| codex | `--full-auto`（工作区可写沙箱） | `DAGENTS_CODEX_SANDBOX` |
| qwen | `--yolo` | — |
| copilot | `--allow-all-tools` | — |

**兜底**：`apps/console/src/lib/refusal-detect.ts` 识别回复中的权限拒绝话术 → 执行卡/结果面板黄警（done 不伪装成功）。

**spawn 输入面（2026-09-17 收紧）**：`executablePath` 注册与运行时双重校验（绝对路径+存在+普通文件）；agent-invoke 的 `cwd` 只收 `directoryId` 引用；HTTP 节点与 http_request 工具共用 SSRF 守卫（私网/环回/链路本地阻断，逃生门 `DAGENTS_HTTP_ALLOW_PRIVATE=1`，e2e 栈启用）。

## 3.1 进程生命周期（2026-09-17 补齐）

- **优雅停机**：SIGTERM/SIGINT → 停接新连接 → `executionRegistry.abortAll()`（5s 落库预算，各执行自持久化终态）→ WS 全客户端关门通知 → tracing/DB 连接池关闭。
- **boot sweep**：收敛 `chats`/`runs` 悬空 running、`run_node_spans` 卡 running 行、离线 daemon 的 `dispatch_tasks`（queued 不动，daemon 重连可 claim）；每步独立容错。
- **错误出口**：`DAGENTS_ERROR_WEBHOOK` 指向 HTTP 端点时，未捕获错误 POST 一条 JSON（fire-and-forget + 窗口内合并计数）；未配置 = 显式 no-op。

## 3.2 dispatch 存留裁决（2026-09-17）

**保留**。理由：daemon 工厂已接通全部适配器（此前 claude-only）、取消链路完整（2s 轮询 + `POST /tasks/:id/cancel`）、有真实入队路径（chat @daemon）与 e2e 覆盖；维护成本与「远程执行」能力的比值已修正。裁决后清理：无消费方的旧读面（dispatch/agents.ts 目录路由）删除，console 一律走 `/api/v1/agents`。

## 4. 数据模型（核心表）

| 表 | 职责 |
|---|---|
| `agents` | 已启用 Agent（kind=CLI 类型；`library_meta` 人格库溯源） |
| `flows` | 工作流定义（`flow_data` JSONB = nodes/edges/viewport） |
| `runs` | 运行记录（status/input/output/duration；chat 触发的也写，含 `chat_id`） |
| `run_node_spans` | 节点级进度（status/tokens/error/input/output；唯一索引 `(run_id,node_id)`） |
| `run_checkpoints` | 断点续跑控制态（topo_hash/snapshot/awaiting；与 spans 观测态分离，见 §2 runError 来源） |
| `chats` / `chat_messages` | 会话与消息（消息 `run_id` + `metadata.source='workflow'` 可判别工作流回复） |
| `llm_providers` | HTTP Provider 配置（key AES-GCM 加密存储） |

**不落库**：人格库与技能库均 registry-not-database（文件系统 = 真相源：`~/.agents/agent-library`、`~/.agents/skills`）。人格库另有 in-repo 双根：`quickstart-library`（rank 50 快速开始）与 `builtin-library`（rank 900 广场精选兜底——50 人格开箱即用，任何用户库同 id 覆盖内置；见 `docs/agent-plaza.md`）。

## 5. Console 关键模块

| 模块 | 位置 | 职责 |
|---|---|---|
| Canvas Kit | `components/flow-canvas/` | 自研画布（kit/model/palette/registry/inspector）；替换记录见 `canvas-replacement-architecture.md` |
| 画布页装配 | `components/canvas/canvas-kit-page.tsx` | 运行输入面板/进度轮询/结果面板/未保存守卫 |
| 结果面板 | `components/canvas/canvas-results-panel.tsx` | 摘要/终端/轨迹三视图（2026-10-01 起含轨迹） |
| 轨迹投影 + 视图 | `lib/run-trace-model.ts` + `components/canvas/canvas-trace-view.tsx` | 帧流/spans → 统一 `RunTraceModel`（纯函数+单测）；节点泳道甘特/事件台账/Inspector |
| 聊天详情 | `components/chat-detail.tsx` | WS+SSE 双通道、工作流执行卡（`workflow-run-card.tsx`） |
| 悬浮副驾 | `components/floating-chat.tsx` | 全局聊天（目录/Agent/Flow 三选择器） |
| 执行 hook | `lib/use-chat-execution.ts` | F0 单一实现（resolveDirectoryId/AgentId/FlowId） |
| i18n | `src/i18n/` | 自然键方案（中文文案=key，`en/` 分模块词典，缺译回退中文） |
| 拒绝检测 | `lib/refusal-detect.ts` | 权限拒绝黄警（中英模式） |

## 6. 测试体系

| 层 | 位置 | 说明 |
|---|---|---|
| 单测/集成 | 各包 vitest | gateway 打真库但钉 `dagents_gw_test`（不碰 dev 库）；跑前自动建库+迁移 |
| 执行态 e2e | `apps/console/tests/e2e/` | Playwright + Mock LLM Provider（端口 4010）；专用库 `dagents_e2e`；**换网关端口必须同步 `GATEWAY_URL`**（BFF 只认它） |
| 引擎语义 | `packages/workflow/.../executor-semantics.test.ts` | 并行部分失败/嵌套迭代/取消/截断/合并顺序等脆弱契约的钉子 |
| 适配器真机 | `scripts/real-cli-smoke.sh` | 本机/自托管 runner 手跑；`.github/workflows/real-cli.yml` nightly（缺 CLI = 如实 SKIP）；claude 已真机 PASS（2026-09-17） |

**开发机注意**：高负载时 jsdom 测试可能超时（已加固 testTimeout=20s）；`pnpm build` 会覆盖 `.next` 致 dev 全站 500（跑过 build 后用 `restart-gateway.sh` 恢复）。

## 7. 专题文档索引

见 [`docs/README.md`](README.md)。架构决策记录：`superpowers/specs/`（系统架构）、`canvas-replacement-architecture.md`（画布替换）、`AGENTS.md` 架构要点段（会话沉淀，最新）。
