# Dagents — Agent Guide

> 全景架构：`docs/ARCHITECTURE.md`（现状真相源）· 历史功能流水账：`CHANGELOG.md` · 常见任务 cookbook：`docs/agent-dev-guide.md` · 文档地图：`docs/README.md`

## 一键重启

**当 gateway 或 console 无响应时，先跑这个：**

```bash
bash restart-gateway.sh
```

此脚本会同时重启 gateway (8080) 和 console (3000)：
- 杀干净所有相关进程（多层进程链 + esbuild）
- 等端口释放
- 后台 `nohup` 启动
- 健康检查（`/health` + HTTP 200）
- 日志输出到 `/tmp/dagents-gateway.log` 和 `/tmp/dagents-console.log`

## 常用命令

```bash
# 单独重启 gateway
pnpm --filter @dagents/gateway dev

# 单独重启 console
pnpm --filter @dagents/console dev

# 单独重启 daemon
pnpm --filter @dagents/daemon dev -- http://localhost:8080 dev-laptop claude

# 基础设施 (Postgres + Langfuse)
cd infra && docker compose up -d

# 测试 / 构建 / 检查
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # tsup → dist/
pnpm format        # prettier --write .（配置 .prettierrc，勿全仓一次性格式化）
pnpm clean         # 清理 gitignored 本地垃圾（*.log / test-results / .DS_Store）
```

## 端口

| 服务 | 端口 |
|---|---|
| Gateway (Hono) | 8080 |
| Console (Next.js) | 3000 |
| Postgres | 15432 → 5432 |
| Langfuse | 3001 |

## 架构总览

```
console (Next) → gateway (Hono) → @dagents/workflow engine
   → [dispatch routes inline] → local daemon → claude/codex CLI
```

- **CLI 第一性**：本地 CLI agent 是基线执行引擎，HTTP LLM Provider 只是可选加速——`@workflow` 生成默认走 CLI spawn（失败才降级 HTTP）；工作流 llmClient 无 provider 时用 `createDefaultLlmClient` CLI 兜底，LLM/Agent 节点零配置可跑；配置了 provider 自动用 HTTP。
- **Workflow-First IA**：`/` = Flows 工作台（空态三入口：团队场景模板 / 一句话生成 / 空白画布）；主导航 `app-nav-sidebar`（工作流 / Agents / 技能 / Daemons + 项目维度会话树 `chat-history-tree`）；Chat 是全局悬浮副驾 `floating-chat`（聊天详情页外全路由常驻）；执行核心在 `use-chat-execution`；模板与运行历史不占导航位（模板走工具栏按钮，历史在 flow 卡片展开区 `FlowRunsPanel`）。
- **inline-executor 是默认执行路径**（不需要 daemon）；dispatch 协议路由内联在 gateway（`src/routes/dispatch/`），daemon 仅 remote 型 Agent 需要。
- **画布 = 自研 Canvas Kit**：`/workflows/[id]/canvas`，`apps/console/src/components/flow-canvas/`（`@xyflow/react` v12 单依赖；vendor/agentflow Flowise fork 已整体删除）。布局自动保存走独立静默管线（拖拽停 debounce 800ms `PUT /layout`，不翻脏标记）；`?run=<runId>` 可旁观任意运行。架构见 `docs/canvas-replacement-architecture.md`。
- **节点体系 9 类**：start / platformAgent（展示名 Agent (CLI)）/ llm / directReply / condition / iteration / humanInput / http / customFunction；生成器别名 `agent→llm`、`loop→iteration`、`conditionagent→condition`；`validateFlowTopology` 是拓扑单一校验器。
- **异步运行 + 实时进度**：`POST /workflows/:id/run?async=1` 立即返回 runId（同步等待会撞代理层 300s 超时）；`GET /runs/:runId/node-spans` 增量进度，数据源是引擎钩子 `onNodeStart/onNodeEnd/onNodeDelta` → `run_node_spans` 表；运行输入支持 `{{$start.input}}` 与 `{{<节点id>.output}}` 引用；CLI 可注入项目目录（run body `directoryId`）。
- **执行可取消 + 超时**：HTTP LLM `LLM_HTTP_TIMEOUT_MS`（默认 120s）；**CLI 不设墙钟上限**，用静默看门狗 `INLINE_INACTIVITY_TIMEOUT_MS` / `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（默认 300s，逐行输出重置）；取消端点（`/chats/:id/cancel`、`/workflows/runs/:runId/cancel`）→ `execution-registry` → AbortSignal 贯穿；dispatch/daemon 远程任务取消已实现（2s 轮询 `cancel_requested_at`）；gateway boot 清扫悬空 running。
- **运行终端视图 + 可操作终端**：结果面板「摘要/终端」切换；`events` 是全量过程日志（保真数据源），`activity` 是策展缓存；运行中可插话 `POST /api/v1/workflows/runs/:runId/message`（CLI 会话 stdin 写帧，排队补话语义）；历史行可「重跑」（运行输入按 flowId 记忆 `dagents.canvas.runInput.<flowId>`）。
- **registry-not-database 家族**：技能库 `~/.agents/skills`、Agent 人格库 `~/.agents/agent-library`（库/目录分离：agents 表只装「已启用」，`instantiate` 启用 + `drift` 三态同步）、流程模板中心（内置 JSON + `flow_templates` 表，personaName 重绑/降级 LLM 节点）。详见 `docs/skills-registry.md` / `docs/agent-library.md` / `docs/flow-templates.md`。
- **统一 AI 生成管线**：chat `@workflow` 与画布 GenerateFlowDialog 共用 `routes/flow-generator.ts`（CLI 优先/HTTP 兜底 → 别名归一 → `validateFlowTopology` → 一轮修复循环 → 显式失败，无静默兜底）。
- **中英双语 i18n**：自然键（中文文案即 key），`apps/console/src/i18n/`；新增界面文案直接写中文并用 `t('中文')` 包裹，英文词条加到 `en/*.ts`；语言/主题切换在设置页「通用 · 外观与语言」tab。
- **LLM Provider CRUD + 动态代理转发**（AES-GCM 解密；SSRF 防护在位）。
- **e2e 体系**：`apps/console/tests/e2e/`（UC 用例 + 执行态 + 终端操作，Mock LLM Provider :4010 是确定性地基；专用测试库 `dagents_e2e`；CI 在 `.github/workflows/e2e.yml`）。**测试中途强杀可能残留 `e2e-mock-%` active provider 行——清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`**。
- **gateway 单测专用库**：vitest `globalSetup` 自动建/迁移 `dagents_gw_test`（worker fork 前注入 `POSTGRES_URL`），dev 库零触碰。
- **运维脚本**：执行轨迹 retention（`DAGENTS_RETENTION_DAYS` 默认 90 天，0 关闭）、备份 `scripts/backup.sh`、清理 `pnpm clean`、dev/build 互踩防护 `scripts/guard-build.mjs`。
- Workflow 引擎文档：`docs/workflow-engine.md`（执行模型 / 流式 / 已知限制）。

## 已知问题

- **dev server 运行期间勿跑 `pnpm build` / `pnpm --filter @dagents/console build`**：生产构建会覆盖 `apps/console/.next`，导致 dev server 全站 500（`build-manifest.json` ENOENT）。误跑后用一键重启脚本恢复（脚本会清理 `.next` 缓存）。全仓 `pnpm test` 经 turbo 也会触发 console build，同样有此风险。
- **dev 环境勿在长任务运行时并发全仓 build/test**：gateway dev 的 `tsx watch` 监视 workspace 包 dist——turbo 全仓 test/typecheck 重建 `packages/*/dist` 会触发 gateway 自动重启，**进行中的 run 连同 CLI 子进程被终止**（boot reaper 会把悬空 run 收敛为 failed，日志可见「boot sweep: dangling runs converged to failed」）。生产部署无 tsx watch，不受影响。
- **remote 类型 Agent 需 Daemon 在线**：`auto` 路由已优先选择 CLI 类型 Agent；库里残留的 remote Agent（如 "test"）手动选中时会收到引导性报错，建议清理或为其启动 Daemon。
- 仍存在的已知取舍见 `docs/workflow-engine.md` 的「现状与限制」（new Function 非沙箱、HumanInput 挂起态在内存等）。

## 配置

- 环境变量：`.env`（模板见 `.env.example`）；基础设施模板 `infra/.env.example`
- 技能库 / 人格库根：`~/.agents/`（`skills/`、`agent-library/`，可用 `DAGENTS_SKILL_DIRS` / `DAGENTS_AGENT_LIBRARY_DIRS` 覆盖）
- 认证：无登录（本机模式）。Gateway 默认开放；如需对外暴露可设 `GATEWAY_API_KEY`（16+ 字符 bearer key）
- 代码风格：`.prettierrc`（无分号 / 单引号 / printWidth 100）——新增文件随手格式化，**不要全仓一次性格式化**（会淹没审查 diff）
