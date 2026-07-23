# M1.1–M1.3 — Flowise 配 LLM+Agent 节点跑通对话（验证记录）

> 关联 plan: `docs/superpowers/plans/2026-07-08-mvp-implementation.md` §Task M1.1–M1.3
> 关联 issue: MZW-244
> 分支: `issue/MZW-244`

## 目标

在 forked Flowise 建 1 个 Agent 节点（带工具），跑通对话：ChatOpenAI 节点指向 new-api，加 ReAct Agent + Calculator 工具，用 Flowise 自带 chat / Prediction API 跑通。

## 验收

- ✅ agent 回复正常
- ✅ 工具调用正常

## 实现

### 1. 起 Flowise（指向 mil-agents Postgres + Redis）

`vendor/flowise/packages/server/.env`：

```
PORT=3101
DATABASE_TYPE=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=15432      # mil-agents-postgres-1 主机映射
DATABASE_NAME=flowise    # 在 mil-agents Postgres 实例新建
DATABASE_USER=milagents
DATABASE_PASSWORD=milagents_dev
REDIS_URL=redis://default:@127.0.0.1:16479   # mil-agents-redis-1 主机映射
DISABLE_FLOWISE_TELEMETRY=true
CORS_ORIGINS=*
```

> 端口说明：plan 默认 `FLOWISE_PORT=3100`，但本机 3100 已被 `million-agents-loki-1` 占用，故改用 3101。Postgres/Redis 复用 mil-agents 栈（`docker compose` 项目 `mil-agents`），主机端口分别映射到 15432 / 16479。

启动（在 `~/Projects/Flowise` 已构建的 fork 上，源码与 `vendor/flowise` 同源 commit `bb773ffa`）：

```bash
cd ~/Projects/Flowise && pnpm exec flowise start   # 监听 :3101
```

Flowise 首次启动在 `flowise` 库跑完迁移、初始化 Nodes Pool / Identity Manager / Auth。

### 2. 注册账号 + 签发平台 API Key

Flowise 的 `/api/v1/*`（非白名单）需要鉴权：浏览器 session 走 JWT cookie，API 走 Bearer API Key。脚本化走后者。

```bash
# 注册首个 admin（enterprise 路径，OPEN_SOURCE 平台也走这套）
# credential 是一个满足大小写+数字+特殊字符(≥8)的密码，换你自己的
curl -X POST http://localhost:3101/api/v1/account/register \
  -H 'Content-Type: application/json' \
  -d '{"user":{"name":"Admin","email":"admin@example.com","credential":"<your-admin-password>"}}'

# 登录拿 JWT cookie
curl -c /tmp/fw.cookie -X POST http://localhost:3101/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<your-admin-password>"}'

# 用 session cookie + x-request-from: internal 创建 API Key
curl -H 'x-request-from: internal' -H "Cookie: $(cat /tmp/fw.cookiehdr)" \
  -X POST http://localhost:3101/api/v1/apikey \
  -H 'Content-Type: application/json' \
  -d '{"keyName":"mil-agents-m1","permissions":[...]}'
# -> apiKey: <your-flowise-api-key>   (Bearer，用于脚本 FLOWISE_API_KEY)
```

> 鉴权细节（源码核对）：
> - 中间件 `index.ts:230` 对所有 `/api/v1/*` 鉴权；`x-request-from: internal` 走 `verifyToken`（JWT cookie），否则走 `validateAPIKey`（Bearer）。
> - 注册 body 用 `user.credential` 字段（`sanitizeRegistrationDTO` 严格白名单：`name/email/credential/tempToken`），不是 `password`。
> - 密码要满足 `isInvalidPassword`（大小写+数字+特殊字符，≥8）。
> - API Key 不能含 workspace/admin 类权限，否则 400。

### 3. 建 OpenAI 凭证指向 new-api

```bash
curl -H "Authorization: Bearer $FLOWISE_API_KEY" \
  -X POST http://localhost:3101/api/v1/credentials \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"newapi-openai",
    "credentialName":"openAIApi",
    "plainDataObj":{"openAIApiKey":"sk-<new-api token>"}
  }'
```

> 关键坑：`openAIApi` 凭证只存一个 `openAIApiKey` 字段，ChatOpenAI 节点把它原样作为 `Authorization: Bearer <key>` 发给 new-api。new-api 的 token 在 DB 里**不带 `sk-` 前缀**，调用时必须拼 `sk-<key>`。所以凭证里必须存**带 `sk-` 前缀的完整 token**，否则 new-api 回 `401 Invalid token`。
> 凭证 body 用 `plainDataObj`（不是 `details`）—— `transformToCredentialEntity` 只加密 `plainDataObj`，用别的字段会 `encryptedData null` 500。
> 不要用 PUT 更新已存在的凭证来改密钥（reveal 会回 `_FLOWISE_BLANK_` 占位，且实测未覆盖原值）；删后重建最稳。

### 4. 用脚本程序化建 chatflow

`scripts/flowise-m1-setup.py` 做四件事：

1. **重建** OpenAI 凭证（`newapi-openai`）：命中同名旧凭证先 `DELETE` 再 `POST`，保证存的是当前 `NEWAPI_TOKEN`（PUT 改密钥不可靠，见上节坑#3；静默复用会让旧 token 残留、agent 401 而操作者无感）。
2. 构造 chatflow flowData：`chatOpenAI` 节点（`basepath=http://localhost:13000/v1`、`modelName=glm-5.2`、`credentialId=<cred_id>`）→ `calculator` 工具 + `bufferMemory` → `reactAgentChat`（ReAct Agent for Chat Models），edges 把三者连到 agent 的 `tools` / `model` / `memory`。
3. 找/建 chatflow（`M1 Agent Demo`，type `CHATFLOW`）—— 存在则 PUT 更新 flowData，不存在则 POST。
4. 跑两次 Prediction 验证。

运行：

```bash
FLOWISE_API_KEY=FpPA-... NEWAPI_TOKEN=sk-... python3 scripts/flowise-m1-setup.py
```

输出（2026-07-08 本机实测）：

```
[1/4] ensure OpenAI credential 'newapi-openai' -> new-api (http://localhost:13000/v1)
    credential id: 39718e23-3e2d-4401-a89d-ffcb0c94859d
[2/4] build & save chatflow (ChatOpenAI -> new-api + ReAct Agent + Calculator)
    chatflow id: d87207fd-7a11-4d42-8580-2f03ca58e79d
    chatflow URL: http://localhost:3101/canvas/d87207fd-7a11-4d42-8580-2f03ca58e79d
[3/4] probe A: plain reply (no tool needed)
    HTTP 200
    body: {"text": "Hello! How can I help you today?", ...}
[4/4] probe B: tool call (Calculator: 17 * 23)
    HTTP 200
    body: {"text": "The exact result of 17 multiplied by 23 is 391.", ...}
```

## 工具调用确实发生：ReAct DEBUG trace（决定性证据）

Calculator 是 LangChain 内置工具（本地 JS 求值器），不产生单独的 HTTP 调用，所以不能用"new-api 多一条 log"来证明。code-reviewer 正确地指出原"对照实验"是支持性而非决定性——raw LLM 空响应有他因（见下）。决定性证据用 LangChain 内置的 verbose 通道：

- `vendor/flowise/packages/components/nodes/agents/ReActAgentChat/ReActAgentChat.ts:132` 构造 `AgentExecutor({ verbose: process.env.DEBUG === 'true', ... })`，并 `executor.invoke(..., { callbacks })`，其中 `callbacks` 来自 `additionalCallbacks(...)`——该函数在无 analytic / 无 tracing env 时返回 `[]`（`components/src/handler.ts:516`）。所以 ReAct 路径**不**显式 push Flowise 自己的 `ConsoleCallbackHandler`（后者只在 `ConversationChain` 等 chain 节点里 `new`，见 `ConversationChain.ts:133`）。
- `DEBUG=true` 时 `executor.verbose=true`。`@langchain/classic` 的 `AgentExecutor.onFirstStep`（`executor.cjs:91`）调 `CallbackManager.configure(..., { verbose: this.agentExecutor.verbose })`；`@langchain/core` 的 `CallbackManager.configure`（`callbacks/manager.cjs:467-474`）在 `verboseEnabled` 时自动 `new ConsoleCallbackHandler()`（来自 `@langchain/core/tracers/console`，下称 **LCConsoleCallbackHandler**）并 `addHandler`。该 handler 的 `onAgentAction`/`onToolStart`/`onToolEnd` 直接 `console.log` 带 `[agent/action]` / `[tool/start]` / `[tool/end]` 前缀的行（`tracers/console.cjs:149/158/204`）——**无 winston 包裹、无 `[orgId]:` 前缀、无时间戳**，与 Flowise handler 的 `this.logger.verbose(...)` 路径不同。

> 出处澄清（回应复审）：上一版把 trace 归到"Flowise 的 `ConsoleCallbackHandler`"是错的——ReAct 路径用的是 `@langchain/core` 的 `LCConsoleCallbackHandler`（`@langchain/core/tracers/console`），由 `executor.verbose=true` 经 `CallbackManager.configure` 自动 attach。两者 `name` 都叫 `console_callback_handler`（`console.cjs:46` vs `handler.ts:210`），格式也都带 `[tool/start]/[tool/end]` 前缀，容易混淆；区别在 Flowise 那个走 winston `logger.verbose`、ReAct 这个走裸 `console.log`。复审还担心 `LOG_LEVEL=info` 会 suppress `verbose`——那只对 Flowise handler（winston）成立，LCConsoleCallbackHandler 是直接 `console.log`、不经 winston 级别过滤，所以 `DEBUG=true` 即可看到，与 `LOG_LEVEL` 无关。原始未编辑 stdout 见 `/tmp/flowise-debug.log`（裸 `console.log` 行无时间戳/JSON 前缀，与 winston 的 `{"level":"info",...}` 行交错）。

```bash
# 重启 Flowise 时带 DEBUG=true（与 .env.mil-agents 同库同 chatflow）
cd ~/Projects/Flowise && DEBUG=true pnpm exec flowise start   # :3101
# 再跑 scripts/flowise-m1-setup.py 的 probe B（17 * 23）与一次大数 probe
# server stdout 会交错出现 winston 请求行与裸 console.log 的 ReAct trace
```

probe B（`17 * 23`）的 server stdout（ANSI 已剥；下方为 `/tmp/flowise-debug.log` 原始片段，winston 请求行保留以示出处，ReAct trace 行为裸 `console.log`）：

```
2026-07-08 22:41:32 [INFO]: ⬆️ POST /api/v1/prediction/d87207fd-7a11-4d42-8580-2f03ca58e79d
[chain/end] [1:chain:AgentExecutor > 2:chain:RunnableAgent] [3.57s] Exiting Chain run with output: {
  "tool": "calculator",
  "toolInput": "17 * 23",
  "log": "Thought: Do I need to use a tool? Yes\nAction: calculator\nAction Input: 17 * 23"
}
[agent/action] [1:chain:AgentExecutor] Agent selected action: {
  "tool": "calculator",
  "toolInput": "17 * 23",
  "log": "Thought: Do I need to use a tool? Yes\nAction: calculator\nAction Input: 17 * 23"
}
[tool/start] [1:chain:AgentExecutor > 9:tool:Calculator] Entering Tool run with input: "{"input":"17 * 23"}"
[tool/end]   [1:chain:AgentExecutor > 9:tool:Calculator] [0ms] Exiting Tool run with output: "391"
```

随后第二轮 LLM 调用拿工具 Observation 作答：`Final Answer: The exact result of 17 multiplied by 23 is 391.`。`[tool/start]` 的 input 是 `17 * 23`、`[tool/end]` 的 output 是 `391`——工具名、入参、出参、时序全在 trace 里，构成"Calculator 被调用且产出 391"的直接证据，不再依赖"raw LLM 算不对"的间接推断。

大数 probe（`1234567 * 3456`）的同一 trace（`/tmp/flowise-debug.log`，同 bare-`console.log` 格式）：

```
[agent/action] [1:chain:AgentExecutor] Agent selected action: {
  "tool": "calculator",
  "toolInput": "1234567 * 3456",
  "log": "Thought: Do I need to use a tool? Yes\nAction: calculator\nAction Input: 1234567 * 3456"
}
[tool/start] [1:chain:AgentExecutor > 9:tool:Calculator] Entering Tool run with input: "{"input":"1234567 * 3456"}"
[tool/end]   [1:chain:AgentExecutor > 9:tool:Calculator] [0ms] Exiting Tool run with output: "4266663552"
```

Agent 最终答 `4,266,663,552`，与 `[tool/end]` 的 `4266663552` 一致。一次 agent turn 在 new-api 侧也恰好 2 条 `glm-5.2` 消费（决定调工具 → 综合结果作答），与 ReAct 双 LLM 调用对齐。

### raw LLM 空响应的归因（回应评审：别被假证据带过）

原"对照实验"表把 raw LLM 那栏写成"❌（空响应 / 超时）"未归因。直接打 new-api `/v1/chat/completions`（不经 Flowise）实测，`1234567 × 3456`：

| 调用 | finish_reason | content | completion_tokens | text_tokens |
|---|---|---|---|---|
| `max_tokens=2000` | `length` | `""`（空） | 2001 | 0 |
| `max_tokens=4000` | `length` | `""`（空） | 4001 | 0 |

`finish_reason=length`、`text_tokens=0`、`completion_tokens` 顶到上限——raw LLM 并非拒答或超时，而是把全部预算烧在了不可见的 reasoning 上、text token 始终为 0，到 max_tokens 截断时一个可见字符都没产出。这正说明"raw LLM 给不出精确结果"不能简单等于"模型算不对"，故该对照只作**支持性证据**；决定性证据以上方 ReAct DEBUG trace 为准。（另一例 `1234567 × 789` 在 `max_tokens=4000` 下 `finish_reason=stop` 且直接回 `974073363`——raw LLM 此题竟能答对，进一步证明对照栏的"❌"是 max_tokens 截断假象，不是模型能力边界。）

### M1.5 起

Langfuse 接入（`LANGFUSE_BASE_URL` + public/secret key）后，tool 调用 input/output 会在 trace UI 落盘，届时可不再依赖 server stdout 的 DEBUG 通道。

ReAct 循环也反映在 new-api 日志里（一次 agent turn 产生 2 条 `glm-5.2` 消费日志：推理该用什么工具 → 综合工具结果作答）：

```
13:45:20 | glm-5.2 | prompt=419  completion=807  use_time=13s   # ReAct: 决定调 Calculator
13:45:22 | glm-5.2 | prompt=848  completion=82   use_time=2s    # ReAct: 用工具结果作答
```

> 上方 new-api 双日志只是"一轮 turn 两次 LLM 调用"的旁证（ReAct 决定调工具 ≠ 工具真的被执行）；决定性证据以前面 `[tool/start]`/`[tool/end]` 的 DEBUG trace 为准。

## 产出

- `vendor/flowise/packages/server/.env.mil-agents` — Flowise 指向 mil-agents PG/Redis + 端口 3101
- `scripts/flowise-m1-setup.py` — 程序化建 chatflow + 跑通的脚本
- `docs/m1-flowise-agent-verification.md` — 本文档

chatflow 定义存在 Flowise DB（`chat_flow` 表，id `d87207fd-7a11-4d42-8580-2f03ca58e79d`），非文件——这是 plan 预期的形态（"Flowise 的 chatflow 定义存 DB，非文件"）。

## 下游 / 后续

- **M1.4**：gateway `POST /api/v1/flows/:id/prediction` 代理到 Flowise，把 run_id 透传过去。
- **M1.5**：Flowise 接 Langfuse（`LANGFUSE_BASE_URL` + public/secret key）。
- **M2.8**：gateway 代理 new-api 后，ChatOpenAI 的 `basepath` 改指 gateway，token 换 gateway 签发。
