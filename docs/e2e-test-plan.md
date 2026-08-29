# Dagents E2E 测试计划（v1）

> **目标**：全面补齐 Dagents 的端到端测试，**重点覆盖工作流多 Agent 协作**。
> **版本**：v1（2026-08）| **状态**：✅ Phase 0~4 已落地（2026-08-19，见 §8 勾选与 §12 执行记录）
> **配套**：`apps/console/tests/e2e/`（Playwright）· `docs/test-cases.md`（手工用例 331 条）· `docs/workflow-engine.md`（引擎架构）

---

## 0. TL;DR

现有 e2e 套件（11 个 spec / 36 active / 43 fixme）只覆盖**非执行态**的 UI 与 CRUD —— 工作流模块的 run / SSE 全部是 `test.fixme`，多 Agent 协作场景一个都没有。本计划的核心是：

1. **搭一块确定性地基**：一个可脚本化的 **Mock LLM Provider 服务器**（OpenAI 兼容），让 LLM/Agent/PlatformAgent 节点在 e2e 里可复现、可断言，不再依赖真实 CLI/模型；
2. **分层补齐执行态覆盖**：Tier A（gateway 契约）→ Tier B（聊天 SSE 触发）→ Tier C（浏览器 UI 旅程）→ Tier D（失败/边界/可观测）；
3. **多 Agent 协作专项**（约 18 个用例）：并行、接龙、条件路由、工具循环、Iteration/Loop、子流程编排、人机协同、失败传播 —— 每个 pattern 配 DAG 草图 + 精确断言。

---

## 1. 定位与目标

### 1.1 测试金字塔定位

```
        ▲  Playwright E2E（本计划）
       / \   浏览器 UI 旅程 + gateway HTTP 契约 + DB 落库验证
      /   \
     /     \  gateway route tests（vitest + app.request()）
    /       \  packages/workflow 单元/集成测试（executor/integration/nodes）
   /         \  console 组件单测（vitest + testing-library）
```

- 引擎内部行为（拓扑序、变量解析、SSE 帧格式）已有单元/集成覆盖，**e2e 不重复**；
- e2e 只验证三件事：**用户看到什么**、**HTTP 契约返回什么**、**DB 落了什么**；
- e2e 断言尽量走公开面（HTTP + 浏览器），DB 断言只用于「落库正确性」这类无 API 的验证点（与现有 `helpers/seed.ts` 同思路）。

### 1.2 本次要补齐的缺口（现状盘点）

| 缺口 | 现状 | 本计划 |
|---|---|---|
| 工作流**可执行**测试 | `10-workflow-engine.spec.ts` 的 UC-WF-01/12（run+SSE）是 fixme，原因是「无 executable flow + 无 LLM」 | Tier A/B 用 Mock LLM 让 run 真正跑起来 |
| **多 Agent 协作**场景 | 完全空白 | §5.1 专项 18 个用例 |
| 聊天触发执行链路 | `09-chat-trigger.spec.ts` 全 fixme（旧 header 记录的是修复前状态） | Tier B 重写：绑定 flow → SSE 流 → 落库 |
| Daemons 模块 | `06-daemons.spec.ts` 全 fixme（6 条） | 顺带激活可测部分（注册/心跳/删除） |
| 确定性基础设施 | 无 mock LLM；CLI-first 兜底会 spawn claude（不可控） | §4 Mock LLM Provider 服务器 |
| 隔离/CI | 套件共享 dev 库、无 CI 配置 | §4.4 专用测试库 + §9 CI |

### 1.3 原则

- **确定性优先**：所有依赖 LLM 的用例走 Mock Provider，禁止 spawn 真实 CLI（CI 上不可控、慢、贵）。CLI-first 路径保留 1 个 P2 冒烟用例（本机有 claude 时手动跑）。
- **可独立运行**：每个 spec 自带 seed + cleanup，串行执行（`workers:1` 维持现状），互不依赖。
- **可跳过**：需要真实 CLI / 真实 Provider 的用例用 `test.skip`（条件）+ 环境变量开关，默认关。
- **断言分层**：契约断言（HTTP 状态/结构）→ 行为断言（输出内容/节点执行集）→ 数据断言（runs/run_node_spans 行）。

---

## 2. 架构事实（计划的事实基础）

> 写用例前必须知道的执行路径，全部来自 `docs/workflow-engine.md` 与源码（2026-08 核对）。

```
console (Next :3000) → gateway (Hono :8080) → @dagents/workflow DagExecutor
   ├─ POST /api/workflows/:id/run        → JSON { success, data:{ output, executedNodes, state } } + x-run-id 头
   ├─ GET  /api/workflows/runs/:runId/node-spans → 每节点 span（状态/耗时/input/output）
   └─ GET  /api/v1/chats/:id/stream      → SSE（聊天触发 flow 的执行路径）
```

关键事实：

1. **两条执行入口**：
   - `POST /api/v1/workflows/:id/run`（`workflows.ts`）——**同步 JSON**，非 SSE；返回 `x-run-id` 头；写 `runs` + `run_node_spans`。
   - `GET /api/v1/chats/:id/stream`（`chats.ts`）——**SSE**，需 chat 已绑定 `flow_id`（或 `@flow` 命令）；结束后把 assistant 回复写 `chat_messages`。
2. **LLM 路由（CLI-first）**：`createDefaultLlmClient()` 先查 `llm_providers` 表（`status='active'`，按 `created_at ASC LIMIT 1`）；有则走 HTTP（OpenAI 兼容 `/v1/chat/completions`），无则 spawn 本地 CLI（`claude`）。每次 run 前 `resetProviderCache()`。
3. **Mock 的关键杠杆**：往 `llm_providers` 插一条指向本地 mock 的 active 行，即可让所有 LLM/Agent/PlatformAgent 节点走 HTTP mock，**零代码改动**。API key 存 base64（`decryptSecret` 兼容 legacy base64）即可。
4. **PlatformAgent 节点**（多 Agent 协作主角）：按 UUID 从 `agents` 表拉 instructions/model/kind；节点级 `systemPrompt`（任务指令）追加在 instructions 之后；`toolRegistry` 有工具时跑工具循环（mock 可编排 tool_call → 结果 → 最终答案）；`maxIterations` 封顶。
5. **DAG 语义**：同波次并发（`Promise.all`）；条件路由按 `sourceHandle`（`matched`/`result` 或 `selected` 场景名）剪枝；Loop/Iteration 抽循环体逐轮执行（上限 10 轮 / 100 项）；失败 → run failed + 下游剪枝；`finalOutput` = 拓扑序最深的已执行节点输出。
6. **ExecuteFlow 子流程**：共享父 run 的 clients；子流程 executed 节点合并进父 run 的 span；嵌套上限 3 层；不向父流推 token。
7. **HumanInput**：聊天路径挂起等下一条用户消息（SSE 发 `custom:human_input` + 系统消息）；API 路径用 `state.humanInputs`（按 prompt 键）预置答案。
8. **节点配置双形态**：画布保存的 `data.inputs.<field>` 与 AI 生成/手写的平铺 `data.<field>` 在执行入口归一化 —— 测试造 FlowData 时**平铺字段即可**（`data.name` + `data.<field>` 平铺），画布形态用例另测嵌套形态。

---

## 3. 测试分层（Tier A–D）

| Tier | 名称 | 驱动方式 | 断言面 | 对应 spec |
|---|---|---|---|---|
| **A** | 工作流执行契约 | Playwright `request`（不经浏览器渲染，走 console 代理或直连 gateway） | HTTP 状态/结构、x-run-id、node-spans、DB 落库 | `11-workflow-execution.spec.ts`（新） |
| **B** | 聊天触发 SSE | 浏览器打开 `/chats/{id}`，发消息 | SSE 帧序列、流式 token 渲染、assistant 落库、HumanInput 挂起/恢复 | `12-chat-flow-trigger.spec.ts`（新，重写 09） |
| **C** | 浏览器 UI 旅程 | 浏览器 | flows 页 run→detail→inspector、画布编辑器、chat 绑定 | 扩 `05-agentflows`、新增 canvas spec |
| **D** | 跨切面 | request / 浏览器 / DB | 失败、超时、并发、清理、可观测 | `13-workflow-edge.spec.ts`（新） |

> 命名沿用现有数字前缀；`fullyParallel:false, workers:1` 维持，避免共享 DB 竞争。

---

## 4. 确定性基础设施（先决条件，P0）

### 4.1 Mock LLM Provider 服务器

**位置**：`apps/console/tests/e2e/fixtures/mock-llm-server/`（独立 Node 进程，不依赖 Next/gateway）

**端口**：`4010`（`E2E_MOCK_LLM_URL` 可覆盖）

**OpenAI 兼容面**（gateway 的 `createLlmClient` 只用到这些）：
- `POST /v1/chat/completions`：支持 `stream:false`（返回 `choices[0].message.content/tool_calls` + `usage`）与 `stream:true`（SSE：`delta.content` 增量 + `usage` 尾帧 + `[DONE]`）。
- 请求体转发：`model`、`messages`、`tools`、`temperature` —— 全部记录到调用历史。

**脚本控制面**（测试编排用，独立于 OpenAI 面）：
- `POST /__control/script`：设置当前脚本。脚本 = 规则数组，按序匹配：
  ```jsonc
  {
    "rules": [
      { "match": { "systemContains": "ROLE:PLANNER" },
        "respond": { "text": "【规划】目标拆解完成，共 3 个里程碑" } },
      { "match": { "userContains": "tool result" },
        "respond": { "toolCalls": [], "text": "天气查询完成：晴，24°C" } },
      { "match": { "systemContains": "ROLE:CODER" },
        "respond": { "toolCalls": [{ "id": "call_1", "type": "function",
          "function": { "name": "weather_lookup", "arguments": "{\"city\":\"beijing\"}" } }] } }
    ],
    "fallback": { "text": "mock: echo " }
  }
  ```
- `GET /__control/calls`：返回全部调用记录（`{ model, messages, tools, stream, response }`），供「B 的输入含 A 的输出」「工具循环发生了 2 次 LLM 调用」这类断言。
- `DELETE /__control/calls`、`POST /__control/reset`：清空状态（每个测试 beforeAll 调用）。
- `GET /__control/health`：webServer 健康检查用。

**错误/边界注入**：脚本支持 `respond.mode: "error"`（500）、`"malformed"`（非法 JSON）、`"hang"`（挂起至超时）、`"empty"`、`"toolLoop"`（无终止工具循环，测 maxIterations 封顶）。

**实现要点**：零依赖（node:http 即可）；`stream:true` 时按 `intervalMs` 逐 delta 推送（默认 10ms）；全程无外部依赖，Playwright `webServer` 数组第二个进程启动。

### 4.2 Seed 帮助函数扩展（`helpers/seed.ts`）

| 函数 | 作用 |
|---|---|
| `seedMockLlmProvider(ctx)` | 把现有 active provider 置 disabled，插入 `llm_providers` 行（`base_url=http://127.0.0.1:4010`、`api_key=base64("e2e-key")`、`default_model="e2e-mock"`、`status='active'`）；`dispose()` 时删除并恢复原状态 |
| `seedFlow(ctx, { name, flowData })` | 经 `POST /api/workflows` 建 flow（走真实创建路径），返回 id |
| `seedPlatformAgent(ctx, { name, instructions, model, kind })` | 直接插 `agents` 行（workspace_id/owner_id 用固定测试 UUID），返回 id —— PlatformAgent 节点的 fetcher 只读 `id/name/instructions/model/kind/skills` |
| `seedChatBoundToFlow(ctx, { directoryId, flowId })` | 建 chat 并绑定 `flow_id`，返回 chatId |
| `resetMockLlm(ctx)` | `POST /__control/reset` + `DELETE /__control/calls` |

`dispose()` 的 FK-safe 删除顺序扩展为：chat_messages → runs/run_node_spans → chats → flows → agents → llm_providers → directories。

### 4.3 FlowData 构造辅助（确定性 DAG）

新增 `helpers/flow-builder.ts`，提供纯函数：
- `node(id, type, data)` —— 平铺形态：`{ id, type:'customNode', position:{x,y}, data:{ name:type, label, ...data } }`；
- `edge(id, source, target, sourceHandle?)`；
- `linearFlow(nodes: {type, data}[], edges?)`、`parallelFlow(branches)`、`conditionFlow(...)` 等组合子；
- 每个节点 id 用可读常量（`start`/`planner`/`coder`/…），便于 node-spans 断言按 `node_id` 定位。

> 平铺字段（`data.model` 等）即可被执行入口归一化（§2.8）；嵌套 `data.inputs.<field>` 形态单独留 1 个用例验证归一化兼容。

### 4.4 隔离与配置

| 项 | 方案 |
|---|---|
| 数据库 | ✅ 已建**专用测试库** `dagents_e2e`（2026-08-19，22 个迁移从零跑通）。本地全栈隔离需 gateway 以 `POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents_e2e` 启动（已验证）；不重启则退化为 dev 库 + 全套 seed/cleanup。CI 用 fresh Postgres（`POSTGRES_DB=dagents_e2e` 直建） |
| Mock 进程 | Playwright `webServer: [...]` 数组（console + mock 两个 entry），`reuseExistingServer:true` |
| 环境变量 | `E2E_MOCK_LLM_URL`（默认 `http://127.0.0.1:4010`）、`E2E_REAL_CLI=1`（启用 CLI 冒烟，默认关）、`E2E_GATEWAY_URL` 沿用 |
| 套件串行 | `workers:1` 维持；多 Agent 用例内部不并发跑两个 run 相互干扰（并发单独一个用例验证） |

---

## 5. 覆盖矩阵

> 用例 ID 前缀：`MA`（多 Agent 协作，核心）、`WF`（工作流运行时）、`TR`（聊天触发/SSE）、`UI`（浏览器旅程）、`ED`（失败/边界）、`OB`（可观测/落库）。
> 优先级：🔴 P0（核心协作，必做）· 🟡 P1（重要）· 🔵 P2（增强）。

### 5.1 多 Agent 协作专项（MA，核心 ~18 例）

| ID | 场景 | DAG 草图 | 关键断言 | 优先级 |
|---|---|---|---|---|
| MA-01 | **并行多 Agent 同波次** | Start →∥→ {Planner, Coder, Tester} →∥→ Merge → DirectReply | 3 个节点全部执行；spans 起止时间**重叠**（真并发）；最终输出含三份产出（多入边 content 拼接）；`runs.status=completed` | 🔴 |
| MA-02 | **顺序接龙（handoff）** | Start → A(需求分析) → B(方案设计) → C(代码评审) → DirectReply | 执行序 A→B→C（spans startedAt 单调）；B 收到的 user 消息含 A 的产出标记（查 mock 调用记录）；最终输出 = C 的评审 | 🔴 |
| MA-03 | **Condition 分支分工** | Start → CustomFunction(len>10) → Condition → {true: Agent A} / {false: Agent B} → merge | 只执行选中分支（span 集只有 A 或只有 B）；另一分支节点 spans **不存在**；换输入再跑验证另一分支 | 🔴 |
| MA-04 | **ConditionAgent 场景路由** | Start → ConditionAgent(scenarios:[bug,feature,docs]) → 3 路 → 3 个 Agent → DirectReply | mock 返回 `selected:"bug"` 时只有 bug 分支 Agent 执行；selected 值正确落入路由 | 🔴 |
| MA-05 | **Agent + 工具协作循环** | Start → Tool(weather_lookup) → PlatformAgent(tools) → DirectReply | mock 第一轮返回 tool_call、第二轮返回最终答案（引用 tool 结果）；LLM 调用 ≥2 次；tool handler 执行 1 次；最终输出含工具返回数据 | 🔴 |
| MA-06 | **Iteration 逐项批量协作** | Start → CustomFunction(items:[3]) → Iteration → [iteration] PlatformAgent(逐项) → [result] DirectReply | 迭代 3 轮（`iterationIndex`/`iterationItem` 正确解析）；聚合 `content` 含每项处理结果；`completedIterations=3` | 🔴 |
| MA-07 | **Loop 循环协作 + break** | Start → Loop(max:5, condition:$flow.state.done) → [loop] PlatformAgent(改进) + CustomFunction(检查→state.done) → [result] | 提前跳出（轮数 < 5）；state 跨轮传递；聚合输出含每轮结果 | 🔴 |
| MA-08 | **子流程编排（ExecuteFlow）** | 父：Start →∥→ {ExecuteFlow(sub1), ExecuteFlow(sub2)} →∥→ Merge；sub1/sub2 各含一个 Agent | 子流程节点合并进父 run 的 node-spans；子流程输出进入父流合并结果；深度上限 3 层（构造 4 层嵌套 → 明确报错）；子流失败 → 父 run failed | 🔴 |
| MA-09 | **HumanInput 人机协同** | Start → A → HumanInput(确认方案) → B → DirectReply | 聊天路径：SSE 收到 `custom:human_input` + 系统消息 → 下一条消息恢复 → 流继续 → 最终回复含 B 输出；API 路径：`state.humanInputs` 预置成功 / 缺失明确报错 | 🔴 |
| MA-10 | **多 Agent 中一个失败** | Start →∥→ {A(成功), B(失败)} →∥→ merge | run failed；B span `failed` + error 记录；B 下游不执行；A 正常完成（同波次失败语义：整次 run failed） | 🔴 |
| MA-11 | **PlatformAgent 任务指令隔离** | Start → {P(规划), C(编码)} 并行，两节点绑**同一 Agent**、不同 `systemPrompt` | 两个节点发给 mock 的 system prompt 都含 Agent instructions + 各自节点任务指令（查 mock 记录）；输出各归其位 —— 证明「同一 Agent 多职责」 | 🔴 |
| MA-12 | **Tool 注册不泄漏** | flow1 含 Tool(weather)；跑完后再跑 flow2（无 Tool 节点，同 run 内 agent 看不到 weather 工具） | flow2 的 PlatformAgent 收到 tools 数组不含 weather_lookup（查 mock 调用记录）；toolRegistry 按 run 隔离 | 🟡 |
| MA-13 | **多 Agent 输出合并进最终回复** | Start → A → B → DirectReply(模板引用 `$A.output` / `$B.output`…实际为上游拼接) | DirectReply 文本含 A、B 两段产出（模板变量/上游 content 拼接） | 🟡 |
| MA-14 | **失败分支重试路径** | Condition 后失败分支 → 失败 → DirectReply 输出「失败摘要」 | 失败传播到 DirectReply（前序失败节点 + 后继执行节点的组合断言） | 🟡 |
| MA-15 | **深层流水线（5+ Agent 接龙）** | Start → A1..A5 → DirectReply | 5 个节点全执行、顺序正确、总耗时合理（mock 快，无 CLI 延迟）；spans 数量 = 5 | 🟡 |
| MA-16 | **Iteration 内嵌多 Agent** | Start → Iteration → [iteration] {A + B 串行} → [result] | 每轮 A、B 都执行；轮间互不串扰（每轮 B 的输入是本轮 A 的输出）；`iterations=items 长度` | 🟡 |
| MA-17 | **Agent 接力 + 变量透传** | Start(variables:{goal}) → A → B(引用 `$flow.state.goal`) → DirectReply | 节点配置的模板变量正确解析（mock 记录中 B 的 prompt 含 goal 值） | 🟡 |
| MA-18 | **工具循环 maxIterations 封顶** | PlatformAgent + Tool，mock 返回无限 tool_call | 循环在 maxIterations（设 3）处终止；节点失败或强制结束；无死循环（run 有终态） | 🟡 |

### 5.2 工作流运行时 / 节点（WF ~11 例）

| ID | 场景 | 断言 | 优先级 |
|---|---|---|---|
| WF-01 | 单 LLM 节点 run（冒烟） | POST /run 200；`data.output` 含 mock 文本；`x-run-id` 存在 | 🔴 |
| WF-02 | Start→LLM→DirectReply 全链 | finalOutput = DirectReply 文本；executedNodes 含 3 节点 | 🔴 |
| WF-03 | CustomFunction 纯计算节点 | 输出 = 代码结果；input 透传正确 | 🟡 |
| WF-04 | HTTP 节点（指向本地 mock echo 服务） | status/data 输出正确；非 http(s) URL 报错 | 🟡 |
| WF-05 | Retriever 节点（聊天历史检索） | 预置 chat_messages → `docs`/`content` 命中关键词 | 🟡 |
| WF-06 | Tool 节点 handler 直接执行 | 无 Agent 参与时 handler 结果进入输出 | 🟡 |
| WF-07 | 变量解析（`$flow.state` / `$input`） | 节点输出正确展开变量 | 🟡 |
| WF-08 | 配置双形态兼容 | 同一 flow：平铺形态 vs 嵌套 `data.inputs` 形态，run 结果一致 | 🟡 |
| WF-09 | **菱形合并：N 进 1 LLM 节点收到全部上游**（2026-08-27，真实复跑「产品发现（并行）」暴露的回归钉） | sink 节点 span `input.prompt` 同时含两份上游简报；mock 侧 sink 调用 user 消息双保险。修复前节点只读被 Object.assign 覆盖的 `text`，丢 N-1 份 | 🔴 |
| WF-10 | LLM 空产出诚实失败 | mock 返回空 text → run 500 + error 含「返回空内容」+ span failed（修复前：200 假成功、content 空） | 🔴 |
| WF-11 | PlatformAgent 空产出同款守卫 | 同 WF-10 契约但走 Agent 路径（真实复跑中 Agent 0 字正文仍标 done） | 🔴 |

### 5.3 聊天触发 / SSE（TR ~8 例）

| ID | 场景 | 断言 | 优先级 |
|---|---|---|---|
| TR-01 | chat 绑定 flow → 发消息 → SSE 流式 | 浏览器 token 逐段渲染；`end` 帧后 assistant 气泡完整；刷新后消息仍在（落库） | 🔴 |
| TR-02 | `@flow <name> <msg>` 命令触发 | 系统消息 ack；SSE 流执行；assistant 落库 | 🔴 |
| TR-03 | 聊天中执行多 Agent flow（复用 MA-01 flow） | 完整 SSE 帧序列（metadata → token* → end）；最终回复含全部 Agent 产出 | 🔴 |
| TR-04 | HumanInput 聊天路径（复用 MA-09） | `custom:human_input` 事件 + 系统消息；下一条消息恢复；最终回复含 B 输出 | 🔴 |
| TR-05 | SSE 错误帧 | mock 注入错误 → 浏览器显示错误 + 不白屏；run 状态 failed | 🟡 |
| TR-06 | 未绑定 flow 的 chat 发消息 | 走 agent 路径（inline）或返回明确错误；不挂死 | 🟡 |
| TR-07 | 流式 token 与最终落库一致 | 浏览器渲染文本 == `chat_messages` 中 assistant content | 🟡 |
| TR-08 | 聊天运行历史 | `GET /api/chats/:id/runs` 返回本次 run；runs 行含 input/output | 🟡 |

### 5.4 浏览器 UI 旅程（UI ~8 例）

| ID | 场景 | 断言 | 优先级 |
|---|---|---|---|
| UI-01 | flows 页：新建 flow → 画布 → 保存 → 运行 | 创建成功跳画布；保存后列表出现；run 按钮 POST /run 成功 | 🔴 |
| UI-02 | flows 页 run → detail：DAG + Inspector | detail 渲染 DAG；节点状态着色（done/failed/idle 与 spans 一致）；节点 input/output 可见 | 🔴 |
| UI-03 | 画布编辑器：拖拽/连线/配置/保存（复用 MA-01 flow） | 节点可拖、可连、配置可编辑、保存后 GET flow 的 flowData 与画布一致 | 🟡 |
| UI-04 | chat 页绑定 flow（FlowSelector） | 选择 flow 后 chat.flow_id 更新；发送走 SSE | 🟡 |
| UI-05 | chat 页多 Agent 流式渲染（MA-01 flow 浏览器跑） | 回复逐步出现；完成后气泡完整；无乱码 | 🟡 |
| UI-06 | 画布嵌套字段保存 → 运行归一化 | 画布保存的 `data.inputs.*` 形态 flow 能正常 run（归一化兼容） | 🟡 |
| UI-07 | Agent 选择器 + 快速创建（回归 RG-010~013） | 已安装 CLI 快速创建 → 绑定 → 可对话 | 🟡 |
| UI-08 | Daemons 注册/删除（激活 06-daemons fixme 中可测部分） | 注册返回 daemonId/token；删除生效 | 🔵 |

### 5.5 失败与边界（ED ~8 例）

| ID | 场景 | 断言 | 优先级 |
|---|---|---|---|
| ED-01 | 无效 flow id / 空 nodes | 400/404 明确错误；不 500 不挂起 | 🟡 |
| ED-02 | PlatformAgent 引用不存在 agent | 节点 failed，错误信息含 agentId；run failed；span 记录 error | 🔴 |
| ED-03 | Iteration 超 100 项截断 | 仅执行 100 轮；聚合输出注明截断 | 🟡 |
| ED-04 | Loop 超上限 | 执行到 MAX_LOOP_COUNT 终止；无死循环 | 🟡 |
| ED-05 | 并发 run 同 flow | 两个 run 并行各自完整；runs/spans 各自独立（run_id 隔离） | 🟡 |
| ED-06 | ExecuteFlow 4 层嵌套 | 明确报错（深度上限 3）；父 run failed | 🟡 |
| ED-07 | mock 挂起（LLM 无超时，已知限制） | 文档化的已知行为：run 挂起直到 mock 恢复/测试超时 —— **标 P2 + test.skip 默认**，只验证 HTTP 节点 15s 超时路径 | 🔵 |
| ED-08 | SSE 中途断开 | 服务端不崩溃；后续 run 正常（回归防护） | 🔵 |

### 5.6 可观测与落库（OB ~6 例）

| ID | 场景 | 断言 | 优先级 |
|---|---|---|---|
| OB-01 | run + spans 落库 | `runs` 行（status=completed、input/output）；每个执行节点一行 `run_node_spans`（status/duration/tokens/input/output） | 🔴 |
| OB-02 | node-spans API | `GET /api/workflows/runs/:runId/node-spans` 返回全部执行节点 + 跳过节点不出现 | 🔴 |
| OB-03 | 失败 run 的 spans | failed 节点 status=failed + error 字段；未执行节点无 span | 🟡 |
| OB-04 | 子流程 span 合并 | 父 run 的 node-spans 含子流程节点（flow_id 标注子流程） | 🟡 |
| OB-05 | 多 Agent run 的 token 累计 | 各节点 usage 落库；runs 层可汇总 | 🔵 |
| OB-06 | 审计日志 | run/创建/删除 flow 触发 audit 行 | 🔵 |

**合计：18(MA) + 8(WF) + 8(TR) + 8(UI) + 8(ED) + 6(OB) = 56 个新增用例**（其中 🔴 P0 约 18 个，多数落在多 Agent 协作）。

---

## 6. 多 Agent 协作场景设计详解（重点）

### 6.1 MA-01 并行多 Agent —— 引擎「同波次并发」的用户可见证明

```
Start ──┬─▶ Planner(platformAgent, ROLE:PLANNER) ──┐
        ├─▶ Coder  (platformAgent, ROLE:CODER)   ──┼──▶ Merge ─▶ DirectReply
        └─▶ Tester (platformAgent, ROLE:TESTER)  ──┘
```

- Mock 脚本：按 `systemContains: ROLE:PLANNER|CODER|TESTER` 返回各自产出。
- 断言链：
  1. `POST /run` → 200，`runs.status=completed`；
  2. `node-spans` 中 planner/coder/tester 三行 status=done，且**三者 `started_at` 互相重叠**（时间差 < 单节点耗时，证明并行而非串行）；
  3. `finalOutput.content` 含三份产出（多入边浅合并 + content 换行拼接）；
  4. Merge/DirectReply 的 input 含全部上游。

### 6.2 MA-05 Agent + 工具协作 —— 工具循环的确定性编排

```
Start ─▶ Tool(weather_lookup, handler=固定返回 {temp:24, cond:'晴'}) ─▶ PlatformAgent(tools) ─▶ DirectReply
```

- Mock 两轮脚本：第 1 轮（无 tool result）→ `tool_calls:[weather_lookup]`；第 2 轮（messages 含 tool 结果）→ 最终文本「天气查询完成：晴 24°C」。
- 断言链：
  1. mock 调用记录：该节点 2 次 LLM 调用；第 2 次请求的 messages 含 `role:"tool"` 且 content 含 24/晴（**工具结果真的回灌给模型**）；
  2. tool handler 恰好执行 1 次（Tool 节点 span done）；
  3. 最终输出含工具返回数据（协作闭环）；
  4. MA-12 补充：另一个 run 的 agent 收到的 tools 不含 weather_lookup（registry 按 run 隔离）。

### 6.3 MA-08 子流程编排 —— 多 Agent 子团队

```
父 flow: Start ──┬─▶ ExecuteFlow(sub-文案) ──┐
                 └─▶ ExecuteFlow(sub-配图) ──┴──▶ Merge ─▶ DirectReply
子 flow 文案: Start ─▶ PlatformAgent(ROLE:COPYWRITER) ─▶ DirectReply
子 flow 配图: Start ─▶ PlatformAgent(ROLE:ARTIST)   ─▶ DirectReply
```

- 断言链：
  1. 父 run 的 node-spans 同时含父节点与两个子流程节点（`flow_id` 区分）；
  2. 子流程输出进入父流 Merge（最终回复含文案 + 配图两段）；
  3. 负向：构造 4 层嵌套子流程 → `ExecuteFlow: subflow nesting exceeds max depth` 明确报错；
  4. 子流程失败 → 父 run failed，spans 标记失败来源。

### 6.4 MA-09 HumanInput —— 多 Agent 中途人工介入（聊天闭环）

- 聊天路径：发「开始」→ SSE 帧序 `metadata → token*(A 产出) → custom:human_input → (挂起)`；系统消息提示；页面发下一条消息「采用方案一」→ 同一 SSE 流恢复 → `token*(B 产出) → end`；assistant 落库含 A+B。
- API 路径（Tier A 补）：`POST /run` + `state.humanInputs: {"确认方案": "采用方案一"}` → 成功；缺答案 → humanInput 节点报错引导（错误信息含「chat 路径」提示）。

### 6.5 MA-03/04 条件路由 —— 分工与剪枝的可见证明

- MA-03 用**确定性** Condition（CustomFunction 算长度），MA-04 用 **LLM 决策** ConditionAgent（mock 按脚本返回 `selected`）。
- 共同断言核心：**未选分支的 Agent 节点没有 span**（剪枝证据）；换参数/脚本切分支后重跑，只有另一分支有 span —— 用同一 flow 两跑验证互斥。

---

## 7. 断言策略

1. **优先公开契约**：HTTP 状态、`{success,data}` 结构、`x-run-id`、SSE 帧类型 —— 不读引擎内部变量。
2. **DB 只读验证落库**：`helpers/seed.ts` 的 `runQuery` 读 `runs`/`run_node_spans`/`chat_messages`/`agents`/`llm_providers`，断言行数/字段。
3. **Mock 调用记录是「协作证据」**：多 Agent 用例的核心断言大多落在 `GET /__control/calls`（谁收到什么 prompt、工具是否回灌、循环次数）。
4. **Span 集是「执行真相」**：`node-spans` 的 node_id 集合 = 实际执行集，用于剪枝/并行/失败断言。
5. **超时纪律**：mock 下单个 run 目标 < 2s；Playwright test timeout 默认 30s；慢场景（Iteration 100 项）单独放宽。

---

## 8. 分期实施计划（TDD）

> 每个任务：**文件 → 失败测试 → 实现 → 验证**。落地顺序即依赖顺序。

### Phase 0 — 确定性地基（P0，约 1 个任务）
- [x] T0-1 `fixtures/mock-llm-server/`：OpenAI 兼容 chat/completions（stream + 非 stream）+ 控制面（script/calls/reset/health）+ 错误注入。
- [x] T0-2 `helpers/seed.ts` 扩展：`seedMockLlmProvider`/`seedFlow`/`seedPlatformAgent`/`seedChatBoundToFlow`/`resetMockLlm` + `dispose()` 扩展。
- [x] T0-3 `helpers/flow-builder.ts`：node/edge/组合子 + 平铺形态约定。
- [x] T0-4 `playwright.config.ts`：webServer 数组加 mock；env 文档；`11-workflow-execution.spec.ts` 骨架。
- **验收**：WF-01（单 LLM 节点 run）通过，且确认走 HTTP mock（mock 有调用记录、无 CLI spawn）。

### Phase 1 — Tier A 工作流执行契约 + 多 Agent 专项（P0 核心）
- [x] T1-1 基础链：WF-01~03、OB-01~02（run → spans → node-spans API 闭环）。
- [x] T1-2 MA-01 并行、MA-02 接龙、MA-11 任务指令隔离（三个最基础的协作 pattern）。
- [x] T1-3 MA-03/04 条件路由、MA-10 失败传播、MA-13/17 输出合并与变量透传。
- [x] T1-4 MA-05/12/18 工具协作（循环、回灌、隔离、封顶）。
- [x] T1-5 MA-06/07/16 循环协作（Iteration/Loop、嵌套、截断）。
- [x] T1-6 MA-08 子流程编排（合并 span、深度上限、失败传播）。
- [x] T1-7 MA-09 HumanInput（API 路径）。
- **验收**：MA-01~18 + WF/OB 全绿；每个用例独立可跑（`playwright test -g "MA-01"`）。

### Phase 2 — Tier B 聊天触发 SSE（P0）
- [x] T2-1 TR-01/03/07：绑定 flow 的 chat 浏览器发消息 → SSE 渲染 → 落库一致。
- [x] T2-2 TR-02：`@flow` 命令；TR-06 未绑定路径。
- [x] T2-3 TR-04 + MA-09 聊天路径（HumanInput 挂起/恢复）。
- [x] T2-4 TR-05/08：错误帧、运行历史。
- **验收**：09-chat-trigger.spec.ts 的 fixme 按需删除/更新为引用新 spec；聊天多 Agent 流全程可复现。

### Phase 3 — Tier C 浏览器 UI 旅程（P1）
- [x] T3-1 UI-01/02：flows 页 新建→画布→保存→运行→detail→inspector 着色。
- [x] T3-2 UI-03/06：画布拖拽连线 + 嵌套字段保存 → 运行归一化。
- [x] T3-3 UI-04/05：chat 绑定 flow + 多 Agent 流式渲染。
- [x] T3-4 UI-07/08（仅 UI-08；UI-07 依赖本机已装 CLI，环境相关不落地，由 04-agents 非执行态用例覆盖）：Agent 快速创建回归、Daemons 可测部分激活。
- **验收**：多 Agent flow 的完整「设计→运行→检视」用户旅程闭环。

### Phase 4 — Tier D 跨切面 + CI（P1/P2）
- [x] T4-1 ED-01~06：无效输入、引用缺失、截断、并发、嵌套上限。
- [x] T4-2 ED-07/08：超时路径（P2 + skip）、SSE 断连回归。
- [x] T4-3 CI：GitHub Actions（或等价）—— infra up → 专用测试库 → `playwright install chromium` → 套件运行 → 报告上传；失败留 trace/screenshot。
- [x] T4-4 文档：更新 `tests/e2e/README.md` 测试清单表 + 本计划的执行状态勾选。
- **验收**：全新环境一条命令跑通全量；CI 红绿可见。

---

## 9. 运行与 CI

```bash
# 本地全量（自动起 console + mock 双进程）
pnpm --filter @dagents/console test:e2e

# 单 spec / 单用例
pnpm --filter @dagents/console exec playwright test tests/e2e/11-workflow-execution.spec.ts
pnpm --filter @dagents/console exec playwright test -g "MA-05"

# 专用测试库（推荐）
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents_e2e \
  pnpm --filter @dagents/console test:e2e

# 真实 CLI 冒烟（本机有 claude 时手动）
E2E_REAL_CLI=1 pnpm --filter @dagents/console exec playwright test -g "CLI-SMOKE"
```

CI 要点：`webServer.reuseExistingServer` 保持；mock 端口冲突检测（`E2E_MOCK_LLM_URL` 覆盖）；失败时上传 `test-results/`（trace + screenshot）。

---

## 10. 风险与取舍（诚实清单）

| 项 | 说明 | 缓解 |
|---|---|---|
| Mock 与真实 Provider 的差异 | 只验证「引擎编排正确」，不验证模型行为 | 编排正确正是本计划目标；模型行为属评测范畴 |
| 引擎已知限制会暴露在 e2e | LLM 无超时/取消、`new Function` 非沙箱、普通 Agent 节点无工具循环 | 相关用例要么走 PlatformAgent（工具循环），要么标 P2/skip 并引用 `docs/workflow-engine.md` 现状清单 |
| 共享 dev 库污染 | 套件写 flows/agents/runs | 全套 seed/cleanup + 推荐专用库；CI 用 fresh 库 |
| CLI-first 回归风险 | 无 provider 时节点会 spawn claude —— 若 mock provider 行没插成功，测试会意外变慢/挂 | `seedMockLlmProvider` 强制插入 + 冒烟用例断言 mock 收到调用（没收到即环境问题，快速失败） |
| 画布组件（vendor/agentflow）交互复杂 | 拖拽/连线选择器脆弱 | UI 用例优先「保存/运行结果」断言，拖拽只做冒烟；深层交互留给手动用例（docs/test-cases.md §21） |
| 与 `docs/test-cases.md` 331 条手工用例的关系 | 手工=全量探索；本计划=可自动化回归子集 | 本计划聚焦「值得自动化 + 能确定性自动化」的用例，两者互补不重复 |

---

## 11. 待办确认（下一步）

1. 确认 Mock LLM 端口/形态（默认 4010，OpenAI 兼容 + 控制面）；
2. 确认专用测试库 `dagents_e2e` 的创建方式（infra 脚本 vs 手动）；
3. 确认 Phase 0 优先落地（其余 Phase 依赖它）；
4. 落地后按 §8 逐 Phase 推进，并在本文档维护勾选状态。


---

## 12. 执行记录（2026-08-19 落地）

**新增 5 个 spec / 50 个 active 用例，全部通过**（含既有套件全量回归 + gateway 223 / console 300 单测）：

| Spec | 内容 | 数量 |
|---|---|---|
| `11-workflow-execution.spec.ts` | Tier A：WF-01~08 契约 + OB-01~04 落库 | 12 |
| `12-multi-agent.spec.ts` | MA-01~18 全量 + 引擎冒烟锚 | 19 |
| `13-chat-flow-trigger.spec.ts` | Tier B：TR-01~08（聊天触发/SSE/HumanInput 聊天闭环） | 8 |
| `14-workflow-edge.spec.ts` | Tier D：ED-01~05（ED-06 在 MA-08 内） | 6 |
| `15-flows-ui-journey.spec.ts` | Tier C：UI-01/02/04/05/08 | 5 |

> 命名与计划 §3 的对应：计划中的 `12-chat-flow-trigger` 实际为 `13-chat-flow-trigger`（12 号让位给多 Agent 专项），`13-workflow-edge` 为 `14`，UI 旅程为 `15`。

**落地时钉住的引擎真实行为**（写用例前不知道、与直觉不同的）：
1. DirectReply 的 span `input` 记录节点自身配置而非合并后的上游输入 —— 多入边合并断言改用 CustomFunction 回显 `$input`（MA-01/08）；
2. 循环聚合输出取 body 内拓扑最深节点，且**覆盖** result 路径节点成为 finalOutput（MA-07）；
3. SseStreamer 契约：`error` 帧即终止帧，其后 `end` 被丢弃（TR-05）；
4. chat 路径执行不写 `runs` 表，run 关联载体是 `chat_messages.run_id`（TR-08）；
5. 子流程 span 全部以父 run 的 flow_id 落库（run 路由统一写入），非计划假设的「flow_id 标注子流程」（MA-08/OB-04 按实际行为断言）。

**e2e 抓到并修复的 4 个产品缺陷**（TDD 循环：失败测试 → 修复 → 验证）：
1. **@flow 命令路径漏注入 clients**（gateway `chat-execute.ts`）：`executor.execute` 未传 llmClient/agentFetcher/toolRegistry，LLM/Agent 节点经 @flow 必挂 → 已对齐 run 路由注入（TR-02 回归锚）；
2. **createDefaultLlmClient 丢失 chatStream**（gateway `workflow-clients.ts`）：CLI-first 重构后该方法只剩 chat()，聊天路径的流式 LLM 节点全部退化为 metadata→end 无 token → 补回 chatStream（provider 走真流式，CLI 兜底单帧）；
3. **flow 绑定的聊天在 UI 里根本不执行**（console `chat-detail.tsx`）：UI 只听 WS，而 flow 路径要客户端拉 `GET /chats/:id/stream` 才执行 —— 发消息后永远「正在思考…」→ handleSend 按 mode='stream' 开 SSE pump，帧翻译进既有 WS 气泡机制；
4. **HumanInput 挂起期间 composer 被禁用**（console）：挂起等人类答案时 `sending=true` 把输入框锁死，人机协同在 UI 不可用 → 收到 `custom:human_input` 时清除 sending；
   （+ **CreateFlowDialog 读错响应字段** `data.id` vs `data.flow.id`：UI 新建 flow 跳 `/workflows/undefined/canvas`，UI-01 顺带修复。）

**收尾批次（2026-08-19 第二轮，"全部收尾"）**：
1. OB-05（token 累计落 span）/ OB-06（workflow.create/delete 审计行）补入 11 号 spec（14 用例）；
2. ED-07 HTTP 节点 15s 超时路径落地（mock 新增 `/__control/hang` 永挂端点）；ED-07b LLM 挂起维持 skip 并引用引擎已知限制；CLI-SMOKE（`E2E_REAL_CLI=1` 才启用）就位 —— 14 号 spec 现 7 active + 2 skip；
3. 09 号 spec fixme 清理：@ 补全弹窗（cmd-menu 已实现）激活为真实用例、UC-TRG-06 覆盖迁移注明指向 13 号、UC-TRG-01 注释对齐 WS+dispatch 现状；10 号 UC-WF-01/12 的执行态覆盖已由 11/13 号取代（spec 头注已更新）；
4. **旧 UC 套件 22 处选择器腐化修复**：早前 i18n/设计系统提交后 01~09 号 spec 一直挂着（此前「全量回归 161 通过」的报告因 `| tail` 管道掩盖了失败退出码，系误报）——本轮逐一对齐当前 DOM：欢迎语文案/建议卡行为、user 气泡类名、面包屑去链接、context panel 未挂载转 fixme、/directories 页面移除（03 号剥离为 API 契约用例）、agents tab i18n + 骨架期点击时机、flows API 换 /api/workflows、daemons 页改版重写、settings Token→Provider、sidebar 导航改版；
5. 专用测试库 `dagents_e2e` 建库 + 迁移 + 「gateway 指向专用库」拓扑冒烟验证；
6. CI：`.github/workflows/e2e.yml`（fresh Postgres → 专用库迁移 → 构建 → gateway 后台 → playwright 全量 → 失败上传 trace）。

**明确不落地的项**（与 §10 取舍一致）：
- UI-03 画布拖拽/连线（脆弱选择器）→ 只保留画布可达性冒烟（05 + UI-01）；
- UI-06 嵌套字段归一化 → 契约层 WF-08 覆盖，浏览器侧不重复；
- UI-07 Agent 快速创建 → 依赖本机安装 CLI，环境相关；
- ED-07 LLM 挂起（HTTP LLM 已有 `LLM_HTTP_TIMEOUT_MS` 超时；skip 原因是 e2e 无法调低外部启动的 gateway 的该值 + 120s 等待过长）→ 维持 P2/skip；
- 专用测试库 `dagents_e2e` 与 CI（T4-3）→ 后续独立任务（当前 dev 库 + 全套 seed/cleanup 已稳定）。

**引擎修复批次（2026-08-27，真实多实例 CLI 复跑暴露）**：

> 起因：对「产品发现（并行）」（7 节点菱形，4 并行 claude 实例）做真实复跑验证，mock 钉桩的单链路 e2e 全绿但真跑必坏 —— 三个引擎缺陷都是 mock 测不出的。

1. **N 进 1 合并丢上游**（`llm.node.ts` + `platform-agent.node.ts`）：`mergeInputs` 把多上游 `content` 正确拼接，但节点消费时读被 `Object.assign` 覆盖的 `text`（只剩最后一条边）→ 汇总节点只收 1/N 份简报（实测 206 字 / 应 3782 字）。修复：消费侧优先 `content`。**WF-09** 即此回归的钉子（sink prompt 必须含全部上游简报）；
2. **空产出假成功**：LLM 节点空正文仍 `status=done`（实测 180s 后 content="" 流向下游）；PlatformAgent 同款。修复：双节点空产出守卫抛错。**WF-10 / WF-11** 钉住（500 + error + span failed）；
3. **Iteration/Loop 终态 span 丢失**（`executor.ts`）：controller 的 `onNodeEnd` 在体内执行前触发，事后只改内存 trace 不重发钩子 → span 永远定格 start 快照（OB-05/MA-06/07/16/ED-03/04 六例既有失败的根因）。修复：体内完成后重发 `onNodeEnd`（终态 + endedAt 顺延），六例全部转绿；
4. **CLI 超时策略变更**（产品决策：Agent 自主长跑，不设墙钟）：180s 硬墙改为静默看门狗 `WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS`（逐行重置）；非完成状态（timeout/aborted/cancelled）从「部分文本+成功」改为诚实抛错，usage 附着错误落 span。终验：汇总节点 209s（> 旧墙）正常完成；
5. 测试自身加固：OB-05 改轮询等待（span 异步落库 vs 立即断言的竞态，~1/3 闪失败）；UC-CHAT-04 URL 断言 10s→30s（重启脚本清 `.next` 后首个 send 冷编译可超 15s）。
