# M2.10 — 画布端到端: HTTP 节点 → dispatch → claude（验证记录）

> 关联 plan: `docs/superpowers/plans/2026-07-08-mvp-implementation.md` §Task M2.10
> 关联 issue: MZW-256
> 分支: `issue/MZW-256`

## 目标

把画布串起来：`curl gateway/api/v1/flows/<id>/prediction -d '{"question":"用 claude 列出目录"}'`，gateway 代理到 Flowise，**Tool Agent**（function calling）调用 **DispatchInvoke** 工具节点，工具经 gateway `POST /api/v1/dispatch/invoke` 入队，claude daemon claim → 执行 → complete，工具轮询 `GET /tasks/:id` 拿到 output，Agent 把结果回复给画布。

M2.9a/b/c 已把底层能力合并进 main：dispatch `GET /tasks/:id` 结果查询、gateway 双代理（`/flows/:id/prediction` → Flowise、`/dispatch/*` → dispatch）、Flowise `DispatchInvoke` 自定义 Tool 节点。M2.10 是**集成 + 验证**任务，不写新生产代码 —— 仓库内交付物 = 画布构建脚本 + 本验证文档；运行态步骤（拷节点、构建、起服务、跑 curl）不入库。

> **Agent 选型更正**：plan 原文写的是 "ReAct Agent"，实测后脚本改用 **Tool Agent**（function calling）。原因：ReAct Agent 的文本解析器把 `Action Input: <string>` 的裸字符串传给工具，而 DispatchInvoke 是 `StructuredTool`（schema `{ prompt: string }`），`StructuredTool.call` 拒绝裸字符串并抛 `Received tool input did not match expected schema`。Tool Agent 走 `model.bindTools`（原生 OpenAI function calling），glm-5.2 直接产出 `tool_calls[].function.arguments = {"prompt": "…"}`，与 schema 匹配。下文架构图沿用"Agent"统称，实际节点是 Tool Agent。

## 验收

- ✅ `curl gateway/api/v1/flows/<id>/prediction -d '{"question":"用 claude 列出目录"}'` 返回 200 + claude 输出文本（非错误串）
- ✅ claude daemon 被调起（dispatch_tasks 出现一行 `status=completed`、`result.output` 非空）
- ✅ 结果回到画布（curl body 含 claude 实际输出）

## 架构（已落地，M2.9）

```
curl ──> gateway :8080 /api/v1/flows/<id>/prediction
            │  (rewriting proxy: /flows/:id/prediction -> Flowise /api/v1/prediction/:id, 透传 x-run-id)
            ▼
        Flowise :3101  (Tool Agent + DispatchInvoke Tool 节点)
            │  Agent 调 dispatch_invoke({prompt})
            ▼
        DispatchInvoke._call  ──POST /api/v1/dispatch/invoke──> gateway :8080 ──> dispatch :8081 (入队 queued)
            │                                                                  ▲
            │  轮询 GET /api/v1/dispatch/tasks/:id                             │ daemon claim (FOR UPDATE SKIP LOCKED)
            │  直到 completed/failed                                            │ spawn claude --print --output-format stream-json
            ▼                                                                  │ reportMessages -> complete(output,usage)
        result.output ──> Agent 最终回复 ──> curl body <────────────────────────┘
```

关键：DispatchInvoke 走的是 **LangChain Tool 节点**（不是裸 HTTP 节点），由 Tool Agent 在对话中按需调用 —— 与 M1 已验证的「ReAct Agent + Calculator」画布同构，M2.10 即复制 M1 画布把 Calculator 换成 DispatchInvoke、指向真实 claude daemon。

## 实现

### 1. 让 DispatchInvoke 出现在画布（运行态，不入库）

按 M1 既定模式（不重建 vendor/flowise）：把 `vendor/flowise/packages/components/nodes/tools/DispatchInvoke/`（4 文件）拷到运行态 fork `~/Projects/Flowise/packages/components/nodes/tools/DispatchInvoke/`，再 `pnpm --filter flowise-components build`（tsc + gulp）。Flowise 的 `NodesPool.loadNodesFromDir`（`packages/server/src/NodesPool.ts:36`）从 `flowise-components/dist/nodes/**/*.js` 自动 `require` 每个导出 `nodeClass` 的 `.js`，所以编译产物落到 `dist/nodes/tools/DispatchInvoke/DispatchInvoke.js` 后即被自动发现，无需改任何 index/注册表。

### 2. 起 Flowise :3101（复用 M1 fork 配置，SSRF guard 关闭 + DEBUG）

`~/Projects/Flowise/packages/server/.env`（M1 已配好，同库同 chatflow）指向 dagents Postgres(:15432)/Redis(:16479)，`PORT=3101`，`MODE=queue`（API server 只入队，prediction job 由 BullMQ worker 执行）。**必须带 `HTTP_SECURITY_CHECK=false`** 启动，否则 DispatchInvoke 工具的 `secureFetch` 会把 `http://localhost:8080`（gateway）当成 SSRF 攻击拒绝（`isDeniedIP: Access to this host is denied by policy.`），见下文「坑点」。同时带 `DEBUG=true` 让 LangChain 的 `LCConsoleCallbackHandler` 打印 `[tool/start]`/`[tool/end]` trace 作为工具调用的决定性证据（与 M1 文档同法）。

```bash
cd ~/Projects/Flowise && HTTP_SECURITY_CHECK=false DEBUG=true pnpm exec flowise start   # :3101 API
```

queue 模式下还需一个 **worker** 来真正执行 prediction job（API server 不执行）：

```bash
cd ~/Projects/Flowise && HTTP_SECURITY_CHECK=false DEBUG=true pnpm exec flowise worker   # 消费 flowise-queue-prediction
```

> API server 与 worker 是两个进程，两者都必须带 `HTTP_SECURITY_CHECK=false` —— 工具的 `secureFetch` 在 worker 进程里执行，只有 worker 关了 SSRF guard 才放行 localhost。

### 3. 起 gateway :8080 + claude daemon（本 workdir）

```bash
# gateway 代理 Flowise(:3101, 默认 FLOWISE_URL) + dispatch(:8081, 默认 DISPATCH_URL)
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents \
  pnpm --filter @dagents/gateway dev          # :8080

# claude daemon 注册到 dispatch(:8081) 并轮询 claim
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents \
  pnpm --filter @dagents/daemon exec tsx src/cli.ts http://localhost:8081 m2-claude claude
```

> `POSTGRES_URL` 必须显式指向 `:15432`（dagents Postgres 主机映射），否则 `@dagents/db` 默认连 `localhost:5432` 会失败。dispatch :8081 复用已在运行的实例（workdir 3313ba50）。
>
> claim SQL 不按 `agent_daemon_id` 过滤（`WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`），所以任何在线 claude daemon 都会捞走队列里的任务；节点配置里的 `agentDaemonId` 只需是合法 `agent_daemons.id`（FK 约束），用现成的 `6544020d-…`（claude-code/claude）即可。

### 4. 用脚本程序化建 chatflow

`scripts/flowise-m2-setup.py` 镜像 `scripts/flowise-m1-setup.py`：

1. **重建** OpenAI 凭证（默认 `newapi-openai-m2`，可用 `FLOWISE_CRED_NAME` 覆盖）：命中同名旧凭证先 DELETE 再 POST，保证存的是当前 `NEWAPI_TOKEN`（PUT 改密钥不可靠，见 M1 文档坑#3）。
2. 构造 chatflow flowData：`chatOpenAI`（basepath new-api、modelName `glm-5.2`）→ **`dispatchInvoke`** 工具节点（`agentDaemonId=6544020d-…`、`gatewayUrl=http://localhost:8080`、`timeoutMs=180000`、中文 `description` 引导 LLM 调用）+ `bufferMemory` → **`toolAgent`**（Tool Agent / function calling），edges 把三者连到 agent 的 `tools`/`model`/`memory`。
3. 找/建 chatflow（`M2 Dispatch Demo`，type `CHATFLOW`）—— 存在则 PUT 更新 flowData，不存在则 POST。
4. 跑 M2.10 验收 probe：`POST gateway/api/v1/flows/<id>/prediction -d '{"question":"用 claude 列出目录"}'`。

```bash
FLOWISE_API_KEY=FpPA-... NEWAPI_TOKEN=sk-... \
  FLOWISE_CRED_NAME=newapi-openai-m2 \
  python3 scripts/flowise-m2-setup.py
```

DispatchInvoke 工具节点的 outputAnchor 类型串是 `DispatchInvoke | Tool | StructuredTool | BaseLangChain`（与 M1 Calculator 同形），Tool agent 的 `tools` 输入锚接受 `Tool`，Flowise 按 `|` 拆源类型校验目标类型是否命中，所以这条 edge 有效。

## 实测证据（2026-07-09 本机实测）

### 脚本输出

```
[1/3] ensure OpenAI credential 'newapi-openai-m2' -> new-api (http://localhost:13000/v1)
    deleted stale credential a01072b9-e82e-4c2b-9cb7-54b47102a948 (recreating with current token)
    credential id: 90d75127-1e4c-49cd-80a2-e5f98e5dc152
[2/3] build & save chatflow (ChatOpenAI -> new-api + Tool Agent + DispatchInvoke)
    agentDaemonId: 6544020d-918a-43e5-a411-a17733b368e1
    gatewayUrl:    http://localhost:8080
    timeoutMs:     180000
    chatflow updated, id: 59f18aa2-5a61-43a8-b0b4-16ad7c2989dd
    chatflow URL: http://localhost:3101/canvas/59f18aa2-5a61-43a8-b0b4-16ad7c2989dd
[3/3] e2e acceptance probe via gateway
    POST http://localhost:8080/api/v1/flows/59f18aa2-5a61-43a8-b0b4-16ad7c2989dd/prediction
    question: 用 claude 列出目录
    HTTP 200
    body: {"text": "以下是 Claude 列出的当前目录内容：\n\n**当前目录：** `packages/daemon`\n\n**文件夹：**\n- `node_modules/` — 依赖安装目录\n- `src/` — 源代码目录\n\n**文件：**\n- `package.json` — 包配置文件\n- `tsconfig.json` — TypeScript 配置文件\n\n这是一个基于 TypeScript 的 daemon 包项目。如果你需要进一步查看某个文件的内容，或者深入查看 `src/` 目录的结构，请告诉我！", "usedTools": [{"tool": "dispatch_invoke", "toolInput": {"prompt": "请列出当前目录下的所有文件和文件夹。"}, "toolOutput": "当前目录（`packages/daemon`）下的内容：\n\n**文件夹：**\n- `node_modules/` — 依赖安装目录\n- `src/` — 源代码目录\n\n**文件：**\n- `package.json` — 包配置文件\n- `tsconfig.json` — TypeScript 配置文件\n\n这是一个基于 TypeScript 的 daemon 包项目。需要我查看某个文件的内容，或者深入查看 `src/` 目录的结构吗？"}], "question": "用 claude 列出目录", "chatId": "43c215cc-8d02-4404-bf92-76b33df35565", "chatMessageId": "51fd48ff-062a-4847-b904-d7979a1c9594", "isStreamValid": false, "sessionId": "43c215cc-8d02-4404-bf92-76b33df35565", "memoryType": "Buffer Memory"}

chatflow id: 59f18aa2-5a61-43a8-b0b4-16ad7c2989dd
```

chatflow id: `59f18aa2-5a61-43a8-b0b4-16ad7c2989dd`
canvas URL: `http://localhost:3101/canvas/59f18aa2-5a61-43a8-b0b4-16ad7c2989dd`

### 验收 curl（经 gateway）

`curl gateway/api/v1/flows/<id>/prediction` 返回 **HTTP 200**，`text` 字段是 claude daemon 实际跑出的目录列表（`packages/daemon` 下的 `node_modules/`、`src/`、`package.json`、`tsconfig.json`）。`usedTools` 数组证明 Agent 调了 `dispatch_invoke` 工具，`toolInput.prompt` 是 Agent 生成的子任务、`toolOutput` 是工具轮询拿回的 claude 输出，二者内容一致地回到画布 `text`。完整 body 见上方脚本输出。

### dispatch_tasks 证据

```sql
-- docker exec dagents-postgres-1 psql -qAt -U dagents -d dagents -c \
--   "SELECT id, status, agent_daemon_id, session_id, duration_ms, LEFT(result::text, 200) FROM dispatch_tasks WHERE id='7719943c-510f-4304-ba30-dcf76a6be123'"
```

```
7719943c-510f-4304-ba30-dcf76a6be123|completed|6544020d-918a-43e5-a411-a17733b368e1|ba9c1032-f86a-4d10-9283-24be70c871b2|19306|{"usage": {"claude-opus-4-8[1M]": {"inputTokens": 118383, "outputTokens": 335, "cacheReadTokens": 12416, "cacheWriteTokens": 0}}, "output": "当前目录（`packages/daemon`）下的内容：\n\n**文件夹：**\n- `node_modules/` ...
```

关键字段：
- `status=completed`，`agent_daemon_id=6544020d-…`（claude-code/claude）
- `session_id=ba9c1032-…`（claude CLI session），`duration_ms=19306`
- `result.output` = claude 实际目录列表文本（与画布 `text` 一致）
- `result.usage` = `{"claude-opus-4-8[1M]": {inputTokens:118383, outputTokens:335, cacheReadTokens:12416, …}}`
- 入队的 prompt（`dispatch_tasks.prompt`）= `请列出当前目录下的所有文件和文件夹。`（Agent 由用户问题「用 claude 列出目录」生成的工具入参）

### daemon 日志

```
{"svc":"daemon","label":"m2-claude","taskId":"7719943c-510f-4304-ba30-dcf76a6be123","runId":"870bf57f-224a-424a-9c5c-f0a8810c3735","msg":"claimed task"}
{"svc":"daemon","label":"m2-claude","exec":"claude","args":["--print","--output-format","stream-json","--verbose"],"msg":"claude spawn"}
{"svc":"daemon","label":"m2-claude","taskId":"7719943c-510f-4304-ba30-dcf76a6be123","sessionId":"ba9c1032-f86a-4d10-9283-24be70c871b2","durationMs":19306,"models":["claude-opus-4-8[1M]"],"msg":"task completed"}
```

`claimed task` → `claude spawn`（`claude --print --output-format stream-json --verbose`）→ `task completed`（带 `sessionId`、`durationMs`、`models`），与 dispatch_tasks 行的 session/duration 对齐。`runId=870bf57f-…` 是 DispatchInvoke 工具为本次调用生成的 UUID，与 `dispatch_tasks.run_id` 一致，证明工具 → gateway → dispatch → daemon 这条链是同一次调用。

### gateway 代理链（invoke → 轮询 → flow 200）

```
23:29:29.51  POST /api/v1/dispatch/invoke                                  200  proxy dispatch   # 工具入队
23:29:29.59  GET  /api/v1/dispatch/tasks/7719943c-…  200  proxy dispatch   # 第 1 次轮询
23:29:30.64 … 23:29:49.12  GET /api/v1/dispatch/tasks/7719943c-…  200  proxy dispatch  # 每 ~1s 轮询，共 21 次
23:29:51.87  POST /api/v1/prediction/59f18aa2-…  runId=0c1a1311-…  200  proxy flow     # Agent 拿到 output 后回画布
```

invoke(200) → 21× tasks 轮询(200，直到 status=completed) → prediction(200)。整条代理链经 gateway，dispatch 始终在 gateway 后面，未直连 :8081。

### Tool Agent 工具调用 trace（决定性证据）

`DEBUG=true` 的 worker stdout 出现 `[agent/action]` / `[tool/start]` / `[tool/end]` 裸 `console.log` 行（`@langchain/core` 的 `LCConsoleCallbackHandler`，由 `executor.verbose=true` 经 `CallbackManager.configure` 自动 attach，与 M1 文档同法），证明 Agent 真的调了 `dispatch_invoke` 工具、入参是 Agent 生成的 prompt、出参是 claude 输出：

```
[agent/action] [1:chain:AgentExecutor] Agent selected action: {
  "tool": "dispatch_invoke",
  "log": "Invoking \"dispatch_invoke\" with {\"prompt\":\"请列出当前目录下的所有文件和文件夹。\"}\n",
  ...
}
[tool/start] [1:chain:AgentExecutor > 9:tool:DispatchInvokeTool] Entering Tool run with input: "{"prompt":"请列出当前目录下的所有文件和文件夹。"}"
[tool/end]   [1:chain:AgentExecutor > 9:tool:DispatchInvokeTool] [20.09s] Exiting Tool run with output: "当前目录（`packages/daemon`）下的内容：

**文件夹：**
- `node_modules/` — 依赖安装目录
- `src/` — 源代码目录

**文件：**
- `package.json` — 包配置文件
- `tsconfig.json` — TypeScript 配置文件

这是一个基于 TypeScript 的 daemon 包项目。需要我查看某个文件的内容，或者深入查看 `src/` 目录的结构吗？"
```

`[tool/start]` 的 input = `{"prompt":"请列出当前目录下的所有文件和文件夹。"}`、`[tool/end]` 的 output = claude 目录列表（耗时 20.09s，对应 daemon 的 19.3s + 轮询开销）——工具名、入参、出参、时序全在 trace 里，构成「DispatchInvoke 被调用且产出 claude 输出」的直接证据。随后第二轮 LLM 调用拿这个 Observation 作答，即画布 `text` 的内容。

## 坑点

- **plan 里的 `agentDaemonId=0a791869-…` 已失效**：`agent_daemons` 表里那行在跑 e2e 前已不在（库里只剩 `6544020d-…` claude-code/claude 一行）。`dispatch_tasks.agent_daemon_id` 是 FK，invoke 时 insert 会因 FK 违反返回 422。脚本默认改用现存的 `6544020d-…`。
- **`daemons` 表有一行 stale `online`**（进程已不在，`last_heartbeat_at` 停在旧时间）—— 不影响 claim（claim 不按 daemon 过滤），但说明 dispatch 没有 reaper，stale daemon 行不会自动清。
- **claude CLI 慢**：`claude --print --output-format stream-json` 单次几秒到十几秒，超过 gateway/dispatch 默认 120s 风险不大但留余量，节点 `timeoutMs=180000`。
- **new-api token 要带 `sk-` 前缀**存进 Flowise 凭证（M1 坑#3 同理）。本次实测用 new-api 库中 status=enabled 的 `sk-newapi-m0`（key `XAQIYk…`，完整 token `sk-XAQIYk…`）。
- **DispatchInvoke 被 Flowise 的 SSRF guard 拦截（核心坑）**：工具的 `_call` 走 `secureFetch`（`vendor/flowise/packages/components/src/httpSecurity.ts`），其默认 deny-list 含 `127.0.0.0/8` 与 `localhost`。`gatewayUrl=http://localhost:8080` 解析到 127.0.0.1 → `isDeniedIP` 抛 `Access to this host is denied by policy.`，Agent 把错误转述给用户（HTTP 200 但 `usedTools[].error` 非空）。**必须给 Flowise 进程设 `HTTP_SECURITY_CHECK=false`**（env，`getHttpDenyList` 检测到后省略默认 deny-list，仅用 `HTTP_DENY_LIST` 自定义项）。这是本地 dev fork 的合法用法；生产若 gateway 与 flowise 同机，应在 `HTTP_DENY_LIST` 里显式放行或让 gateway 监听非 loopback。
- **queue 模式下 API server ≠ worker**：`MODE=queue` 时 API server 只把 prediction job 入 BullMQ 队列，真正执行（含工具的 `secureFetch`）在 worker 进程。所以 `HTTP_SECURITY_CHECK=false` 必须同时设在 **worker** 进程上，光设 API server 不够。多个 worker 抢同一队列时，谁先拿到 job 谁执行——若并存一个没关 SSRF 的 worker，job 可能落到它手里仍然失败；e2e 时只保留一个带 `HTTP_SECURITY_CHECK=false` 的 worker 最稳。
- **glm-5.2 是 reasoning 模型，小 max_tokens 会空响应**：直连 new-api `/v1/chat/completions`、`max_tokens` 设小（如 50）时 `finish_reason=length`、`content=""`（token 全烧在不可见 reasoning 上）。Tool Agent 走 function calling 不受影响（`tool_calls` 正常返回），但调试时直接打 raw LLM 看到空响应别误判为故障，把 `max_tokens` 调到 500+ 即可拿到 `finish_reason=stop` + 正常文本。
- **凭证名别和 M1 共用**：M1 的 `flowise-m1-setup.py` 与本脚本若都用默认凭证名 `newapi-openai`，两者都「先 DELETE 再 POST」会互相把对方 chatflow 引用的凭证 ID 失效（运行时 `Missing credentials` / 401）。本脚本默认改用 `newapi-openai-m2`（`FLOWISE_CRED_NAME` 可覆盖），与 M1 隔离。

## 产出

- `scripts/flowise-m2-setup.py` — 程序化建 M2 chatflow + 跑 gateway 验收 probe 的脚本
- `docs/m2-canvas-e2e-verification.md` — 本文档

chatflow 定义存 Flowise DB（`chat_flow` 表，id 见上），非文件 —— 与 M1 一致。

## 下游 / 后续

- **M3**：把画布接进完整链路（gateway 签发 daemon token、画布侧 run_id 串联 Langfuse trace 等）。
- DispatchInvoke 节点目前 `execOptions` 固定为 `{}`（不透传 `cwd`/`model`/`maxTurns`）；后续可让节点暴露这些字段或从画布变量注入。
