# Workflow 引擎（@dagents/workflow）

> 本文是 dagents flow 系统的架构与设计文档：它做了什么、优点是什么、执行模型如何运转、哪些能力已到位 / 仍有限制。

## 总览

```
console (Next.js)                      画布编辑器（vendor/agentflow, Flowise 魔改）
   │  BFF 伪装 Flowise API（schema 转换）
   ▼
gateway (Hono)                         装配执行上下文（DB / LLM / 工具 / 检索）
   │
   ▼
@dagents/workflow — DagExecutor        DB-free 的 DAG 执行引擎
   │
   ▼
llm_providers 表 → OpenAI 兼容 API     nodes 里嵌的平台 Agent → tool-calling 循环
```

- **引擎**：`packages/workflow`（自研，替代 Flowise agentflow 引擎）
- **画布**：`vendor/agentflow`（FlowiseAI 官方 `@flowiseai/agentflow` 的 vendored 副本），console 侧经 `apps/console/src/components/canvas/flowise-canvas.tsx` 适配
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
  - 聚合输出 `{ iterations, completedIterations, content }` 经 `result` 锚点流向下流（聚合输出无 `selected`/`result` 键，result 锚点边默认激活）

### 4. 节点里嵌平台 Agent 与内联工具

- `PlatformAgent` 节点按 UUID 引用平台 Agent，运行时拉取 instructions/model/skills 驱动完整 tool-calling 循环（maxIterations 封顶 + token 用量累计）；引用关系保护 Agent 不被误删（`utils/agent-refs.ts`）
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
| 多入边合并 | 单入边取 `content` 字符串；多入边浅合并 + content 换行拼接 |
| 失败语义 | 波次内失败：记录后整次 run 置 failed（同波其余节点跑完） |
| finalOutput | 拓扑序最深的已执行节点的输出 |
| AbortSignal | 波次间与循环轮间检查；HTTP 节点合并超时 signal。LLM 请求**尚未**接 signal（gateway 的 provider fetch 无超时，挂起的上游会挂住 run） |
| 循环体边界 | `loop`/`iteration` 锚点可达子图；`result` 锚点承接聚合输出 |
| HumanInput（聊天） | 挂起等下一条用户消息；系统消息 + `custom:human_input` SSE 事件；超时失败 |
| HumanInput（API run） | `state.humanInputs`（按 prompt 键）预置答案，缺失即明确报错 |
| ExecuteFlow | 子流程共享父 run clients；深度上限 3；span 合并进父 run；不向父流推 token |

## 现状与限制（诚实清单）

> 这一节记录的是**仍真实存在的设计取舍**及其升级路径——不是待办清单。已修复的问题会从这里移除。

- **Tool / CustomFunction / Loop condition 的 JS 执行是 `new Function`**，不是硬沙箱——代码信任对象是 flow 设计者而非终端用户；要对外暴露需换 `isolated-vm` 类方案。CustomFunction 同步跑在主事件循环上（死循环会冻住 gateway）
- **Retriever 目前是关键词检索**（当前会话的 chat_messages ILIKE），不是向量 RAG；接向量库时替换 gateway 的 `historyRetriever` 实现即可，节点契约不变
- **HumanInput 的挂起状态在 gateway 内存里**（单进程本机模式）：gateway 重启会丢挂起中的输入（流随超时失败）；boot 清扫会把悬空的 chats/runs 收敛为 failed 并留 system 提示，但挂起中的 run 本身不可恢复。前端暂未渲染 `custom:human_input` 专用输入框，但系统消息 + 聊天回复已构成完整可用闭环
- **Langfuse 需手工申请 keys**；未配置时导出静默关闭，不影响 run
- **LLM 请求与 CLI 执行已具备超时与显式取消**（2026-08-22，执行取消 spec）：HTTP 调用带 `LLM_HTTP_TIMEOUT_MS`（默认 120s，流式为空闲看门狗）；inline CLI 执行带 `INLINE_INACTIVITY_TIMEOUT_MS`（默认 300s 静默看门狗）；用户显式取消经 `POST /chats/:id/cancel` / `POST /workflows/runs/:runId/cancel` → 内存执行注册表 → AbortSignal → adapter SIGTERM/SIGKILL。仍存的取舍：SSE/WS 掉线**不**隐式取消（显式取消才停）；daemon/dispatch 远程任务暂无取消通道
- **普通 Agent 节点无工具循环**：`agentAgentflow` 是单次 LLM 调用（不读 tools/maxIterations）；需要工具循环用 `platformAgentAgentflow`

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
