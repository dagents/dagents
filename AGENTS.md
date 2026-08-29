# Dagents — Agent Guide

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

# 测试 / 构建
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # tsup → dist/
```

## 端口

| 服务 | 端口 |
|---|---|
| Gateway (Hono) | 8080 |
| Console (Next.js) | 3000 |
| Postgres | 15432 → 5432 |
| Langfuse | 3001 |

## 架构要点

```
console (Next) → gateway (Hono) → @dagents/workflow engine
   → [dispatch routes inline] → local daemon → claude/codex CLI
```

- **CLI 第一性（2026-08-18）**：本地 CLI agent 是基线执行引擎，HTTP LLM Provider 只是可选加速 —— ①`@workflow` 生成默认走 CLI spawn（prompt 注入真实 agent 清单 + 技能清单，"claude a 做规划"可映射到真实 agentId 的 platformAgentAgentflow 节点），CLI 失败才降级 HTTP；②工作流执行的 llmClient 无 provider 时用 CLI 兜底（`createDefaultLlmClient`），LLM/Agent 节点零配置可跑。配置了 provider 则自动用 HTTP。
- Chat-First UX：聊天主页 `/` + 聊天详情 `/chats/{id}`
- `inline-executor` 是默认执行路径（不需要 daemon）
- Workflow 画布编辑器：`/workflows/[id]/canvas`（vendor/agentflow/）
- **结果面板 v2（2026-08-23）**：节点产出按内容渲染——LLM/DirectReply 的 text/content 双重解包后**正文直出**（DirectReply 的字符串化 JSON 也会二次解包），JSON 降为「原始数据」二级折叠；折叠行内联**正文预览**（首行截断）；**tokens 徽章** ↑输入↓输出（CLI 兜底 client 此前丢 usage，现已从 result.usage 聚合返回，双命名 prompt_tokens/inputTokens 兼容）；运行中**已完成的节点自动展开**（用户手动收起则记住不强开）。进度分母 = 流程总节点数（initialFlowData），非已出现 span 数。
- **画布运行项目目录（2026-08-23）**：运行输入面板含**项目目录选择器**（`dagents.canvas.runDir` 记忆）。run body `directoryId` → gateway 解析 `directories.path` → `createDefaultLlmClient('claude', { cwd })` 闭包注入 → 所有 LLM/Agent/PlatformAgent 节点的 CLI 在选定项目目录执行（此前 CLI 一律在网关进程 cwd 跑——Agent 在错误的项目里干活）。chat 流式路径同样注入会话绑定目录的 cwd。HTTP provider 路径不受影响（无文件系统语义）。
- **画布异步运行（2026-08-23）**：`POST /workflows/:id/run?async=1` —— 先落 status='running' 的 runs 行、后台执行、**立即返回 runId**（同步等待会让 5-9 分钟的多 Agent 链撞上代理层 300s 超时，客户端误报失败）。画布统一走 `watchLoop` 轮询终态；任一 span failed 时**立即**置失败态并提示节点名（不等 runs 行落库）。结果面板：运行中显示「正在执行：节点X（n/m 完成）」呼吸行 + 节点开始时间 + 输入折叠。
- **画布运行输入 + 运行结果面板（2026-08-23）**：点「▶ 运行」先弹输入面板（输入作为 `{{$start.input}}` 传入，支持 `{{<节点id>.output}}` 引用；⌘⏎ 快捷运行）——不再空跑。顶栏「运行结果（n）」按钮打开逐节点面板：状态点（旋转/绿/红）+ 耗时 + 展开看产出 JSON（`latestSpans` 来自 node-spans 轮询，旁观模式同样可用）。
- **画布旁观任意运行（2026-08-23）**：画布页支持 `?run=<runId>` 自动旁观任意运行（chat @flow 触发的也行）；入口在 chat 详情右栏「执行记录」和 Flows 详情页的「画布查看」。chat 流式执行路径（`GET /chats/:id/stream`）与画布直跑共用 `span-writer.ts` 增量进度（按节点串行化防终态被并发 start 覆盖；`run_node_spans` 有 `(run_id,node_id)` 唯一索引 + 幂等 upsert），并在结束后补写 `runs` 行（chat 触发的运行从此进 flow 运行历史）。连线随进度点亮：完成段绿色渐变、活动段 dash 流动（`flowise-canvas.tsx` 的 applyEdgeStates）。node-spans 读端点附带 `runStatus/runDurationMs` 供旁观端判断终态。
- **画布内运行 + 节点实时进度（2026-08-22）**：画布顶栏「▶ 运行」自带 `x-run-id` 请求头发起 POST（run 端点接受客户端 runId），同时 700ms 轮询 `GET /runs/:runId/node-spans`，把节点状态刷到 vendor 徽章（INPROGRESS=旋转 / FINISHED=绿勾 / ERROR=红叉）。数据源是引擎新钩子：`DagExecutor.execute` 的 `onNodeStart/onNodeEnd` → gateway `run_node_spans` 增量 UPDATE-then-INSERT（事后批量落库跳过已写节点防重复）。引擎钩子测试在 `packages/workflow/src/__tests__/executor.test.ts`。
- Workflow 引擎文档：`docs/workflow-engine.md`（架构 / 执行模型 / Langfuse 开启方式 / 已知限制）
- LLM Provider CRUD + 动态代理转发
- **中英双语（2026-08-16）**：自然键 i18n（`apps/console/src/i18n/`）——中文文案即 key，`en/` 词典分模块维护（common/agents/flows/daemons/settings/chat），缺译自动回退中文；`useI18n()` 无 Provider 也能用（默认 zh）。语言切换在侧栏底部（`dagents.locale` 持久化）。新增界面文案直接写中文并用 `t('中文')` 包裹，英文词条加到对应 `en/*.ts`。
- 技能库（registry-not-database）：`~/.agents/skills` + `DAGENTS_SKILL_DIRS` + console 界面直接添加目录（持久化 `~/.agents/skill-dirs.json`，`POST/DELETE /api/v1/skills/roots`），`GET /api/v1/skills`，console `/skills` 页；不落库、正文不缓存。Agent 挂载的技能在执行时注入 system prompt（inline chat + workflow PlatformAgent，见 `skill-injection.ts`）。详见 `docs/skills-registry.md`
- **agent-templates 已退役（2026-08-23，方案 B）**：原「从模板创建」的 5 个静态模板翻译为人格库「快速开始」分区（`apps/gateway/quickstart-library/`，内置库根 rank 50，frontmatter `kind`/`model` 为建议运行时）。instantiate 默认采用人格建议（请求体可覆盖）；人格库确认步新增运行时/模型档位选择器。Agents 页只剩「新建 Agent」+「从人格库启用」两个互补入口。`routes/agent-templates.ts` 与 console 的 gallery/lib/BFF 已删除（flow-templates 是另一套，未动）。
- **Agent 人格库（2026-08-19）**：同一 registry-not-database 模式承载 agency-agents 人格库（默认根 `~/.agents/agent-library`，软链到 clone 即挂载；`DAGENTS_AGENT_LIBRARY_DIRS` + `POST/DELETE /api/v1/agent-library/roots`）。**库/目录分离：人格住文件系统，agents 表只装「已启用」的**（`POST /api/v1/agent-library/:division/:slug/instantiate`，默认 kind=claude + slim 三档编译 + 语言包络 + `library_meta` 溯源），`@workflow` 清单注入天然不爆（另有 80 条防御上限）。上游同步 = 挂载目录 `git pull` + `GET /drift` 三态 + `reimport`（覆盖 instructions、id 不变、工作流引用不失效）。console：/agents 页「从人格库启用」。**团队场景模板（Phase 3）**：`GET/POST /api/v1/agent-library/team-templates*`，6 个多 Agent 场景（README Scenario 1~6）按人格 name 解析成员 → 复用/自动启用 → 生成 draft flow（注意：teams 路由须在 `/:division/:slug` 前注册）。中文人格衍生库在 `~/.agents/agent-library-zh`（不挂载；同名覆盖语义见其 README）。详见 `docs/agent-library.md`
- **流程模板中心（2026-08-20）**：三层模板收拢 —— 内置（`gateway/src/flow-templates/builtin/*.json`，import 内联含 `with { type: 'json' }`，社区 PR 见其 README）/ 团队场景（agent-library）/ 我的模板（画布顶部操作条「另存为模板」→ `flow_templates` 表）。`POST /api/v1/flow-templates/:id/instantiate` 按 personaName 重绑（复用/自动启用），未命中降级 LLM 节点（模板零依赖可跑）；`builtin/<slug>` 含斜杠有专属路由形态。console：/flows「从模板创建」三 tab 画廊。详见 `docs/flow-templates.md`
- **模板参数化（2026-08-22，产品方案 G）**：节点文案里的 `{{变量名}}`（支持中文，与引擎变量语法共用）在「另存为模板」时扫描入 `flow_templates.params`；实例化确认框表单回填（`answers`），缺省回落 defaultValue/空串，未声明占位符保留原样交给引擎运行时解析。
- **统一 AI 生成管线（2026-08-22，产品方案 A1/A2/A5）**：chat `@workflow` 与画布 GenerateFlowDialog 共用 gateway 单一服务 `routes/flow-generator.ts`（CLI 优先/HTTP 兜底，canvas 可指定 `providerId::model` 或 `agent::<id>` 引擎；别名归一 → `@dagents/workflow` 的 `validateFlowTopology` 拓扑校验 → 一轮修复循环 → **显式失败，静默兜底已删除**；每次生成写 `generator_attempts` 埋点）。console BFF 只做 vendor 形状适配（薄代理 `POST /api/v1/flow-generator/generate`）。画布保存走同一校验器做非阻断干跑警告。
- **执行可取消 + 超时（2026-08-22，产品方案 B / 执行取消 spec；2026-08-27 修订 CLI 时长策略）**：HTTP LLM 调用超时 `LLM_HTTP_TIMEOUT_MS`（默认 120s，流式为空闲看门狗）；**CLI 执行不设墙钟上限**（Agent 自主长跑是常态，曾有 4 路并行 Agent 在 180s 墙被截断成「部分文本 + done」假成功）——inline 聊天 `INLINE_INACTIVITY_TIMEOUT_MS`、工作流节点 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（均默认 300s 静默看门狗，逐行输出即重置）；看门狗触发/取消 → 非完成状态（timeout/aborted/cancelled）诚实抛错，usage 附着错误对象、失败节点 span 仍记 tokens；显式取消 `POST /api/v1/chats/:id/cancel` 与 `POST /api/v1/workflows/runs/:runId/cancel` → `execution-registry.ts` 内存注册表（单进程红线）→ AbortSignal 贯穿引擎/llmClient/adapters（SIGTERM→SIGKILL）→ `chat:cancelled` WS 帧 + `persistCancelled`；gateway boot 清扫悬空 running（chats/runs→failed）。console 停止按钮接真取消。**dispatch/daemon 远程任务取消未做**（spec §7 Deferred）。适配器维护分级单源在 `packages/agent-adapters/src/tiers.ts`（core：claude/codex/qwen）。
- **多实例 CLI 协作引擎修复（2026-08-27，真实复跑驱动）**：对「产品发现（并行）」（7 节点菱形，4 并行 claude 实例）做真实复跑暴露三个 mock 测不出的引擎缺陷并已修复——①**N 进 1 合并契约**：`mergeInputs` 拼接 `content`，下游 LLM/PlatformAgent 节点优先取 `content`（`text` 被浅合并覆盖只剩最后一条边；修复前汇总节点丢 N-1 份上游产出，e2e WF-09 钉住）；②**空产出守卫**：LLM/PlatformAgent 空正文抛错标 failed，不再假成功（WF-10/11）；③**Iteration/Loop 终态 span**：controller 体内执行完成后重发 `onNodeEnd`，`completedIterations`/`iterations` 落库、endedAt 为整轮真实耗时（OB-05/MA-06/07/16/ED-03/04 六例既有 e2e 失败全部转绿）。真实终验：汇总节点 209s（> 旧 180s 墙）正常完成、四份简报全到达、逐节点 tokens 完整。详见 `docs/workflow-engine.md` 执行模型速查。
- **执行态 e2e（2026-08-19）**：`apps/console/tests/e2e/` spec 11~15（57 用例：工作流执行契约（含 WF-09~11 合并/空产出回归钉）/ 多 Agent 协作 MA-01~18 / 聊天触发 SSE / 边界 / UI 旅程），地基是 **Mock LLM Provider**（`tests/e2e/fixtures/mock-llm-server/`，OpenAI 兼容 + `/__control/*` 控制面，端口 4010，playwright webServer 自动拉起）。`seedMockLlmProvider` 会临时切换 dev 库的 active provider —— **测试中途强杀可能残留 `e2e-mock-%` 行，导致真实 LLM 调用指向死 mock；清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`**。DAG 构造用 `tests/e2e/helpers/flow-builder.ts`（平铺 `data.<field>`）。专用测试库 `dagents_e2e` 已建（全栈隔离需 gateway 以 `POSTGRES_URL=…dagents_e2e` 启动，见 `tests/e2e/README.md`）；CI 在 `.github/workflows/e2e.yml`。详见 `docs/e2e-test-plan.md` §12 执行记录。
- **Workflow-First IA 反转（2026-08-29，PRD `docs/prd-workflow-first.md` v1.1 已评审）**：`/` = Flows 工作台（空态三入口：团队场景模板 / 一句话生成 / 空白画布，`flows-empty-hero`）；新主导航 `app-nav-sidebar`（工作流 / 模板 `/templates` / 运行历史 `/runs` / Agents / 技能 / Daemons + 底部「最近对话」折叠区）；**Chat 降为全局悬浮副驾**（`floating-chat` 除 `/chats/[id]` 外全路由常驻，可拖动/拉大/位置记忆，画布页避让 minimap，历史抽屉承接旧会话树，HITL 内联应答条）；执行核心收敛到 `use-chat-execution`（F0 单一实现，WS 帧语义 `applyChatFrame` 纯函数可复用）；`@workflow` 生成落点 toast+直达（toast 支持 action 按钮）；`/runs` 跨流运行历史（gateway `GET /api/v1/runs` + 失败原因摘要列）；gateway `routes/runs.ts` 新挂载。**回滚通道**：`localStorage dagents.ia.workflow-first=off` 恢复 Chat-First 首页+旧侧栏（e2e IA-04 钉住；flag 存续期 ≤1 迭代）。e2e：01/03/08 重写为新 IA 断言 + 新增 19 号冒烟（IA-01~04）。
- **gateway 单测专用库自动供给（2026-08-29）**：`apps/gateway` 的 vitest `globalSetup`（`src/test-support/gw-test-db.ts`）把整套集成测试（15 个 DB-backed 文件）钉到 `dagents_gw_test` —— 连 `postgres` 维护库建库、经 `@dagents/db` 的 dist 迁移（幂等可增量）、在 worker fork **之前**注入 `POSTGRES_URL`（`AppDataSource` 在模块构造时捕获 env，与 e2e `seed.ts` 同款约束）。此前这些测试直连 dev 库，dispatch 两个文件还 `DELETE FROM runs` 全表 wipe——**每跑一次 gateway 单测就清空 dev 库全部真实运行历史**，且末用例种子（`flow-1`/`running` 行）残留成「孤儿 running」。服务器地址沿用 `POSTGRES_URL` 只换库名：本机 :15432 与 CI 服务容器 :5432 均适用，dev 库从此零触碰（CI `ci.yml` 无需改动，服务容器用户具备建库权限）。

## 已知问题

- **dev server 运行期间勿跑 `pnpm build` / `pnpm --filter @dagents/console build`**：生产构建会覆盖 `apps/console/.next`，导致 dev server 全站 500（`build-manifest.json` ENOENT）。误跑后用一键重启脚本恢复（脚本会清理 `.next` 缓存）。全仓 `pnpm test` 经 turbo 也会触发 console build，同样有此风险。
- **dev 环境勿在长任务运行时并发全仓 build/test**：gateway dev 的 `tsx watch` 监视 workspace 包 dist——turbo 全仓 test/typecheck 重建 `packages/*/dist` 会触发 gateway 自动重启，**进行中的 run 连同 CLI 子进程被终止**（boot reaper 会把悬空 run 收敛为 failed，日志可见「boot sweep: dangling runs converged to failed」）。生产部署无 tsx watch，不受影响。
- **remote 类型 Agent 需 Daemon 在线**：`auto` 路由已优先选择 CLI 类型 Agent（2026-08-15 修复）；库里残留的 remote Agent（如 "test"）手动选中时会收到引导性报错，建议清理或为其启动 Daemon。

## 2026-08-16 审计修复（摘要）

全库审计后修复的主要问题（详见当次会话）：

- **安全**：llm 代理 SSRF（绝对 URL 劫持 + 密钥外泄）已封堵；`/internal` 与 dispatch 非 daemon-protocol 路由纳入 `GATEWAY_API_KEY` 门禁；dispatch 任务生命周期路由校验认领 daemon 的 token；WS 升级在 key 模式下校验 token + Origin、非 `/ws` 升级请求显式拒绝；HTTP 节点加 scheme 白名单/15s 超时/32KB 截断；pi 适配器 resumeSessionId 约束到会话目录。
- **引擎**：画布 `data.inputs` 配置归一化（此前画布 flow 全部按空配置跑）；锚点 handle 路由修复（普通数据节点的下游不再被静默跳过，画布 Condition 数字/Else 锚点映射 true/false）；DirectReply/CustomFunction 字段名对齐；workflow LLM client 改用 AES-GCM 解密（此前开加密必 401）；Iteration 100 项上限；HumanInput/ExecuteFlow 无注入时显式报错。
- **适配器**：codex 重写为 `codex exec --json` + 真实事件流（旧版双幻觉）；openclaw 支持多行 JSON blob + 纯文本错误行判失败（实测 openclaw 失败时退出码是 0）；codebuddy 去掉自相矛盾的 `--input-format`；copilot 加自主 flag；gemini 模板移除（无适配器，建了也跑不了）。**注意：codex/codebuddy/copilot/qwen 本机未安装，修复基于官方文档格式，未经真实 CLI 回归。**
- **前端**：daemon 删除死按钮接通代理；Daemons「日志」改为真实 task events；Settings 五个假数据 tab 标注「未接入」；onboarding 条件对齐 inline 架构；AgentSelector 快速创建 bug 修复；Flows 假筛选/假运行记录移除；cost/load 标注估算。
- **基础设施**：`@dagents/db` 构建产物现在包含 entities/migrations（此前 dist 下 `runMigrations()` 静默 no-op）；audit 测试不再回退 CHECK 约束（dev 库已同步修复）；daemon 401/403 触发重注册（此前只听 404 永不触发）、注册失败 exit 1；空壳 e2e 包已删除。

仍存在的已知取舍见 `docs/workflow-engine.md` 的「现状与限制」（new Function 非沙箱、Agent 节点无工具循环、Retriever 仅关键词检索、HumanInput 挂起态在内存等）。

## 配置

- 环境变量：`.env`（模板见 `.env.example`）；基础设施模板 `infra/.env.example`
- 技能库 / 人格库根：`~/.agents/`（`skills/`、`agent-library/`，可用 `DAGENTS_SKILL_DIRS` / `DAGENTS_AGENT_LIBRARY_DIRS` 覆盖）
- 认证：无登录（本机模式）。Gateway 默认开放；如需对外暴露可设 `GATEWAY_API_KEY`（16+ 字符 bearer key）
