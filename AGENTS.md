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
- **Workflow-First IA**：`/` = Flows 工作台（空态三入口：团队场景模板 / 一句话生成 / 空白画布）；主导航 `app-nav-sidebar`（工作流 / Agents / 技能 / 终端 / Daemons + 项目维度会话树 `chat-history-tree`）；Chat 是全局悬浮副驾 `floating-chat`（聊天详情页外全路由常驻）；执行核心在 `use-chat-execution`；模板与运行历史不占导航位（模板走工具栏按钮，历史在 flow 卡片展开区 `FlowRunsPanel`）。
- **inline-executor 是默认执行路径**（不需要 daemon）；dispatch 协议路由内联在 gateway（`src/routes/dispatch/`），daemon 仅 remote 型 Agent 需要。
- **画布 = 自研 Canvas Kit**：`/workflows/[id]/canvas`，`apps/console/src/components/flow-canvas/`（`@xyflow/react` v12 单依赖；vendor/agentflow Flowise fork 已整体删除）。布局自动保存走独立静默管线（拖拽停 debounce 800ms `PUT /layout`，不翻脏标记）；`?run=<runId>` 可旁观任意运行。架构见 `docs/canvas-replacement-architecture.md`。
- **节点体系 9 类**：start / platformAgent（展示名 Agent (CLI)）/ llm / directReply / condition / iteration / humanInput / http / customFunction；生成器别名 `agent→llm`、`loop→iteration`、`conditionagent→condition`；`validateFlowTopology` 是拓扑单一校验器。
- **异步运行 + 实时进度**：`POST /workflows/:id/run?async=1` 立即返回 runId（同步等待会撞代理层 300s 超时）；`GET /runs/:runId/node-spans` 增量进度，数据源是引擎钩子 `onNodeStart/onNodeEnd/onNodeDelta` → `run_node_spans` 表；运行输入支持 `{{$start.input}}` 与 `{{<节点id>.output}}` 引用；CLI 可注入项目目录（run body `directoryId`）。
- **执行可取消 + 超时**：HTTP LLM `LLM_HTTP_TIMEOUT_MS`（默认 120s）；**CLI 不设墙钟上限**，用静默看门狗 `INLINE_INACTIVITY_TIMEOUT_MS` / `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（默认 300s，逐行输出重置）；取消端点（`/chats/:id/cancel`、`/workflows/runs/:runId/cancel`）→ `execution-registry` → AbortSignal 贯穿；dispatch/daemon 远程任务取消已实现（2s 轮询 `cancel_requested_at`）；gateway boot 清扫悬空 running。
- **运行终端视图 + 可操作终端**：结果面板「摘要/终端」切换；运行中终端视图是 **live attach 直播**（`GET /runs/:runId/live` SSE 帧流：引擎钩子在 `assembleWorkflowEngine` 收口旁路进进程内 `run-live-registry`，hello.replay 全量前缀 + 逐帧实时，runEnd 关流；契约 `@dagents/contracts/run-live.ts`；404/断流诚实回退 node-spans 轮询渲染）；`events` 是全量过程日志（保真数据源），`activity` 是策展缓存；运行中可插话 `POST /api/v1/workflows/runs/:runId/message`（CLI 会话 stdin 写帧，排队补话语义，回执以 user_input 帧回流直播）；历史行可「重跑」（运行输入按 flowId 记忆 `dagents.canvas.runInput.<flowId>`）。
- **浏览器终端 `/terminal`**：真 PTY 直通，不是 agent 代跑——gateway `node-pty` 起用户 `$SHELL`（login shell，**最小环境注入**，不泄漏网关密钥），SSE 推 base64 输出帧，console `xterm.js` 渲染；提示符/颜色/交互程序（top、vim、Ctrl-C）全原生。**多标签（P2）**：tab 条切换/× 关闭/+ 同目录新开，`dagents.terminal.tabs` 持久化；决策层 `shell-session-plan.ts`（planTabsBoot/planOpenDir 纯函数 + 单测，同目录复用 tab / 活动 tab attach-recreate / 旧单会话 key 迁移）。**双锚点入口（P1）**：失败运行行「终端」/ 画布失败摘要 / Chat 错误卡 → `?dir=<id>` 深链直达（href 单源 `terminal-links.ts`；runs.directory_id 数据链已通，P0）；解析不到目录不渲染。**交互式 agent 会话（P4）**：Agent 详情「交互式会话」→ `/terminal?agent=<id>`，registry 按命令 spawn（`agt_` 会话 + label），人格注入 claude（v1 唯一支持档，其余 kind 诚实 400）。**协议契约在 `@dagents/contracts/shell.ts`（双端单一事实源）**；console 侧分层：`shell-terminal.tsx` 纯装配 / `lib/use-shell-session.ts` 编排 hook / `lib/shell-session-plan.ts` 纯决策 / `lib/shell-protocol.ts` 纯解析 / `lib/shell-theme.ts` 主题 / `shell-dir-picker.tsx` 选择器。键入走 8ms 微批 + 跨批串行；刷新重连（hello 帧回放 256KB）；孤儿回收默认 10 分钟，上限 8，总开关 `DAGENTS_SHELL_DISABLED=1`。设计真相源 `docs/design-terminal-anchors.md` + 架构 `docs/terminal-architecture.md`。**坑**：pnpm 解包 node-pty prebuild 丢 `spawn-helper` 可执行位——网关启动自愈 chmod，构建批准在 `pnpm-workspace.yaml` `onlyBuiltDependencies`；**dev 冷编译陷阱**：改 BFF 路由后首访 4-15s 是 Next 懒编译非缺陷，e2e/矩阵前先热身路由。
- **registry-not-database 家族**：技能库 `~/.agents/skills`、Agent 人格库 `~/.agents/agent-library`（库/目录分离：agents 表只装「已启用」，`instantiate` 启用 + `drift` 三态同步）、流程模板中心（内置 JSON + `flow_templates` 表，personaName 重绑/降级 LLM 节点）。详见 `docs/skills-registry.md` / `docs/agent-library.md` / `docs/flow-templates.md`。
- **统一 AI 生成管线**：chat `@workflow` 与画布 GenerateFlowDialog 共用 `routes/flow-generator.ts`（CLI 优先/HTTP 兜底 → 别名归一 → `validateFlowTopology` → 一轮修复循环 → 显式失败，无静默兜底）。
- **中英双语 i18n**：自然键（中文文案即 key），`apps/console/src/i18n/`；新增界面文案直接写中文并用 `t('中文')` 包裹，英文词条加到 `en/*.ts`；语言/主题切换在设置页「通用 · 外观与语言」tab。
- **LLM Provider CRUD + 动态代理转发**（AES-GCM 解密；SSRF 防护在位）。
- **e2e 体系**：`apps/console/tests/e2e/`（UC 用例 + 执行态 + 终端操作，Mock LLM Provider :4010 是确定性地基；专用测试库 `dagents_e2e`；CI 在 `.github/workflows/e2e.yml`）。**测试中途强杀可能残留 `e2e-mock-%` active provider 行——清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`**。
- **gateway 单测专用库**：vitest `globalSetup` 自动建/迁移 `dagents_gw_test`（worker fork 前注入 `POSTGRES_URL`），dev 库零触碰。
- **运维脚本**：执行轨迹 retention（`DAGENTS_RETENTION_DAYS` 默认 90 天，0 关闭）、备份 `scripts/backup.sh`、清理 `pnpm clean`、dev/build 互踩防护 `scripts/guard-build.mjs`。
- Workflow 引擎文档：`docs/workflow-engine.md`（执行模型 / 流式 / 已知限制）。

## 已知问题

- **dev server 运行期间勿跑 `pnpm build` / `pnpm --filter @dagents/console build`**：生产构建会覆盖 `apps/console/.next`，导致 dev server 全站 500（`build-manifest.json` ENOENT）。误跑后用一键重启脚本恢复。全仓 `pnpm test` 已改 `dependsOn: ^build`（只建 workspace 包不建 console），无此风险。
- **dev 环境勿在长任务运行时并发全仓 build/test**：gateway dev 的 `tsx watch` 监视 workspace 包 dist——turbo 重建 `packages/*/dist` 会触发 gateway 自动重启，**进行中的 run 连同 CLI 子进程被终止**（boot sweep 会把悬空 run 收敛为 failed）。生产部署无 tsx watch，不受影响。
- **remote 类型 Agent 需 Daemon 在线**：`auto` 路由已优先选择 CLI 类型 Agent；库里残留的 remote Agent 手动选中时会收到引导性报错，建议清理或为其启动 Daemon。
- **适配器真机回归欠账**：claude 已真机 PASS（2026-09-17，`scripts/real-cli-smoke.sh`）；codex/qwen 等 15 个 docs-only 适配器待真机回归（nightly `real-cli.yml` 需带 CLI 的 self-hosted runner），分级见 `packages/agent-adapters/src/tiers.ts`。
- **e2e 隔离栈换网关端口必须同步 `GATEWAY_URL`**：BFF 只认 `GATEWAY_URL`（默认 :8080），`E2E_GATEWAY_URL` 只影响 seed 直连——漏配则浏览器路径全 502（tests/e2e/README 配方已注明）。
- 仍存在的已知取舍见 `docs/workflow-engine.md` 的「现状与限制」（customFunction 隔离非沙箱、HumanInput 挂起态在内存等）。

## 配置

- 环境变量：`.env`（模板见 `.env.example`）；基础设施模板 `infra/.env.example`
- 技能库 / 人格库根：`~/.agents/`（`skills/`、`agent-library/`，可用 `DAGENTS_SKILL_DIRS` / `DAGENTS_AGENT_LIBRARY_DIRS` 覆盖）
- 认证：无登录（本机模式）。Gateway 默认开放；如需对外暴露可设 `GATEWAY_API_KEY`（16+ 字符 bearer key）
- 代码风格：`.prettierrc`（无分号 / 单引号 / printWidth 100）——新增文件随手格式化，**不要全仓一次性格式化**（会淹没审查 diff）
