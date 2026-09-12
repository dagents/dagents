# Dagents 架构总览（现状真相源）

> 更新：2026-09-12。本文回答"系统今天长什么样"，决策过程见各专题文档。
> 分层契约与命令以 `CLAUDE.md` / `AGENTS.md` 为准，本文提供全景与关键链路。

---

## 1. 系统分层

```
console (Next.js App Router, :3000)
   │  /api/* BFF 直转发网关（gateway URL 只在服务端）
   │  自研 Canvas Kit 画布（flow-canvas/）+ 悬浮副驾 FloatingChat
   ▼
gateway (Hono, :8080)                    装配一切：路由/执行/持久化
   │  @dagents/workflow DagExecutor      DB-free DAG 引擎
   │  span-writer 增量节点进度           CLI-first LLM 策略
   ▼
packages/                                contracts · workflow · agent-adapters · db · shared
   │
   ▼
本地 CLI（claude/codex/qwen/copilot…17 种）· Postgres(:15432) · Langfuse(:3001 可选)
```

- **无登录本机模式**：仅可选 `GATEWAY_API_KEY`（≥16 字符生效）
- **CLI 第一性**：无 LLM Provider 配置时，LLM/Agent 节点与聊天全部走本地 CLI（零配置基线）；配了 Provider 则走 HTTP 加速
- **IA（2026-09-06 定稿）**：`/` = Flows 工作台（Workflow-First）；Chat-First 回滚壳已退役；聊天入口 = 悬浮副驾 + 侧栏会话树

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
   │  └─ 结果面板（正文直出 + 预览 + tokens 徽章 + 失败即时检测）
   ▼
终态（runs 行 runStatus）→ 执行卡/结果面板定格
```

- **chat 路径同源**：`GET /chats/:id/stream`（SSE）同样注入 span-writer + 会话目录 cwd；聊天内「⚡工作流执行卡」与画布同一数据源
- **旁观模式**：`/workflows/:id/canvas?run=<runId>` 可旁观任意运行（chat @flow 触发的也行）
- **项目目录语境**：run body `directoryId` → 解析 `directories.path` → CLI client 闭包注入 cwd（Agent 在选定项目里干活）

## 3. 权限模型（非交互 CLI 授权）

| CLI | 非交互权限 | 覆盖开关 |
|---|---|---|
| claude | `--permission-mode bypassPermissions`（默认） | `DAGENTS_CLAUDE_PERMISSION_MODE`（acceptEdits/default/none） |
| codex | `--full-auto`（工作区可写沙箱） | `DAGENTS_CODEX_SANDBOX` |
| qwen | `--yolo` | — |
| copilot | `--allow-all-tools` | — |

**兜底**：`apps/console/src/lib/refusal-detect.ts` 识别回复中的权限拒绝话术 → 执行卡/结果面板黄警（done 不伪装成功）。

## 4. 数据模型（核心表）

| 表 | 职责 |
|---|---|
| `agents` | 已启用 Agent（kind=CLI 类型；`library_meta` 人格库溯源） |
| `flows` | 工作流定义（`flow_data` JSONB = nodes/edges/viewport） |
| `runs` | 运行记录（status/input/output/duration；chat 触发的也写，含 `chat_id`） |
| `run_node_spans` | 节点级进度（status/tokens/error/input/output；唯一索引 `(run_id,node_id)`） |
| `chats` / `chat_messages` | 会话与消息（消息 `run_id` + `metadata.source='workflow'` 可判别工作流回复） |
| `llm_providers` | HTTP Provider 配置（key AES-GCM 加密存储） |

**不落库**：人格库与技能库均 registry-not-database（文件系统 = 真相源：`~/.agents/agent-library`、`~/.agents/skills`）。

## 5. Console 关键模块

| 模块 | 位置 | 职责 |
|---|---|---|
| Canvas Kit | `components/flow-canvas/` | 自研画布（kit/model/palette/registry/inspector）；替换记录见 `canvas-replacement-architecture.md` |
| 画布页装配 | `components/canvas/canvas-kit-page.tsx` | 运行输入面板/进度轮询/结果面板/未保存守卫 |
| 聊天详情 | `components/chat-detail.tsx` | WS+SSE 双通道、工作流执行卡（`workflow-run-card.tsx`） |
| 悬浮副驾 | `components/floating-chat.tsx` | 全局聊天（目录/Agent/Flow 三选择器） |
| 执行 hook | `lib/use-chat-execution.ts` | F0 单一实现（resolveDirectoryId/AgentId/FlowId） |
| i18n | `src/i18n/` | 自然键方案（中文文案=key，`en/` 分模块词典，缺译回退中文） |
| 拒绝检测 | `lib/refusal-detect.ts` | 权限拒绝黄警（中英模式） |

## 6. 测试体系

| 层 | 位置 | 说明 |
|---|---|---|
| 单测/集成 | 各包 vitest | gateway 打真库但钉 `dagents_gw_test`（不碰 dev 库）；跑前自动建库+迁移 |
| 执行态 e2e | `apps/console/tests/e2e/` | Playwright + Mock LLM Provider（端口 4010）；专用库 `dagents_e2e` |
| 契约/冒烟 | 真机 Playwright 脚本 | 本会话惯例：node /tmp/xx.mjs 临时脚本 + 截图取证 |

**开发机注意**：高负载时 jsdom 测试可能超时（已加固 testTimeout=20s）；`pnpm build` 会覆盖 `.next` 致 dev 全站 500（跑过 build 后用 `restart-gateway.sh` 恢复）。

## 7. 专题文档索引

见 [`docs/README.md`](README.md)。架构决策记录：`superpowers/specs/`（系统架构）、`canvas-replacement-architecture.md`（画布替换）、`AGENTS.md` 架构要点段（会话沉淀，最新）。
