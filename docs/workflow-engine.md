# Workflow 引擎（@dagents/workflow）

> 本文是 dagents flow 系统的架构与设计文档：它做了什么、优点是什么、执行模型如何运转、哪些能力已到位 / 仍有限制。

## 总览

```
console (Next.js)                      画布编辑器（自研 Canvas Kit，见 canvas-replacement-architecture.md）
   │  BFF（/api/* 直转发网关；Flowise 伪装层已随 vendor 拆除）
   ▼
gateway (Hono)                         装配执行上下文（DB / LLM / 工具 / 检索）
   │
   ▼
@dagents/workflow — DagExecutor        DB-free 的 DAG 执行引擎
   │
   ▼
llm_providers 表 → OpenAI 兼容 API     Agent (CLI)（platformAgent）节点 → tool-calling 循环
```

- **引擎**：`packages/workflow`（自研，替代 Flowise agentflow 引擎）
- **画布**：自研 Canvas Kit（`apps/console/src/components/flow-canvas/`，2026-09-05 替换 vendor/agentflow —— 决策与实施记录见 `canvas-replacement-architecture.md`）；页面装配在 `canvas/canvas-kit-page.tsx`
- **持久化**：flow 定义存 Postgres `flows` 表（`flow_data` JSONB = ReactFlow 的 nodes/edges/viewport）；每次运行写 `runs` + 每节点一行 `run_node_spans`

## 设计优点

### 1. 引擎与编辑器解耦，DB-free + 依赖注入

引擎不直接碰数据库：LLM client、agent 拉取器、工具注册表、历史检索器、SSE 流、AbortSignal 全部通过 `IExecutionContext`（`packages/workflow/src/types/execution.ts`）注入，由 gateway 装配（`apps/gateway/src/routes/workflow-clients.ts`）。画布编辑器通过 BFF 协议适配层连接（`apps/console/src/app/api/flowise/api/v1/nodes/route.ts` 把 `CANVAS_NODES` 转成 Flowise schema）。两侧可以独立升级替换。

### 2. 一份节点元数据，三处复用

画布节点面板、运行时节点注册表、AI 建流（`@workflow` 命令 / 画布生成对话框）的节点参考清单，共用 `packages/workflow/src/nodes/node-registry-canvas.ts` 的 `CANVAS_NODES`。加一种节点只改一处，不会出现"画布上有但引擎不认"的漂移。

### 3. 并行波次调度 + 条件路由 + 真循环

`DagExecutor`（`packages/workflow/src/engine/executor.ts`）：

- **Kahn 拓扑排序 + 环检测**（报出未能参与排序的剩余节点 id 集合 —— 含环及其全部下游，非精确环路径）
- **并行分支**：同一波次（所有入边都已解析的节点）用 `Promise.all` 并发执行；波次按拓扑序推进，`executedNodes` 顺序保持确定
- **条件路由**：边上的 `sourceHandle` 匹配 Condition 节点的 `matched`/`result`（true/false），或 ConditionAgent 节点 LLM 选出的 `selected` 场景名；画布 Condition 节点的数字/Else 锚点（`${id}-output-N`）映射回 true/false 分支；不活跃分支的下游被剪枝跳过，跳过会传递。普通数据节点（输出无 `selected`/`result`）的锚点边默认激活，不再静默剪枝
- **节点配置双形态**（2026-08-16）：画布保存的 `data.inputs.<field>` 与 AI 生成/手写的平铺 `data.<field>` 在执行入口归一化（平铺打底、嵌套覆盖）
- **Loop / Iteration 真执行**：执行器识别 loop 控制节点，抽取从 `loop` / `iteration` 输出锚点可达的子图作为循环体，逐轮执行（旧单锚点图兼容：全部出边视为循环体）：
  - **Loop**：循环 `loopCount`/`maxIterations` 次（上限 `MAX_LOOP_COUNT`，默认 10；env 配成非数字时回落 10），每轮把上一轮的最终输出喂给下一轮；可选 `condition`（对 `$flow.state` 求值的 JS 表达式）提前跳出
  - **Iteration**：对 `items` JSON 数组逐项执行（上限 100 项，超出截断），每轮种子是当前项；`iterationIndex` / `iterationItem` / `iterationCount` 写入运行时状态，模板变量可引用
  - **有界并发（2026-10-04）**：iteration 节点 `concurrency` 输入（默认 1 = 串行；1-8）逐项并行——每项独立 runtime 覆盖层 + executedNodes 收集器，完成后按项序归并（确定性保持）；断点游标只沿连续完成前缀推进；体内嵌套迭代自动回退串行
  - **whileCondition 提前收敛（2026-10-04）**：iteration 节点可选 JS 表达式（经 `user-code-exec` worker 硬化求值，`$input`/`$inputText`/`$flow` 作用域）——每项完成后求值，真值即停止剩余项（「循环直到 X」的原生表达，仍受上限保护）；聚合输出带 `earlyExit` 标记；声明 whileCondition 时强制串行
  - **⚠️ 循环体内取当前项的正确姿势（2026-10-04 e2e 实弹）**：body 首节点单入边拿到的是**content 字符串**（引擎既有合并约定），`$input.item` 恒 undefined——当前项经 `$flow.state.iterationItem`（customFunction）或模板 `{{iterationItem}}`（prompt）取用；whileCondition 的 `$input` 则是 body 最深节点的输出对象（`$inputText` 其 content）
  - 聚合输出 `{ iterations, completedIterations, content }` 经 `result` 锚点流向下流（聚合输出无 `selected`/`result` 键，result 锚点边默认激活）
- **失败分支隔离（2026-10-04）**：任意节点可声明 `isolateFailure: true`——失败只塌缩本分支（下游因拿不到输出走 skipped 剪枝），run 不中断，终态 `partial_success`（有产出 + 带失败节点）；未声明的失败保持「整 run 失败」默认语义
- **显式最终输出（2026-10-04）**：节点声明 `finalOutput: true` 压过「拓扑最深节点」默认；多个显式节点并存时拓扑更深者胜
- **run 级 token 预算（2026-10-04）**：`POST /workflows/:id/run` body 可带 `tokenBudget`——波次结算后对账，越线即停，终态 `budget_exceeded`（产出截至停机点，错误消息带对账数字）

### 4. Agent (CLI) 节点与内联工具

- `Agent (CLI)`（注册名 platformAgentAgentflow）节点按 UUID 引用平台上注册的 Agent，运行时拉取 instructions/model/skills 驱动完整 tool-calling 循环（maxIterations 封顶 + token 用量累计）；引用关系保护 Agent 不被误删（`utils/agent-refs.ts`）
- `Tool` 节点在图上定义工具（名称 / 描述 / JSON Schema / JS handler）：到达时执行一次 handler，同时注册进本次运行的 toolRegistry 覆盖层，供下游 Agent 节点调用
- gateway 提供内置工具基座（`http_request`、`datetime_now`），每个 run 都可用
- toolRegistry 是按 run 的浅拷贝覆盖层（executor 内创建），Tool 节点的注册不会泄漏到其他 run

### 5. 全链路流式

- `SseStreamer`（`packages/workflow/src/engine/sse-streamer.ts`）是**实时队列**：附流前缓冲、附流后直推，`end`/`error` 自动关流
- 帧格式 `event: <type>` + `data: {"event":..,"data":..}` JSON envelope，与 console 的解析器（`apps/console/src/lib/sse.ts`）严格对齐
- `LLM` 节点在末节点 + SSE 在场时走 `llmClient.chatStream` 逐 token 推流（OpenAI 兼容 SSE 解析，见 `workflow-clients.ts`），否则退回单次 `chat`
- 聊天侧 flow 执行（`GET /api/v1/chats/:id/stream`）传齐全部执行依赖（input / llmClient / agentFetcher / toolRegistry / historyRetriever），结束后发 `end` 帧，并把助手回复写入 `chat_messages`（刷新不丢历史）

### 6. 节点级可观测 + Langfuse 落库

- 每次 run 写一行 `runs` + 每个执行节点一行 `run_node_spans`（状态 / 起止 / 耗时 / token / cost / input / output），console Inspector 按节点渲染
- **Iteration/Loop 终态可见**（2026-08-27）：controller 节点在体内执行完成后重发 `onNodeEnd`，span 的 `output` 落聚合终态（`completedIterations` / `iterations`），`ended_at` = 整轮循环真实完成时刻（此前 span 定格在 start 快照，终态字段永久丢失——6 例既有 e2e 失败的根因）
- **失败节点也记 tokens**：被看门狗清理/取消的 CLI 调用把已产生 usage 附着到错误对象（`workflow-clients.ts`），executor 失败路径拾取落 span
- **Langfuse 导出已接通**（v2 兼容）：`packages/shared/src/langfuse.ts` 把 executed nodes 组装成 trace + generation/span 事件，POST 到 v2 的 `/api/public/ingestion`（v2 无 OTLP 端点，这是 SDK 同款 REST 路径）；成功后把 trace_id（= runId）回填到 `run_node_spans.trace_id`
- 开启方式（默认关）：在根 `.env` 填 `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`（UI → Settings → API Keys 申请），重启 gateway

### 7. 融进聊天的一等公民

- 聊天可绑定 flow；`@flow <name>` 强制走 flow；`@workflow` 命令用 LLM 从自然语言生成 FlowData 存库并回画布链接（失败回退最小 Start→LLM→DirectReply 流）
- `Retriever` 节点经注入的 `historyRetriever` 做当前会话的关键词检索，输出 `docs` + 拼接好的 `content`，可直接接 LLM 节点做上下文增强
- **HumanInput 人机协同**（`apps/gateway/src/routes/human-input.ts`）：聊天中执行的 flow 遇到 HumanInput 节点会挂起——写一条系统消息提示需要输入、在 SSE 流上发 `custom:human_input` 事件，然后等用户的**下一条聊天消息**作为回答（消息路由会拦截并回执 `human_input_ack`），挂起的流在同一个 SSE 连接上继续；超时（`HUMAN_INPUT_TIMEOUT_MS`，默认 5 分钟）则节点明确失败。非交互的 `POST /workflows/:id/run` 走 `state.humanInputs`（按 prompt 键）预置答案，缺答案时报错引导
- **ExecuteFlow 子流程**（`workflow-clients.ts` 的 `createFlowExecutor`）：加载目标 flow 并用父 run 的同一套 clients（LLM/工具/检索/人机输入）执行，上游输出自动作为子流程输入；嵌套上限 3 层（防自引用死循环）；子流程的 executed 节点会合并进父 run 的 span 落库与 Langfuse 导出；子流程不向父流推送 token（避免交错半截回复）

## 执行模型速查

| 机制 | 行为 |
|---|---|
| 同波次节点 | 并发执行（`Promise.all`） |
| 分支剪枝 | 条件不匹配的边不激活；无活跃入边的节点跳过并传递 |
| 多入边合并 | 单入边取 `content` 字符串；多入边浅合并 + content 换行拼接。**下游消费契约（2026-08-27）**：LLM / PlatformAgent 节点优先取拼接后的 `content`，仅当其缺失时回退 `text`（浅合并的 `text` 只剩最后一条边）——N 进 1 汇总不再丢上游 |
| 失败语义 | 波次内失败：记录后整次 run 置 failed（同波其余节点跑完） |
| 空产出守卫 | LLM / PlatformAgent 节点最终正文为空（trim 后 0 字）即抛错、节点标 failed——诚实失败优于空壳成功流向下游（真实复跑曾出现 180s 后 content="" 且 status=done） |
| CLI 执行时长 | **无墙钟上限**（2026-08-27 产品决策）：仅静默看门狗 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（默认 300s，逐行输出即重置）；非完成状态（timeout/aborted/cancelled/failed）一律抛错，usage 附着到错误对象、失败节点 span 仍记 tokens |
| finalOutput | 拓扑序最深的已执行节点的输出 |
| AbortSignal | 波次间与循环轮间检查；HTTP LLM 调用带 `LLM_HTTP_TIMEOUT_MS`（非流式总预算 / 流式空闲看门狗）+ signal；CLI 调用接 signal（SIGTERM→SIGKILL） |
| 循环体边界 | `loop`/`iteration` 锚点可达子图；`result` 锚点承接聚合输出；**体内完成后重发 `onNodeEnd`**——controller 终态 span 含 `completedIterations`/`iterations`，endedAt 反映整轮真实耗时 |
| HumanInput（聊天） | 挂起等下一条用户消息；系统消息 + `custom:human_input` SSE 事件；超时失败 |
| HumanInput（API run） | `state.humanInputs`（按 prompt 键）预置答案，缺失即明确报错 |
| ExecuteFlow | 子流程共享父 run clients；深度上限 3；span 合并进父 run；不向父流推 token |

## 现状与限制（诚实清单）

> 这一节记录的是**仍真实存在的设计取舍**及其升级路径——不是待办清单。已修复的问题会从这里移除。

- **JS 执行（CustomFunction 已硬化，2026-09-06；2026-10-04 纠偏）**：CustomFunction 在 worker_threads 执行（`user-code-exec.ts`）—— 超时强杀（默认 5s，`CUSTOM_FN_TIMEOUT_MS`）、AbortSignal 贯穿、危险全局（require/process/globalThis/fetch/Worker）形参遮蔽。**这是隔离不是沙箱**：刻意逃逸（constructor 链）拦不住；多用户化之前需换 isolated-vm/子进程级真沙箱。（旧条目称「Tool handler 与 Loop condition 仍是同步 new Function」已过时——Tool/Loop/conditionAgent/retriever 节点随 D8 精简删除，仓内唯一用户 JS 是 CustomFunction；2026-10-04 起 iteration 的 whileCondition 求值也走 user-code-exec 硬化路径）
- **Retriever 已随 D8 删除（2026-10-04 补位）**：会话上下文改为 LLM 节点 `includeChatHistory` 输入——宿主注入的 `historyRetriever`（`workflow-engine-service.ts`）做「关键词命中 ×3 + 时间衰减 ×2 + 同会话 +2」混合排序，作用域 = 当前会话 + 同目录其他会话（近 7 天）。接向量库时替换该实现即可（节点契约不变）
- **HumanInput 的挂起状态在 gateway 内存里**（单进程本机模式）：gateway 重启会丢挂起中的输入（流随超时失败）；boot 清扫把悬空 chats/runs 收敛为 failed + 留 system 提示，**且 2026-09-06 起 boot 会把「聊天最后一条是 human_input 提示」的会话补一条中断说明**（历史不说谎）；挂起中的 run 本身不可恢复（恢复 = 持久化整个 DAG 执行态，单机不立项）。（旧条目称「前端暂未渲染专用输入框」已过时——悬浮副驾 F6 早有内联应答条，2026-10-04 聊天详情页对齐补齐：SSE `custom:human_input` 事件清 sending + 末条为 human_input 提示时输入区上方常驻应答条）
- **Langfuse 需手工申请 keys**；未配置时导出静默关闭，不影响 run
- **LLM 请求与 CLI 执行的超时与显式取消**（2026-08-22 执行取消 spec；2026-08-27 修订超时策略）：HTTP 调用带 `LLM_HTTP_TIMEOUT_MS`（默认 120s，流式为空闲看门狗）；CLI 执行**不设墙钟上限**（Agent 自主长跑是常态——曾有 4 路并行 Agent 在 180s 墙被截断成「部分文本 + done」的假成功），全部 CLI 路径只保留静默看门狗：inline 聊天 `INLINE_INACTIVITY_TIMEOUT_MS`、工作流节点 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（均默认 300s，逐行输出即重置）；看门狗触发或显式取消 → 非完成状态一律抛错（节点 failed、span 记录原因与已产生 tokens）。用户显式取消经 `POST /chats/:id/cancel` / `POST /workflows/runs/:runId/cancel` → 内存执行注册表 → AbortSignal → adapter SIGTERM/SIGKILL；**dispatch/daemon 远程任务取消已补齐（2026-09-06，spec §7 还债）**——chat/run 取消级联名下非终态任务（queued/claimed 直接终态、running 打 `cancel_requested_at` 标记），daemon 事件流循环 2s 轮询发现即 abort 子进程并以 failTask('cancelled') 收尾；@daemon 命令现在落真实 runs 行（取消可级联、boot 可收敛、usage rollup 不再跳过）。仍存的取舍：SSE/WS 掉线**不**隐式取消（显式取消才停）
- **普通 Agent 节点无工具循环**：`agentAgentflow` 是单次 LLM 调用（不读 tools/maxIterations）；需要工具循环用 `platformAgentAgentflow`

## 2026-10-04 多人格优化轮（12 项）

> 十二个人格视角（内置人格库选角）对工作流系统的专项优化；引擎语义改动均有
> `executor-v2-semantics.test.ts`（17 例）钉死。

| # | 人格 | 交付 |
|---|---|---|
| 1 | Backend Architect | 失败分支隔离（`isolateFailure` → `partial_success`）+ 显式 `finalOutput` 指定 |
| 2 | Prompt Engineer | LLM 节点 `outputSchema` 输出契约（schema 编入 system + 解析校验 + 一轮修复重试 + `json` 字段供 `{{id.json}}`）+ 多入边合并 64KB 截断（`DAGENTS_MERGE_CONTENT_CAP`，保头尾+省略标记） |
| 3 | AI Engineer | `includeChatHistory` 混合会话检索（关键词×3 + 时间衰减×2 + 同会话+2；pgvector 升级路径=换 `historyRetriever` 实现） |
| 4 | Reality Checker | golden/property 测试网：`executor-v2-semantics.test.ts` 钉新语义 |
| 5 | AppSec Engineer | 诚实清单纠偏（Tool/Loop 已删，唯一用户 JS 已硬化）+ whileCondition 求值复用 user-code-exec |
| 6 | DevOps Automator | iteration `concurrency`（1-8 有界并行，项序归并保确定性）+ run 级 `tokenBudget`（→ `budget_exceeded`） |
| 7 | Frontend Developer | 校验错误画布高亮（`applyRunStates` 标红问题节点 + 悬停错误）；子图折叠待立项（需产品/设计输入） |
| 8 | Analytics Reporter | `GET /workflows/:id/analytics`（节点类型×执行/失败率/平均/P95/tokens + 近 30 run 趋势）+ FlowRunsPanel「节点画像」表 |
| 9 | Product Manager | iteration `whileCondition`（「循环直到 X」原生表达）+ 生成器词汇更新 |
| 10 | UX Researcher | 聊天详情页 HITL 应答条（对齐悬浮副驾 F6） |
| 11 | Codebase Archaeologist | `flow_versions` 版本快照链（结构保存自动存档近 20 版、回滚先存档可撤销）+ 画布「版本」面板 |
| 12 | Agents Orchestrator | `executeFlowAgentflow` 子流程一等节点复活（引擎 DB-free，宿主注入 `flowExecutor`；同 runId 子引擎 spans 并入父 run；深度上限 3 + 祖先链防环）；运行谱系——runs 列表带 `resumedFromRunId`，FlowRunsPanel 续跑行缩进 + ↩ chip |

**端到端验证（2026-10-04，dev 网关黑盒 16 断言全过）**：子流程执行/输出承接、迭代并发聚合、
失败隔离（partial_success + 下游剪枝 + runs 可见）、whileCondition 提前收敛（earlyExit）、
finalOutput 指定、版本快照/回滚往返（回滚先存档）、analytics 出数。过程中实弹逮出两处：
`runs_status_chk` 约束缺新终态（迁移 1720000103000 放宽）与循环体取项陷阱（见上）。

**大图导航纠偏**：画布 MiniMap（可平移缩放）+ Controls 早已在位（flow-editor.tsx）——
「50+ 节点无导航」的旧印象不实；真正缺的只有子图折叠（需产品裁决折叠态是否持久化、
引擎如何对待折叠组，暂不立项）。

新终态语义（runs.status / 引擎 ExecutionStatus）：`partial_success`（有产出 + 隔离失败记账）、
`budget_exceeded`（预算停机，产出截至停机点）——chat 路径分别映射为「完成 + 提示行」与
「停机消息」；画布直跑 200 + 显式 status 字段。

## 关键文件索引

| 关注点 | 位置 |
|---|---|
| 执行器（波次调度 / 循环体） | `packages/workflow/src/engine/executor.ts` |
| SSE 实时流 | `packages/workflow/src/engine/sse-streamer.ts` |
| 执行上下文契约 | `packages/workflow/src/types/execution.ts` |
| 节点注册 + 画布元数据 | `packages/workflow/src/nodes/node-registry-canvas.ts` |
| gateway 装配（LLM/工具/检索/子流程） | `apps/gateway/src/routes/workflow-clients.ts` |
| 人机协同（挂起/回答/超时） | `apps/gateway/src/routes/human-input.ts` |
| run 路由 + span 落库 + Langfuse | `apps/gateway/src/routes/workflows.ts` |
| 聊天流式执行 | `apps/gateway/src/routes/chats.ts`（`GET /:id/stream`） |
| 执行取消（注册表/cancel 端点） | `apps/gateway/src/execution-registry.ts` + `routes/execution-cancel.ts` |
| 统一 AI 生成管线（@workflow + 画布） | `apps/gateway/src/routes/flow-generator.ts` |
| flow 拓扑校验（单源） | `packages/workflow/src/utils/validate-topology.ts` |
| Langfuse 客户端 | `packages/shared/src/langfuse.ts` |
| console SSE 解析 | `apps/console/src/lib/sse.ts` |
