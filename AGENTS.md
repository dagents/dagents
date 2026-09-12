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
- Workflow 画布编辑器：`/workflows/[id]/canvas`（**自研 Canvas Kit `apps/console/src/components/flow-canvas/`，2026-09-05 起**；vendor/agentflow（Flowise fork）已整体退役删除——含 MUI/emotion/tiptap 依赖树、`/api/flowise/*` BFF 与 `convertToFlowiseFormat` 形状税。架构与实施记录见 `docs/canvas-replacement-architecture.md`）
- **画布 Canvas Kit（2026-09-05）**：`@xyflow/react` v12 单运行时依赖；`model/normalize` 读写规范化（读宽容三类存量形状、写统一扁平规范形，golden 测试钉往返）；registry 从 `CANVAS_NODES` 派生 NodeSpec（图标/选项源 console 侧注入：agentId→平台 agents、model→providers+agents）；连线环检测（图环不允许，循环走 Iteration 锚点）；`FlowEditorHandle` 命令式 API；运行态单向注入（节点徽章 + 边状态由 nodeStates 派生，不进文档不落库）。已知防御：Turbopack 不解析 `.js`→`.tsx` 后缀映射（kit 内部 import 无后缀）；RF v12 的 RO→updateNodeInternals 回路在 IAB webview 不触发，FlowEditor 有测量加固。
- **节点体系 D8 精简（2026-09-05，CLI-Agent 核心）**：15→9 类（start / platformAgent（展示名 Agent (CLI)）/ llm / directReply / condition / iteration / humanInput / http / customFunction）。agent/tool/conditionAgent/loop/executeFlow/retriever 六类连同引擎 handler、`flowExecutor`/`historyRetriever` 宿主注入、executor loop 分支一并删除（用户裁决：无真实用户、零兼容包袱）；生成器别名 `agent→llm`、`loop→iteration`、`conditionagent→condition`。`validateFlowTopology` 的 KNOWN_NODE_TYPES 随 allNodes() 自动收敛。
- **`{{$start.input}}` 别名修复（2026-09-06 review 发现的存量引擎 bug）**：executor 此前只把 Start 输出挂在节点 id 键下，resolveAlias 的 `state.start.content` 永远落空（画布运行面板文案宣传的语法实际失效，condition 里写它恒走 False）——Start 节点输出现额外登记 `state.start`（executor.ts，回归测试双向钉住）。
- **生成器 BFF 迁移（2026-09-05）**：`POST /api/flow-generator` 纯透传 gateway canonical（旧 `/api/flowise/api/v1/agentflowv2-generator` 的 vendor 形状转换层已删）；`generate-flow-dialog` 消费 canonical；模型/Agent 下拉由 Canvas Kit 的 option-providers 聚合 `/api/llm-providers` + `/api/agents`。
- **结果面板 v2（2026-08-23）**：节点产出按内容渲染——LLM/DirectReply 的 text/content 双重解包后**正文直出**（DirectReply 的字符串化 JSON 也会二次解包），JSON 降为「原始数据」二级折叠；折叠行内联**正文预览**（首行截断）；**tokens 徽章** ↑输入↓输出（CLI 兜底 client 此前丢 usage，现已从 result.usage 聚合返回，双命名 prompt_tokens/inputTokens 兼容）；运行中**已完成的节点自动展开**（用户手动收起则记住不强开）。进度分母 = 流程总节点数（initialFlowData），非已出现 span 数。
- **画布运行项目目录（2026-08-23）**：运行输入面板含**项目目录选择器**（`dagents.canvas.runDir` 记忆）。run body `directoryId` → gateway 解析 `directories.path` → `createDefaultLlmClient('claude', { cwd })` 闭包注入 → 所有 LLM/Agent/PlatformAgent 节点的 CLI 在选定项目目录执行（此前 CLI 一律在网关进程 cwd 跑——Agent 在错误的项目里干活）。chat 流式路径同样注入会话绑定目录的 cwd。HTTP provider 路径不受影响（无文件系统语义）。
- **画布异步运行（2026-08-23）**：`POST /workflows/:id/run?async=1` —— 先落 status='running' 的 runs 行、后台执行、**立即返回 runId**（同步等待会让 5-9 分钟的多 Agent 链撞上代理层 300s 超时，客户端误报失败）。画布统一走 `watchLoop` 轮询终态；任一 span failed 时**立即**置失败态并提示节点名（不等 runs 行落库）。结果面板：运行中显示「正在执行：节点X（n/m 完成）」呼吸行 + 节点开始时间 + 输入折叠。
- **画布运行输入 + 运行结果面板（2026-08-23）**：点「▶ 运行」先弹输入面板（输入作为 `{{$start.input}}` 传入，支持 `{{<节点id>.output}}` 引用；⌘⏎ 快捷运行）——不再空跑。顶栏「运行结果（n）」按钮打开逐节点面板：状态点（旋转/绿/红）+ 耗时 + 展开看产出 JSON（`latestSpans` 来自 node-spans 轮询，旁观模式同样可用）。
- **画布旁观任意运行（2026-08-23）**：画布页支持 `?run=<runId>` 自动旁观任意运行（chat @flow 触发的也行）；入口在 chat 详情右栏「执行记录」和 Flows 详情页的「画布查看」。chat 流式执行路径（`GET /chats/:id/stream`）与画布直跑共用 `span-writer.ts` 增量进度（按节点串行化防终态被并发 start 覆盖；`run_node_spans` 有 `(run_id,node_id)` 唯一索引 + 幂等 upsert），并在结束后补写 `runs` 行（chat 触发的运行从此进 flow 运行历史）。连线随进度点亮：完成段静态绿、活动段 dash 流动（`canvas-kit-page.tsx` 移植版，边状态现由 FlowEditor 从 nodeStates 单向派生）。node-spans 读端点附带 `runStatus/runDurationMs` 供旁观端判断终态。
- **画布内运行 + 节点实时进度（2026-08-22）**：画布顶栏「▶ 运行」自带 `x-run-id` 请求头发起 POST（run 端点接受客户端 runId），同时 700ms 轮询 `GET /runs/:runId/node-spans`，把节点状态刷到节点徽章（running=旋转 / done=绿勾 / failed=红叉，自研 Canvas Kit）。数据源是引擎新钩子：`DagExecutor.execute` 的 `onNodeStart/onNodeEnd` → gateway `run_node_spans` 增量 UPDATE-then-INSERT（事后批量落库跳过已写节点防重复）。引擎钩子测试在 `packages/workflow/src/__tests__/executor.test.ts`。
- Workflow 引擎文档：`docs/workflow-engine.md`（架构 / 执行模型 / Langfuse 开启方式 / 已知限制）
- LLM Provider CRUD + 动态代理转发
- **中英双语（2026-08-16）**：自然键 i18n（`apps/console/src/i18n/`）——中文文案即 key，`en/` 词典分模块维护（common/agents/flows/daemons/settings/chat），缺译自动回退中文；`useI18n()` 无 Provider 也能用（默认 zh）。语言切换在设置页「通用 · 外观与语言」tab（2026-09-06 从侧栏底部移入；`dagents.locale` 持久化，明暗切换同页同 tab —— `ThemeSettingControl`/`LocaleSettingControl` 分段控件，旧侧栏 ThemeToggle/LocaleToggle 按钮已删）。新增界面文案直接写中文并用 `t('中文')` 包裹，英文词条加到对应 `en/*.ts`。
- 技能库（registry-not-database）：`~/.agents/skills` + `DAGENTS_SKILL_DIRS` + console 界面直接添加目录（持久化 `~/.agents/skill-dirs.json`，`POST/DELETE /api/v1/skills/roots`），`GET /api/v1/skills`，console `/skills` 页；不落库、正文不缓存。Agent 挂载的技能在执行时注入 system prompt（inline chat + workflow PlatformAgent，见 `skill-injection.ts`）。详见 `docs/skills-registry.md`
- **agent-templates 已退役（2026-08-23，方案 B）**：原「从模板创建」的 5 个静态模板翻译为人格库「快速开始」分区（`apps/gateway/quickstart-library/`，内置库根 rank 50，frontmatter `kind`/`model` 为建议运行时）。instantiate 默认采用人格建议（请求体可覆盖）；人格库确认步新增运行时/模型档位选择器。Agents 页只剩「新建 Agent」+「从人格库启用」两个互补入口。`routes/agent-templates.ts` 与 console 的 gallery/lib/BFF 已删除（flow-templates 是另一套，未动）。
- **Agent 人格库（2026-08-19）**：同一 registry-not-database 模式承载 agency-agents 人格库（默认根 `~/.agents/agent-library`，软链到 clone 即挂载；`DAGENTS_AGENT_LIBRARY_DIRS` + `POST/DELETE /api/v1/agent-library/roots`）。**库/目录分离：人格住文件系统，agents 表只装「已启用」的**（`POST /api/v1/agent-library/:division/:slug/instantiate`，默认 kind=claude + slim 三档编译 + 语言包络 + `library_meta` 溯源），`@workflow` 清单注入天然不爆（另有 80 条防御上限）。上游同步 = 挂载目录 `git pull` + `GET /drift` 三态 + `reimport`（覆盖 instructions、id 不变、工作流引用不失效）。console：/agents 页「从人格库启用」。**团队场景模板（Phase 3；2026-08-31 扩至 agency-agents 全量工作流）**：`GET/POST /api/v1/agent-library/team-templates*`，9 个多 Agent 模板覆盖 agency-agents 全部 10 条文档化工作流（README Scenario 1~6 + examples/ 的落地页冲刺、全机构并行发现 8 路 fan-out、书籍章节起草；startup-mvp 按 examples 版增强为 7 人格并行发现头，with-memory 变体不立项——边数据流已天然取代其 copy-paste 交接）。按人格 name 解析成员 → 复用/自动启用 → 生成 draft flow（start 节点带 inputHint/inputExample 运行输入引导，画布/列表运行面板与确认步透出）。形态三选 `linear` / `fan-out` / `parallel-head`（前 N 步从 Start 并行扇出、汇入顺序尾，吃 N 进 1 合并契约）（注意：teams 路由须在 `/:division/:slug` 前注册）。中文人格衍生库在 `~/.agents/agent-library-zh`（不挂载；同名覆盖语义见其 README）。详见 `docs/agent-library.md`
- **流程模板中心（2026-08-20）**：三层模板收拢 —— 内置（`gateway/src/flow-templates/builtin/*.json`，import 内联含 `with { type: 'json' }`，社区 PR 见其 README）/ 团队场景（agent-library）/ 我的模板（画布顶部操作条「另存为模板」→ `flow_templates` 表）。`POST /api/v1/flow-templates/:id/instantiate` 按 personaName 重绑（复用/自动启用），未命中降级 LLM 节点（模板零依赖可跑）；`builtin/<slug>` 含斜杠有专属路由形态。console：/flows「从模板创建」三 tab 画廊。详见 `docs/flow-templates.md`
- **模板参数化（2026-08-22，产品方案 G）**：节点文案里的 `{{变量名}}`（支持中文，与引擎变量语法共用）在「另存为模板」时扫描入 `flow_templates.params`；实例化确认框表单回填（`answers`），缺省回落 defaultValue/空串，未声明占位符保留原样交给引擎运行时解析。
- **统一 AI 生成管线（2026-08-22，产品方案 A1/A2/A5）**：chat `@workflow` 与画布 GenerateFlowDialog 共用 gateway 单一服务 `routes/flow-generator.ts`（CLI 优先/HTTP 兜底，canvas 可指定 `providerId::model` 或 `agent::<id>` 引擎；别名归一 → `@dagents/workflow` 的 `validateFlowTopology` 拓扑校验 → 一轮修复循环 → **显式失败，静默兜底已删除**；每次生成写 `generator_attempts` 埋点）。console BFF 只做 vendor 形状适配（薄代理 `POST /api/v1/flow-generator/generate`）。画布保存走同一校验器做非阻断干跑警告。
- **执行可取消 + 超时（2026-08-22，产品方案 B / 执行取消 spec；2026-08-27 修订 CLI 时长策略）**：HTTP LLM 调用超时 `LLM_HTTP_TIMEOUT_MS`（默认 120s，流式为空闲看门狗）；**CLI 执行不设墙钟上限**（Agent 自主长跑是常态，曾有 4 路并行 Agent 在 180s 墙被截断成「部分文本 + done」假成功）——inline 聊天 `INLINE_INACTIVITY_TIMEOUT_MS`、工作流节点 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（均默认 300s 静默看门狗，逐行输出即重置）；看门狗触发/取消 → 非完成状态（timeout/aborted/cancelled）诚实抛错，usage 附着错误对象、失败节点 span 仍记 tokens；显式取消 `POST /api/v1/chats/:id/cancel` 与 `POST /api/v1/workflows/runs/:runId/cancel` → `execution-registry.ts` 内存注册表（单进程红线）→ AbortSignal 贯穿引擎/llmClient/adapters（SIGTERM→SIGKILL）→ `chat:cancelled` WS 帧 + `persistCancelled`；gateway boot 清扫悬空 running（chats/runs→failed）。console 停止按钮接真取消。**dispatch/daemon 远程任务取消未做**（spec §7 Deferred）。适配器维护分级单源在 `packages/agent-adapters/src/tiers.ts`（core：claude/codex/qwen）。
- **多实例 CLI 协作引擎修复（2026-08-27，真实复跑驱动）**：对「产品发现（并行）」（7 节点菱形，4 并行 claude 实例）做真实复跑暴露三个 mock 测不出的引擎缺陷并已修复——①**N 进 1 合并契约**：`mergeInputs` 拼接 `content`，下游 LLM/PlatformAgent 节点优先取 `content`（`text` 被浅合并覆盖只剩最后一条边；修复前汇总节点丢 N-1 份上游产出，e2e WF-09 钉住）；②**空产出守卫**：LLM/PlatformAgent 空正文抛错标 failed，不再假成功（WF-10/11）；③**Iteration/Loop 终态 span**：controller 体内执行完成后重发 `onNodeEnd`，`completedIterations`/`iterations` 落库、endedAt 为整轮真实耗时（OB-05/MA-06/07/16/ED-03/04 六例既有 e2e 失败全部转绿）。真实终验：汇总节点 209s（> 旧 180s 墙）正常完成、四份简报全到达、逐节点 tokens 完整。详见 `docs/workflow-engine.md` 执行模型速查。
- **执行态 e2e（2026-08-19）**：`apps/console/tests/e2e/` spec 11~15（57 用例：工作流执行契约（含 WF-09~11 合并/空产出回归钉）/ 多 Agent 协作 MA-01~18 / 聊天触发 SSE / 边界 / UI 旅程），地基是 **Mock LLM Provider**（`tests/e2e/fixtures/mock-llm-server/`，OpenAI 兼容 + `/__control/*` 控制面，端口 4010，playwright webServer 自动拉起）。`seedMockLlmProvider` 会临时切换 dev 库的 active provider —— **测试中途强杀可能残留 `e2e-mock-%` 行，导致真实 LLM 调用指向死 mock；清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`**。DAG 构造用 `tests/e2e/helpers/flow-builder.ts`（平铺 `data.<field>`）。专用测试库 `dagents_e2e` 已建（全栈隔离需 gateway 以 `POSTGRES_URL=…dagents_e2e` 启动，见 `tests/e2e/README.md`）；CI 在 `.github/workflows/e2e.yml`。详见 `docs/e2e-test-plan.md` §12 执行记录。
- **Workflow-First IA 反转（2026-08-29，PRD `docs/prd-workflow-first.md` v1.1 已评审）**：`/` = Flows 工作台（空态三入口：团队场景模板 / 一句话生成 / 空白画布，`flows-empty-hero`）；新主导航 `app-nav-sidebar`（工作流 / Agents / 技能 / Daemons + 项目维度会话树 `chat-history-tree`；**模板不占导航位**——原 `/templates` 路由与「模板」tab 已删（2026-08-29 用户裁决），入口收敛到工作流工具栏「从模板创建」按钮 + Hero 三入口；运行历史同理不占导航位，见下条）；**Chat 降为全局悬浮副驾**（`floating-chat` 除 `/chats/[id]` 外全路由常驻，可拖动/拉大/位置记忆，画布页避让 minimap，历史抽屉承接旧会话树，HITL 内联应答条）；执行核心收敛到 `use-chat-execution`（F0 单一实现，WS 帧语义 `applyChatFrame` 纯函数可复用）；`@workflow` 生成落点 toast+直达（toast 支持 action 按钮）；gateway `GET /api/v1/runs` 端点新挂载（跨流查询 + 失败原因摘要；页面形态演进见「运行历史进 flow 卡片」条）。**回滚通道**：`localStorage dagents.ia.workflow-first=off` 恢复 Chat-First 首页+旧侧栏（e2e IA-04 钉住；flag 存续期 ≤1 迭代）。e2e：01/03/08 重写为新 IA 断言 + 新增 19 号冒烟（IA-01~04）。
- **列表页运行异步化 + 运行输入面板 + 详情页进度轮询（2026-08-29）**：Flows 列表「运行」按钮此前 POST 同步 run 端点 —— HTTP 响应被压住直到整个流程跑完（CLI Agent 动辄几分钟），期间无跳转无进度，用户感知「点了没反应」；含 HumanInput 节点的流程更是永久挂起。现在三点闭环：①点「运行」先开 `flow-run-dialog`（输入作为 `{{$start.input}}` 传入 + 项目目录选择器，记忆键与画布共用 `dagents.canvas.runDir`）；②提交走 `?async=1` 立即返回 runId 并打开详情页；③详情页 node-spans 从一次性拉取改为 **1.2s 轮询到终态**（终态依据 runs 行 runStatus，`fetchRunNodeSpans` 现返回 `{spans, runStatus}`；无 runs 行的旧运行退化为画布同款启发式收尾），终态时 toast + 刷新详情/列表，打开旧运行详情不重复打扰。e2e WF-12 钉住整条 UI 旅程。
- **运行中活动流（2026-08-30）**：真实复跑发现 PlatformAgent 节点 running 期间 output 恒空 —— 根因是 CLI agent 干活的大头在 thinking 和工具调用，text 事件要到收尾才出现，此前的 delta 通道只转发 text（旁观端全程「（执行中…）」黑盒）。修复：onNodeDelta 载荷结构化 IStreamDelta（text 正文增量 | activity 过程活动），CLI client 把 thinking（截 100 字）与 tool-use（工具名+参数摘要 60 字）作为 activity 发射，span-writer 按节点维护 text 缓冲 + activity 环形队列（最近 12 条），节流落 {text, content, activity}；画布结果面板运行中行渲染 💭/🔧 时间线（最近 6 条，mono 小字）+ live 正文，摘要行无正文时显示最近活动。**活动流随终态保留**（onNodeEnd 把 activity 并入最终 output —— 过程回放有审计价值，2026-08-30 用户裁决「跑完即丢等于丢掉它是怎么干的」）。线上探针验证：running 期间 acts≥1（thinking 可见）、终态 text+acts 并存。
- **详情页退役 —— 一次运行一个家 = 画布旁观（2026-08-30 三方协商：PM/设计师/资深用户）**：原列表内详情页（.flow-detail-page，DAG 缩略 + inspector）与画布旁观 80% 功能重叠且入口不对称（详情页唯一入口是发起运行后自动落地，返回即不可回访），用户分不清两个视图。定稿收敛：发起运行（列表「开始运行」后）直接 router.push 画布旁观 ?run=，与卡片运行历史行、chat 执行记录入口完全一致。删除面：flows-view 详情状态/effects/JSX/NodeInspector/FlowOverview/mapFlowDetail/hash 深链（#flow=&run= 通道随之退役）、flow-dag.tsx 组件、shell.css 详情专属规则 —— flows-view 从 1343 行减到 635 行。轻量瞄状态由卡片 FlowRunsPanel 行承担。e2e：WF-12/UI-01 改 waitForURL 断言（dev 冷编译放宽 15s），UI-02 重写为画布旁观渲染断言，flows-detail 单测文件删除。
- **运行历史进 flow 卡片（2026-08-30 用户裁决）**：/runs 独立页与导航 tab 已删（与模板同理：历史属于 flow 自己的上下文）。列表卡片展开区的静态「暂无运行记录」提示行换为 **`FlowRunsPanel`**（`/api/runs?flowId=` 数据源不变）：紧凑行（状态点+状态文本/触发源 chip/起止/耗时/输入预览/失败摘要/画布旁观直链），空历史才显示提示；发起运行成功即 bump 刷新（新 run 立即可见），存在 running 行时 3s 轻轮询到终态。gateway `runs.ts` 顺手修 inputPreview：JSONB `{"input":"…"}` 解包为文本（此前对象透传，消费端恒显 '—'）。e2e NAV-02 改断言导航无运行历史项，IA-01 重写为卡片展开区断言。
- **节点产出流式展示（2026-08-30）**：运行中的 LLM/Agent 节点边生成边可见，不再黑箱到节点收尾。链路四段：①引擎 `IExecutionContext.onNodeDelta` + executor `onNodeDelta` 钩子（按当前节点绑定，并行波次各报各的）；②LLM 节点流式门控放宽——只要 llmClient 有 `chatStream` 就走流式（此前要求 isLastNode+SSE，画布/详情旁观全程黑箱），SSE token 仍只推末节点；`chat` 参数新增 `onDelta`（PlatformAgent 工具循环每轮生成过程可旁观）；③gateway CLI client 消费 `AgentSession.events` 真逐帧流式（`chatStream` 不再等 result 一次性吐），span-writer 新增 `onNodeDelta`：按节点累积 + 1s 节流 `UPDATE run_node_spans SET output`（`WHERE status='running'` 守卫，永不覆盖终态全文）；④console：画布结果面板 running 行自动展开 + live tail 单行预览 + 光标呼吸动画（`.canvas-result-text.streaming`），详情页 inspector 输出正文直出（`{text,content}` 解包）。e2e WF-13 钉死全链路（慢速 mock 流中途轮询断言 running+partial、终态全文覆盖）。顺手修 mock server 调速 bug：`resolveResponse` 投影漏掉 `streamChunkSize/streamIntervalMs`（注释宣传了但从未生效，慢速流此前测不了）。
- **运行终端视图 + 采集端全量保真（2026-09-06，PRD `docs/prd-run-terminal.md`）**：CLI Agent 的运行结果以终端形式展现，数据先行 —— ①数据层（保真契约「采集层保全文，展示层做策展」）：`IStreamDelta` activity kinds 扩至 thinking/tool/tool_result/status/log/error，CLI client（workflow-clients `forwardActivityDelta`）全事件转发零截断（此前 toolLabel 截 60 字 + thinking 落库前截 100 字 + tool-result/status/log 整体丢弃）；span-writer 双通道 —— `events` 全量过程日志（终端/回放唯一保真数据源，保险丝：单条 64KB / 800 条 / 总量 ~1MB 丢最旧保近因）+ `activity` 12 条环降级为面板策展缓存（summary ≤80 字是展示派生物），落库双节拍（text 1s / events 5s 同刷），终态合并保留。②console：`run-terminal.tsx` 的 `RunTerminal`（段头分隔线 + `$` 提示行 + 统一 Icon 事件行 + 正文全文直出 + streaming 光标 + 段级复制）挂进画布结果面板「摘要/终端」切换（`dagents.canvas.resultView` 记忆，摘要保持默认）；`TerminalSurface`（滚动跟随/上翻暂停/回到底部）被 chat ProcessFold 复用收敛（顺手补 48vh max-height，长过程不再无限撑高聊天流；ToolCallCard 含 diff 保留为终端内富卡片）。用户裁决：切换式不替换默认、全部保真、含 chat 收敛、采集端截断拿掉。明确不做 xterm.js/ANSI（结构化事件流非 pty 字节流，DOM 行渲染）。旧运行无 events，终端视图降级显示 activity 环摘要级内容。**长输出「查看全文」（同日设计师裁决）**：结果面板的输出块被 max-height 小滚动框困住 —— 新共享组件 `result-viewer.tsx`（`ResultViewer` 包装块 + maximize 角标悬浮露出 → 全屏模态：完整未截断正文/JSON + 复制 + Esc/点背景关闭，portal 到 body）；摘要视图四块（正文/产出 JSON/输入/原始数据，模态给全量 stringify 而非 500/900 截断版）与终端视图（成品正文/裸 JSON/事件详情行）全部接入。**图标统一（同日设计师验收追加裁决）**：功能位 emoji 文本标记全部废除（💭🔧↳✗⚡🤖✨⚠ 及 chat 工具卡 🔍✏️💻），统一 `@/components/icon` stroke 体系 —— Icon 集新增 wrench/cornerDownRight/point/sparkles；语义映射三处共用：`lineIcon`（终端）/`activityIcon`（画布摘要活动流）/`CATEGORY_ICON`（ToolCallCard）；`CATEGORY_GLYPH` emoji 表已删；产品约定「Icon 包装 span 不约束 svg，逐面 `.wrapper svg {width;height}` 定尺寸」照抄（run-terminal.css/tool-call.css/canvas.css/workflow-run-card.css/flows.css 五处补规则）；人格库角色头像 emoji 是数据内容不属 UI chrome，保留。
- **可操作终端（2026-09-08，PRD `docs/prd-operable-terminal.md`，用户四项裁决）**：终端视图从旁观窗升级为操作台（bash 四动词「看/停」已有，「说/再来」补齐）——①**运行中插话**：`POST /api/v1/workflows/runs/:runId/message`（nodeId+text）→ execution-registry `ExecutionHandle.sendToNode`（abort 的姊妹控制动词，同步回执 sent/unsupported/not_running）→ workflow-clients 汇点表（`runId:nodeId → 活 CLI 会话`；节点经 `llmClient.chat` 新参数 `nodeId` 上报，llm/platformAgent 节点传 `nodeData.id`；PlatformAgent 工具循环每轮新建会话按 nodeId 覆盖注册、same-sink 守卫防误删）→ contracts `AgentSession.send?` → claude 适配器 `--input-format stream-json`（prompt JSON 帧首帧化 + stdin 常开 + `session.send(text)` 写帧）。**claude 终态语义改静默判定**：openTurns 计数（stdin user 帧开 turn、result 帧关 turn，is_error 即终局），归零才 end stdin——进程在 result 后活着等下一帧是 stream-input 协议行为，不主动收尾运行永不结束；中间 result 的 completed status 抑制（turn 边界非终局）。插话是「排队补话」语义（下一 turn 消化，最终 output = 最后 turn 的 result，不承诺打断）。`user_input` 新 activity kind 经节点 onDelta 通道回写，span-writer 即时落库（不等 5s events 慢节拍）进 events/activity 双通道，终端渲染 `❯` accent 高亮行（回放审计「谁在何时对哪个节点说了什么」）。console `TerminalInputBar` 钉终端视图底部：`❯` 提示行 + 多 running 节点目标 select + 诚实三态回执 + 结束态原位变「重跑」入口；chat ProcessFold 不加（聊天输入框即其 stdin 行）。逃生门 `DAGENTS_CLAUDE_INPUT_FORMAT=text` 回退旧一次性 stdin；逐适配器放行（codex exec 一次性不支持 → 如实禁用）。②**重跑闭环（⬆ 等价物）**：运行输入按 flowId 记忆（`dagents.canvas.runInput.<flowId>`，画布运行面板与 FlowRunDialog 共键，打开预填、提交即记）；gateway runs 列表新增 `input` 全文字段（8k 保险丝——inputPreview 80 字只够展示）；FlowRunsPanel 历史行「重跑」按钮 → 预填对话框（输入可再编辑，⌘⏎ 已有）。③ BFF `/api/workflows/runs/[runId]/message` 透传 + node-spans 端点增 `inputSupported`（无 CLI 汇点 → stdin 行禁用态给原因，HTTP provider 运行如实不可插话；chat @flow 运行经 registry byRun 次键同样可插话）。**顺手修存量地雷**：canvas 页面图把 @dagents/workflow dist 拉进浏览器包撞上 user-code-exec.ts 的 worker_threads 静态 import（9-06 批次落地、此前无新编译未暴露，canvas 全页 500）——双路置空：next.config webpack resolve.fallback（next build/裸 dev 走 webpack）+ turbopack resolveAlias 指空模块替身 src/stubs/worker-threads-stub.js（dev 脚本 --turbopack 忽略 webpack() 配置，首次重启只修了一路、console 仍 500 即此因）。测试：adapter lifecycle 18 用例（stream-input 四例：argv 断言/静默判定收尾/插话时序（turn1 进行中 send → R2）/text 回退）、gateway message 路由 6 + span-writer user_input 快节拍 2、console format 2；e2e 23 号 spec OT-01~04（重跑全旅程/stdin 结束态/禁用态/BFF 409）；真机 claude 冒烟通过（stream-json 输入被本机 CLI 接受 + 静默收尾）。C 接龙（跨 run 管道）缓议未做。**turn 分隔符（同日真机复跑补钉）**：插话把节点产出拆成多 turn，adapter 在中间 result 帧发显式 `turn-boundary` status（completed 仍只留终局一个），CLI client（chat/chatStream 两路）收到即正文补 `\n\n` 分隔 + 过程流记「── 插话已并入，开始新的 turn ──」——修「40我此刻」粘连；gateway workflow-clients-cli.test.ts 2 用例（可编程后端桩）+ lifecycle 插话用例断言边界事件；真机复跑验证 `40\n\n我收到了…`。另：用户报的「正文空行」经查证为粘贴到富文本编辑器的段落化效果——数据 0 个双换行、页面 pre-wrap 渲染截图核实无空行，非产品缺陷。
- **单机还债批次（2026-09-06 架构师盘点 → 用户裁决「除用户相关外全修」）**：①**dispatch/daemon 远程任务取消**（spec §7 Deferred 补齐）：迁移 `1720000094000` 给 dispatch_tasks 加 `cancel_requested_at`；`cancelDispatchTask`（queued/claimed 直接落终态 failed/'cancelled'，running 打标记）+ `POST /tasks/:id/cancel`（daemon 协议面，白名单已加）；daemon 执行环 2s 轮询 cancelRequested → AbortController 注入 execOptions.signal → 子进程 SIGTERM/SIGKILL → failTask('cancelled')；chat/run 取消端点级联名下非终态任务；**@daemon 命令现落真实 runs 行（path='direct'）**——取消可级联、boot 清扫可收敛、usage rollup 不再跳过。②**CustomFunction worker 硬化**：`user-code-exec.ts` worker_threads 执行（超时强杀默认 5s `CUSTOM_FN_TIMEOUT_MS`、AbortSignal 贯穿、危险全局形参遮蔽）——死循环只死节点不再冻住 gateway；**是隔离不是沙箱**（constructor 逃逸拦不住，多用户前换 isolated-vm；Tool/Loop condition 仍同步）。③**执行轨迹 retention**：`retention.ts` boot+每日清 runs/run_node_spans/dispatch 轨迹（`DAGENTS_RETENTION_DAYS` 默认 90，0 关闭；聊天内容/flow 配置永不清）。④**HumanInput boot 孤儿标记**：`markOrphanedHumanInputs` 把「聊天最后一条是 human_input 提示」的会话补中断说明（挂起 Promise 恢复=持久化 DAG 执行态，单机不立项）。⑤**备份**：`scripts/backup.sh`（pg_dump -Fc + ~/.agents tar，保留 db30/fs10 份，实跑验证过）。⑥**Workflow-First 回滚双壳退役**：`ia-flag`/`ChatHome`/`ChatNavSidebar` 删除，`/` 恒 FlowsView，FloatingChat 只在聊天详情隐藏；e2e IA-04 已删。⑦**dev/build 互踩工程化**：turbo `test` 改 `dependsOn: ^build`（pnpm test 不再建 console 的 .next）；`next.config` 支持 `NEXT_DIST_DIR`（`build:isolated` 写 .next-build 不碰 dev）；根 build/test/typecheck 挂 `scripts/guard-build.mjs`（dev 在跑出警告+出路，`DAGENTS_SKIP_GUARD=1` 跳过，CI 零打扰）。⑧ e2e 兜底：seed dispose 自动清 `e2e-mock-%` provider 残留；**终端视图 e2e**（22 号 spec，RT-01~03：全量事件流/查看全文/旧运行「早于全量采集」提示——派生层新增 `lineSource` 如实标注数据来源）。**明示不做**：多实例（单机单进程成立）、认证多用户（用户裁决排除）。适配器真机回归仍欠（本机无 codex/qwen/codebuddy/copilot CLI，无法跑）。
- **画布布局自动保存（2026-09-06 架构师裁决）**：此前节点坐标/视口虽在文档模型里（serialize 写 `position:{x,y}`+viewport），但**只有显式「保存」才落库** —— 拖完布局刷新即回退。现在布局走独立静默管线：FlowEditor 在拖拽停/视口停后 debounce 800ms 调 `onLayoutPersist`（position 逐帧变更合并到停手后一拍；readOnly 跳过），CanvasKitPage 静默 fire-and-forget `PUT /api/workflows/:id/layout`（BFF 透传），gateway 服务端 merge —— 只更新 flow_data 里**已存在节点**的 position（取整）与顶层 viewport，未知 id 静默忽略，节点配置一字不动；布局无语义价值不进审计日志。脏标记语义不变：布局自动保存不翻脏、不清脏（未保存的配置编辑仍是草稿，全量保存管线原样）；全量自动保存被否（违背「尊重草稿自由」，会把半配置节点静默落库）。e2e `21-canvas-layout-autosave.spec.ts`（CV-LAY-01~03）真实 CDP 拖拽钉全链路 —— IAB webview 的合成输入驱动不了 RF 的 d3-drag 层（连 cua.click 都选不中节点），画布拖拽类交互验证一律走 playwright。
- **侧栏会话树回归项目维度（2026-08-29 用户裁决）**：Workflow-First 主壳的会话历史从扁平「最近对话」列表改回**以项目目录为第一维度的树** —— 旧 ChatNavSidebar 的目录树整体抽成共享组件 `chat-history-tree.tsx`（搜索胶囊/目录重命名删除/每目录新建 ➕/会话重命名删除/HoverCard 预览/显示更多溢出/活动目录自动展开，全套功能单一来源），`AppNavSidebar` 主导航下方与 `ChatNavSidebar`（回滚壳）共用同一实现；样式复用 chat-nav-sidebar.css 的类（含折叠态）。ChatNavSidebar 瘦身为壳（品牌/新建对话/NAV/树/页脚）。e2e UC-NAV-05 重写为目录树断言（分组展开/会话行/详情页 aria-current）。
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
