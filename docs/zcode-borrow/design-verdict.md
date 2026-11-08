# 设计文档：R5 结构化提交裁决（platformAgent outputSchema 三值裁决）

> 方向：提交裁决（R5）· 需求定稿见 `docs/zcode-borrow/requirements.md` R5 节（AC-R5-1 ~ AC-R5-6）。
> 本文所有 `path:line` 锚点均在 2026-10-07 分支 `feat/zcode-borrow` 工作区逐处核验。
> 撞车检查：`docs/zcode-borrow/` 下尚无其他 `design-*.md`；本设计与可恢复性方向（R1/R7/R8）的共享面仅在 `workflow-clients.ts` / `types/execution.ts` / `span output.events` 三处，均为「追加式」改动，边界见 §9。

---

## 0. 现状摸底结论（先读这一节，后面全部决策由它推出）

| # | 现状事实 | 锚点 |
|---|---|---|
| F1 | LLM 节点已有 outputSchema 全链：声明 → 解析（json 字符串/对象双形态）→ schema 编进 system 头 → 校验 + **一轮**修复回喂 → 仍失败诚实抛错；命中后输出带 `json` 字段 | `packages/workflow/src/nodes/llm/llm.node.ts:53-61`、`:86-96`、`:192-200`、`:236-293`、`:294-302`、`:268` |
| F2 | platformAgent 完全没有 outputSchema（inputs 仅 agentId/systemPrompt/maxIterations）；工具循环 messages 数组在节点作用域（回喂 push 点现成）；maxIterations 耗尽只追加尾注不追问；空产出守卫立即 throw | `packages/workflow/src/nodes/platform-agent/platform-agent.node.ts:39-60`、`:131-203`、`:205-212`、`:216-218` |
| F3 | **claude 适配器已实现 `--resume`**：`ExecOptions.resumeSessionId` → `args.push('--resume', …)`，且 `--resume` 在 `CLAUDE_BLOCKED_ARGS` 由后端独占；`AgentResult.sessionId` 回传会话 id（从 stream-json `session_id` 帧采集） | `packages/agent-adapters/src/claude.ts:113-114`、`:130-139`、`:663`、`:758-766`；契约 `packages/contracts/src/agent.ts:60-61`、`:133-134` |
| F4 | CLI 客户端每次 `chat()` 都 `startSession` 新 spawn、全部 messages 经 `buildCliMessages` 折叠单 prompt；chat 返回 `{text, usage}`——**sessionId 丢在客户端层没有回传**；修复轮的会话延续缺最后一根线 | `apps/gateway/src/routes/workflow-clients.ts:286-315`、`:173-187`、`:317-408`（`:404` 返回值无 sessionId） |
| F5 | `SchemaIssue` 现只有 `path + message`；错误消息已是中文人话（"应为 X，实际是 Y"），但无结构化 expected/got 字段 | `packages/workflow/src/utils/json-schema-lite.ts:18-21`、`:41-43`、`:46-48`、`:70-74` |
| F6 | 过程事件链路：`IStreamDelta{type:'activity',kind,label,detail}` → `onNodeDelta` → span-writer `events` 全量日志（JSONB，带保险丝）+ `activity` 策展环；kind 词表 `thinking/tool/tool_result/status/log/error/user_input` | `packages/workflow/src/types/execution.ts:111-126`；`apps/gateway/src/span-writer.ts:136-141`、`:222-277` |
| F7 | console 侧 kind 白名单共**四处**：终端 `LINE_KINDS` + `TerminalLineKind`、轨迹 `TRACE_LINE_KINDS`（DB 路 `:88` 与直播路 `:385` 同源引用）、摘要 `ACTIVITY_KINDS` + `activityIcon`、终端行 icon `lineIcon`（default 'point' 兜底） | `apps/console/src/lib/run-terminal-format.ts:22-30`、`:62-70`；`apps/console/src/lib/run-trace-model.ts:88-96`、`:385-386`；`apps/console/src/components/canvas/canvas-results-panel.tsx:86-87`、`:150-159`；`apps/console/src/components/run-terminal.tsx:211-223` |
| F8 | 直播路未知 kind **降级 `log` 行不丢**（`TRACE_LINE_KINDS.includes` 失败 → kind:'log'）——老 console 消费新 kind 天然兼容，白名单同步只是样式升级而非正确性前提 | `apps/console/src/lib/run-trace-model.ts:385-389` |
| F9 | run-live 契约 `RunLiveDelta.activity.kind` 是**宽松 string**（"structural twin"注释要求与 IStreamDelta 人肉同步）；`nodeEnd.status` 仅 done/failed——轮次不新开 span 段则帧形状零变更 | `packages/contracts/src/run-live.ts:41-46`、`:59-66` |
| F10 | CLI spawn 闸指标 `dagents_cli_spawn_total/active/waiting` 现成（AC-R5-2 仪器）；mock server 谓词 `userContains/systemContains/toolResultContains/modelIs` + `/__control` 规则编排面现成（AC-R5-1 仪器） | `apps/gateway/src/lib/cli-spawn-gate.ts:31-39`；`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs:31-35`、`:178-188` |
| F11 | 引擎装配处 CLI kind 恒为 `'claude'`（`createDefaultLlmClient('claude', …)`）；platformAgent 的 `agentConfig.kind` 目前不参与后端选择 | `apps/gateway/src/routes/workflow-engine-service.ts:108`；`packages/workflow/src/types/execution.ts:249-261` |
| F12 | `{{id.json}}` 引用零引擎改动：模板解析按点路径 `getByPath(state,'id.json')` 命中输出对象的 json 键，对象自动 JSON 化 | `packages/workflow/src/utils/variables.ts:37-44` |
| F13 | flow_data schema 是 passthrough（新 inputs 字段无需 schema 变更）；inspector 表单由注册表声明式驱动（加参数=UI 自动出现，json 控件带即时校验红框） | `packages/workflow/src/utils/flow-data.ts:12-22`；`packages/workflow/src/nodes/node-registry-canvas.ts:169-176`（LLM 节点 outputSchema json 控件先例） |

---

## 1. 数据模型与迁移

**结论：零 DB 迁移、零新表、零新列。** 载体全部复用既有 JSONB：

1. **声明面**：`outputSchema` 存 `flows.flow_data` JSONB 的 `nodes[].data.inputs.outputSchema`（字符串或对象双形态，与 LLM 节点同约定，F1/F13）——`flowDataSchema` data 是 passthrough，无 schema 变更。
2. **过程面**：裁决轮事件（第 N 轮裁决/回喂内容/结果/会话延续方式）走 `IStreamDelta` → span `output.events`（`EventEntry {kind,label,detail,at}`，F6）——既有全量日志载体，保险丝（800 条/64KB 单条/1MB 总量，`span-writer.ts:125-127`）原样生效。
3. **终态面**：合规产出的解析对象挂节点 `output.json`（LLM 节点同款，F1）；最终失败原因（含 path/expected/got 清单）走节点 error → `run_node_spans.error`（`span-writer.ts:212-218` 既有落点）。
4. gateway 单测库 `dagents_gw_test` 迁移链零触碰（NFR-1 自然满足）。

理由：R5 的所有新状态都是**节点运行内的瞬态**（轮次、裁决、回喂消息），持久化需求只到「可观测/可回放」粒度——span events 已是这个粒度的既有真相源。R1 的 journal/实例键、R7 的 seq 是**跨轮次/跨进程**的执行模型关注点，R5 不掺和（见 §9 边界）。

## 2. 契约变更（@dagents/contracts + @dagents/workflow 类型层）

### 2.1 @dagents/contracts —— **零强制变更**（红利确认）

- `ExecOptions.resumeSessionId`（`packages/contracts/src/agent.ts:60-61`）与 `AgentResult.sessionId`（`:133-134`）**已存在**，claude 后端已接线（F3）——PRD 涉及面所列「`packages/agent-adapters`（claude resume 旗标）」经核验**无需改动**，`--resume` 在 `claude.ts:114` 已生效且被 `CLAUDE_BLOCKED_ARGS`（`:136`）保护不被调用方覆盖。
- `RunLiveDelta` 的 `activity.kind` 是宽松 `string`（`packages/contracts/src/run-live.ts:45`）——新 kind `verdict` 帧形状兼容，**文件零改动**；仅按该文件头注释「keep the shapes in sync」的纪律，在 `IStreamActivityKind`（workflow 侧）注释里补一句与 RunLiveDelta 的同步说明。

### 2.2 @dagents/workflow 类型层（真正的契约变更，全部追加式）

**`packages/workflow/src/types/execution.ts`** 三处：

1. `IStreamActivityKind`（`:111-112`）追加 `'verdict'`——裁决域专属活动（第 N 轮裁决/回喂/结果），与 `user_input`（同为宿主合成事件，`:107-110` 注释先例）同一性质：不是 CLI AgentEvent 的直译，是节点层合成的审计事件。
2. `llmClient.chat` params（`:165-196`）追加可选 `resumeSessionId?: string`——语义：「非空 = CLI 后端以 `--resume` 恢复该会话，本次 messages 只含增量消息（不含历史重放）；后端不支持时忽略并在过程流留痕」。**取值单源（评审终裁，2026-10-07）**：该字段**只承载上一轮 chat 返回的后端真实会话 id**（claude 由 stream-json `session_id` 帧自生成，`claude.ts:663` 采集）；**严禁注入任何宿主自铸 id**——R8 的 `deriveSessionId(runId,nodeId,ordinal)` 属另一 id 空间（run 级寻址键，供 runNodeSinks 键拼写与跨进程重挂查表），**绝不进 `ExecOptions.resumeSessionId`**（自铸 id 不对应任何真实 claude 会话，`--resume` 必炸首跳）。
3. `llmClient.chat` 返回（`:197`）追加可选 `sessionId?: string`——「本次调用的 CLI 会话 id；缺席 = 该后端无会话延续能力（HTTP provider 无状态 / 适配器无 resume）」。

**能力披露协议（设计定稿，即 resumeSessionId 取值单源）**：节点层**不感知后端类型**（HTTP/claude CLI/其他 CLI），只看上一轮 `chat` 返回是否带 `sessionId`：带 → 修复轮**原样透传该后端会话 id**（`resumeSessionId = 上一轮返回值`，同会话修复，只发增量消息）；不带 → messages 数组全量追加回放（逻辑会话）+ 过程流「会话重建」活动行。取值链路唯一：`chat 返回 sessionId → 修复轮透传 → ExecOptions.resumeSessionId → claude --resume`，中间无任何换算/铸造。这样 R8 未来引入 per-kind 客户端、或更多适配器获得 resume 能力时，节点层零改动自动升级。

**`packages/workflow/src/utils/json-schema-lite.ts`**：`SchemaIssue`（`:18-21`）追加两个可选字段：

```ts
export interface SchemaIssue {
  path: string
  message: string
  /** 期望值的紧凑表达（schema 侧）：如 'string'、'enum: ["accept","reject"]'、'必填字段存在' */
  expected?: string
  /** 实际值的紧凑表达（产出侧）：如 'number'、'缺失'、值的前 80 字 JSON 摘要 */
  got?: string
}
```

填充点（walk 函数内逐分支，`:41-43` type 不匹配 / `:46-48` enum / `:53-56` 长度 / `:62-63` 边界 / `:70-74` 必填缺失）：

| 分支 | expected | got |
|---|---|---|
| type 不匹配 | `schema.type` | `typeName(value)`（`:111-115` 复用） |
| enum 未命中 | `JSON.stringify(schema.enum)` | `JSON.stringify(value)`（截 80 字） |
| minLength/maxLength | `长度 ≥ min` / `长度 ≤ max` | `长度 ${value.length}` |
| minimum/maximum | `≥ min` / `≤ max` | `${value}` |
| 必填缺失 | `必填字段存在` | `缺失` |

可选字段 + `message` 语义不变 → **既有消费方（`llm.node.ts:288` 的 `- ${i.path}: ${i.message}` 格式化）零改动零回归**；`deepEqual`/`walk` 判定逻辑零改动（纯增量）。

### 2.3 契约常量（预算词表单点化）

`packages/workflow/src/nodes/platform-agent/platform-agent.node.ts` 导出：

```ts
/** R5 三值裁决预算上限（PRD 定稿值，禁止实现层私调——见 requirements.md R5 需求 3）：原始执行 + 1 轮修复回喂 + 1 轮 NUDGE 追问 */
export const VERDICT_MAX_INTERACTIONS = 3
```

不设 env 旋钮（PRD 明言「NUDGE 放宽尺度若产品后续要调，必须改本 PRD 定稿值，不许实现层私调」——env 即私调面）。LLM 节点的一轮修复预算（`llm.node.ts:239` 的 `attempt < 2`）**不动**（R5 范围外，保持回归基线）。

## 3. 引擎 / 路由 / gateway 改动

### 3.1 核心：`platform-agent.node.ts` 三值裁决状态机

把现有 while 工具循环（`:144-203`）提为私有方法 `runToolLoop()`（纯搬运，行为不变：返回 `{ finalText, truncated, usage }`，`truncated` = 尾注分支条件 `iterations >= maxIterations && lastToolCallIds.length > 0`，`:208`），外面包裁决循环：

```text
声明了 outputSchema 时（未声明 = 现状路径原样，零行为变更）：

round = 0; usedRepair = false; usedNudge = false; lastSessionId = undefined
loop:
  round += 1
  { finalText, truncated, usage } = runToolLoop(...)   // 每轮独立 maxIterations 预算
  verdict = adjudicate(finalText, truncated, responseSchema)
  emitVerdictActivity(round, verdict)                   // kind:'verdict'，见下
  if verdict.kind === 'accept':
    return { ..., output: { text, content, json: verdict.parsed } }   // {{id.json}} 天然可引用（F12）
  if round >= VERDICT_MAX_INTERACTIONS: throw 诚实失败    // 错误文本含最后一轮全部 issues 的 path/expected/got
  if verdict.kind === 'violations' && !usedRepair:
    usedRepair = true; feedRepair(verdict.issues)        // 修复回喂
  else if verdict.kind === 'no-deliverable' && !usedNudge:
    usedNudge = true; feedNudge()                        // NUDGE 追问
  else:
    throw 诚实失败（预算内无合规产出——同类型第二次发生即无轮可用）
```

**裁决函数 `adjudicate`（三值判据，定稿）**：

| 值 | 判据 | 动作 |
|---|---|---|
| `accept` | `extractJsonFromText(text)`（`json-schema-lite.ts:122-135` 复用）成功且 `validateAgainstSchema` 空 | 收下，output 带 `json` |
| `violations` | 文本非空、非截断；JSON 解析失败（issue `path:'$'`，expected `JSON 对象`，got 文本前 80 字）**或**校验非空（issues 携 expected/got） | 修复回喂 |
| `no-deliverable` | `truncated == true`（maxIterations 耗尽工具仍 pending，`:208` 判据）**或** `finalText.trim() === ''` | NUDGE 追问 |

关键裁决：**截断优先于文本内容**——maxIterations 耗尽意味着模型没有交付最终答案，NUDGE（"停止调工具，直接交付"）语义精确；若有残余文本则不进 violations（修格式救不了没干完的活）。

**空产出守卫的让位（行为变更点，显式列出）**：现状 `finalText` 为空立即 throw（`:216-218`）。声明 outputSchema 时空文本降级为 `no-deliverable` → NUDGE 一轮；NUDGE 后仍空 → 诚实失败。未声明 outputSchema 的节点守卫原样（零回归）。这与 PRD 需求 2 ③「轮次结束未交付 → NUDGE 式追问一次」直接对应。

**回喂消息形状（push 进既有 messages 数组，`:131-203` 作用域）**：

- 修复回喂（violations）：
  ```
  messages.push({ role: 'assistant', content: finalText })
  messages.push({ role: 'user', content:
    '你上一条输出不符合节点 outputSchema，违规明细（路径/期望/实际）：\n' +
    issues.map(i => `- ${i.path}：期望 ${i.expected ?? i.message}，实际 ${i.got ?? '（见消息）'}`).join('\n') +
    '\n请重新输出——只输出修正后的 JSON，不要任何其他文字、不要调用工具。' })
  ```
- NUDGE 追问（no-deliverable）：
  ```
  messages.push({ role: 'assistant', content: finalText || '(本轮无正文输出)' })
  messages.push({ role: 'user', content:
    '本轮未交付最终结果（工具调用预算耗尽或无正文）。请立即停止调用工具，' +
    '直接输出符合本节点 outputSchema 的最终 JSON——只输出 JSON 本体。' })
  ```

**会话延续分支（能力披露协议，§2.2）**——回喂轮发起下一次交互前：

```text
if (lastSessionId) {                                    // claude 档：native 会话延续
  chatParams = { resumeSessionId: lastSessionId, messages: [本轮 user 回喂消息] }   // 只发增量
  emitVerdictActivity(..., mode: 'resume')
} else {                                                // HTTP / 无 resume 能力的 CLI：逻辑会话回放
  chatParams = { messages }                             // 全量数组（默认已是累积态）
  emitVerdictActivity(..., mode: 'replay')
}
```

`lastSessionId` 在每轮 `chat` 返回后更新（`result.sessionId`，§3.2）。**「会话重建」活动行由节点层统一发**（不区分 HTTP/CLI——两态 label 见 §3.1.1），e2e mock（HTTP）路径可断言（AC-R5-4 的「同一 mock 脚本两档对照」里 mock 是回放档）。

**修复轮禁用工具声明**（可选优化，定稿为**做**）：修复/NUDGE 轮的 chat 调用不再传 `tools`（工具循环裸跑一次 chat 拿最终答案）——修复轮的目的是交付格式合规的最终 JSON，给工具只会再引入截断风险。HTTP 后端下修复轮退化为单次 chat（与 LLM 节点修复循环同构）；CLI 后端下 `--resume` 会话内 claude 自带工具不受此参影响（workflow-clients 的 tools 本就只对 HTTP 生效，`workflow-clients.ts:288-291` 的 textModeArgs 判定按 tools 缺席收紧——顺带利好：claude 修复轮自动落文本档）。

### 3.1.1 裁决活动事件（kind: 'verdict'，可观测契约）

经 `options.onNodeDelta`（`execution.ts:162`）发三类活动（label/detail 保真契约，`execution.ts:114-126`——全文不截断，短摘要由展示层派生）：

| 时机 | label（示例） | detail |
|---|---|---|
| 回喂时 | `第 2 轮 · 违规修复回喂（同会话 --resume / 会话重建·对话回放）` | 全部 issues 的 `- path：期望 X，实际 Y` 行，或 NUDGE 全文 |
| 裁决后 | `第 2 轮裁决：accept（合规收下） / violations（2 项违规） / no-deliverable（未交付）` | 违规明细行（violations 时） |
| 终局失败 | `裁决预算耗尽（3 次交互），节点诚实失败` | 最后一轮 issues 全文 |

落点链路零新增：`onNodeDelta` → span-writer events（`span-writer.ts:241-242`）→ run-live 直播帧（`workflow-engine-service.ts` 钩子收口）→ console 三视图（F7）。**不新开 span 段**——同一 `runNodeSinks`/onNodeStart 生命周期内多轮，轨迹视图「同段内多轮」（R5 需求 5 的视觉区分由 kind 驱动样式，§4）。

### 3.2 gateway：`workflow-clients.ts` CLI 会话延续接线（四行级改动）

1. `CliChatParams`（`:155-166`）追加 `resumeSessionId?: string`（取值单源约束见 §2.2——gateway 只透传节点层递来的后端真实会话 id，本层不做任何 id 换算）。
2. `startSession`（`:286-315`）把 `params.resumeSessionId` 透传进 `backend.execute` 的 `ExecOptions`（`:295-304` 的 options 对象加一行）——claude 后端 `buildClaudeArgs:114` 自动转 `--resume`；其余适配器忽略该字段（contracts 语义「Non-empty resumes…」，`agent.ts:60-61`，不支持者静默无效果，能力披露协议靠返回值兜底）。
3. `chat` 返回（`:404`）追加 `sessionId: result.sessionId`（`result` 在 `:350` 已就位）。**`chatStream` 不动**——platformAgent 工具循环与 LLM 修复循环都只走 `chat`（`platform-agent.node.ts:146`、`llm.node.ts:240`），流式路径无裁决诉求，`IChatStreamChunk` 形状零变更。
4. `createDefaultLlmClient.chat` 的 HTTP→CLI 降级路径（`:548-555`）天然透传（params 整体转交）；HTTP `createLlmClient.chat`（`:667-733`）返回值不带 sessionId（无状态后端的诚实缺席）。

**systemPrompt 与 resume 的交互（定稿）**：resume 轮的 `buildCliMessages`（`:173-187`）只折叠本次传入的增量消息——节点层只发 `[user 回喂消息]`，折叠结果 `systemPrompt = undefined` → `buildClaudeArgs:113` 的 `if (opts.systemPrompt)` 天然跳过 `--append-system-prompt`，不会把 system 头（含 schema 契约块）重复注入。schema 契约块已在原始轮进会话，CLI 会话文件自持。

### 3.3 声明面：`platform-agent.node.ts` inputs + `node-registry-canvas.ts` 注册

- 节点 `inputs`（`:39-60`）追加 `outputSchema`（`type:'json'`、`rows:6`、`default:''`、description 同 LLM 节点措辞口径改写为三值裁决语义），解析逻辑复用 LLM 节点双形态收法（`llm.node.ts:86-96`：json 字符串 JSON.parse 失败 → throw「outputSchema 不是合法 JSON」；对象原样收）。
- `CANVAS_NODES` 的 platformAgent 段（`node-registry-canvas.ts:79-131`）镜像追加同款 input + `defaultData.outputSchema: ''`——inspector json 控件即时校验红框自动出现（F13，AC-R5-5 前半零新组件）。
- **不进 `validateFlowTopology`**：outputSchema 是运行时行为参数而非结构/权限声明，LLM 节点先例即运行时解析失败即抛（保存不阻断，与 R4 声明校验的取舍不同——R4 的 fail-closed 是安全边界，R5 是产出质量约定，错误即可恢复的配置笔误）。
- **不教 flow-generator 产 outputSchema**（PRD R5 未要求；生成管线是 R4 的改造面）。用户手填 / 模板 JSON 手工携带均可。

## 4. console 改动

全部是「白名单 + 样式」追加式小改（依赖 F8 的降级兜底，老数据/漏改处不崩）：

| 文件 | 改动 |
|---|---|
| `apps/console/src/lib/run-terminal-format.ts:22-30` | `TerminalLineKind` 联合加 `'verdict'` |
| `apps/console/src/lib/run-terminal-format.ts:62-70` | `LINE_KINDS` 加 `'verdict'`（events 解析放行） |
| `apps/console/src/lib/run-trace-model.ts:88-96` | `TRACE_LINE_KINDS` 加 `'verdict'`（DB 路 + 直播路 `:385` 同源生效；不改为降级 log 而有专属台账行） |
| `apps/console/src/components/canvas/canvas-results-panel.tsx:86-87` | `ActivityKind`/`ACTIVITY_KINDS` 加 `'verdict'` |
| `apps/console/src/components/canvas/canvas-results-panel.tsx:150-159` | `activityIcon` 加 `verdict → 'checkCircle2'`（或同义 IconName，实现时按 `IconName` 词表取） |
| `apps/console/src/components/run-terminal.tsx:211-223` | `lineIcon` 加 `case 'verdict'`；`LineView` 的 verdict 行样式复用 status 行形态 + 可区分色（CSS 就近 import，遵守孤儿 CSS 护栏——若加类名则同步 `canvas-results.css`/`run-terminal` 同目录样式） |

- **AC-R5-5「最终失败的 schema 违规对照在摘要视图行内可读」**：零新组件——失败行内错误渲染 `canvas-results-panel.tsx:596-597`（`canvas-result-err-inline` + `title` 全文）直接承载节点 error 文本（§3.1 的诚实失败错误含 path/expected/got 清单）。
- **i18n**：零新 `t()` 词条。理由：本需求无新界面组件/文案——inspector 配置项 label/description 来自注册表（现状即裸中文描述串，见 `node-registry-canvas.ts:97-122` 既有模式）；终端/轨迹行文本（裁决活动 label、错误文本）全部是服务端生成的过程数据（与「── 插话已并入 ──」`workflow-clients.ts:337` 同类，现状即服务端中文裸串）。NFR-4 管的是「新界面文案」，本需求没有新界面面。**同名注记（评审 2026-10-07）**：本设计的「会话重建」是 span events 里的服务端活动 label（非 t() 词条）；可恢复性方向若在 `en/flows.ts` 加同名中文键「会话重建」，两者语义来源不同、不冲突，但**合并时勿两头都加**——客户端词条管 UI 面板文案，服务端 label 管终端/轨迹行，互不引用。若实现中确需客户端提示文案，届时 `t('中文')` + `apps/console/src/i18n/en/flows.ts` 补词条（此为条件项，不是本设计范围）。

## 5. 兼容与存量 run 数据策略

1. **存量 flow**：未声明 outputSchema 的 platformAgent 走原路径（§3.1 状态机仅在新声明时激活）——工具循环、尾注、空守卫行为逐字节不变。`flowDataSchema` passthrough（F13），老 flow JSON 无需迁移。
2. **存量 run 数据**：span `output.events` 旧条目 kind 均在旧词表内，console 白名单是**超集**扩展（只加不减）——旧数据渲染零回归（AC-R5 相关的隐性回归面不存在）。
3. **新旧 gateway/console 混布窗口**：新 gateway 发 `verdict` 帧 → 老 console 直播路降级 `log` 行（F8）、DB 路被 `TRACE_LINE_KINDS` 过滤跳过（`run-trace-model.ts:110`）——不崩不误导（丢样式不丢数据的前提是 console 白名单同步合入；按 §8 分步，console 改动与 gateway 同批交付，此窗口仅存在于灰度期，行为可接受且诚实）。
4. **llmClient 接口**：params/返回值均为可选字段追加——自定义 llmClient 注入方（测试 mock、未来 R10 fake client）零破坏；不带 sessionId 的实现自动落回放路径（能力披露协议的反向兼容）。
5. **HTTP provider 场景**：修复轮全量 messages 重放是 OpenAI 无状态 API 的标准行为，非降级（活动行 mode 标注为 replay 属如实描述，不构成告警语义）。
6. **e2e 既有断言**：mock provider 场景 platformAgent 未声明 outputSchema 时行为不变——既有 spec 零更新（NFR-2）。
7. **run_node_spans 状态 CHECK（评审全体条目，2026-10-07 知悉声明）**：`run_node_spans_status_chk CHECK (status IN ('running','done','failed','paused','unknown'))`（`packages/db/src/migrations/1720000007000-create-run-node-spans.ts:57-58`，此后无迁移触碰）。**R5 不是该词表的写方**：裁决轮不新开 span 段（§3.1.1），span 终态仍只落既有 done/failed（`span-writer.ts:212` 既有映射），verdict 活动是 `output.events` JSONB 内的 kind 而非 status 列——R5 对该 CHECK 零依赖、不消费 design-sharp 持有的放宽迁移 `1720000106200`（词表 `+'rejected','cached','stopped'`）。知悉「迁移先行、写方随后」已升格为三方（recover/artifacts/sharp）共同前置纪律；R5 未来若引入任何新 span 状态词，同样须先过该类 CHECK 放宽迁移，不得直写。

## 6. 测试计划

### 6.1 单测（vitest，`packages/workflow`）

- `platform-agent.node.test.ts` 扩展（沿用现有 capture mock client 形态，`:18-45`）：
  - accept 首轮直收：mock 返回合规 JSON → 输出带 `json` 字段、零回喂消息、零 verdict 活动；
  - violations→repair→accept：第 1 轮违规（enum 未命中 + 必填缺失）→ 断言第 2 次 chat 的 messages 尾部 user 消息含 `path/期望/实际` 三元组文本 → 第 2 轮合规收下（AC-R5-1 的单测层钉子）；
  - no-deliverable→nudge→accept：mock 返回空文本 → NUDGE 消息含「停止调用工具」→ 第 2 轮合规收下；
  - 截断优先：`truncated`（尾注路径 `:208` 同款条件）+ 残余违规文本 → 判 no-deliverable 走 NUDGE（非 repair）；
  - 两轮耗尽诚实失败：恒违规 mock → throw 错误文本含 `path`、`期望`、`实际` 字样、无空壳成功（AC-R5-3）；
  - 预算钉死：恒违规场景 chat 调用计数恰 `3`（原始+修复+NUDGE）；恒空文本场景恰 `2`（nudge 用尽后同类第二次直接失败——类型去重分支）；上限常量 `VERDICT_MAX_INTERACTIONS === 3` 断言（AC-R5-6）；
  - 会话延续两档对照：mock client A（chat 返回带 `sessionId:'s1'`）→ 第 2 次 chat params 带 `resumeSessionId:'s1'` 且 messages 只含增量；mock client B（不带 sessionId）→ 第 2 次 chat messages 全量重放 + `会话重建` 活动（AC-R5-4 单测层；两档裁决结果一致）；
  - verdict 活动：onNodeDelta 收到 `kind:'verdict'` 且 label 含轮次/结果、detail 含违规行（可观测契约钉子）；
  - 无 schema 回归：不声明 outputSchema → 现有三测（节点级指令/降级/空守卫 `:47-113`）原样通过。
- `json-schema-lite` 补测（新建 `json-schema-lite.test.ts` 或并入最近测试文件）：五类分支的 expected/got 填充逐项断言；旧调用（只读 path/message）不受影响。
- `workflow-clients` 侧（gateway 单测库）：`createCliLlmClient` chat 返回透传 `result.sessionId`；`resumeSessionId` 进 `ExecOptions`（mock backend 断 execute 参数）。

### 6.2 e2e（`apps/console/tests/e2e/`，Mock LLM Provider :4010）

- 新 spec（建议 `25-agent-verdict.spec.ts`）：
  - **AC-R5-1**：flow = start → platformAgent(声明 outputSchema) ；mock 脚本 rule1 `userContains`（原始输入）→ 违规 JSON，rule2 `userContains`（回喂消息特征子串，如 `期望`）→ 合规 JSON；断言：run 成功、`/__control/calls` 证明第 2 次请求 messages 含修复 user 消息、上游若再加一个 LLM 节点则其调用数前后不变（零重调）、node-spans 的 events 含 verdict 行；
  - **AC-R5-6 e2e 面**：mock 恒违规 → 节点失败、mock 调用数恰 3、span error 含 path 定位；
  - **AC-R5-5**：inspector 打开 platformAgent 节点见 outputSchema json 控件（与 LLM 节点同控件断言）；失败 run 摘要视图行内错误文本可见（`canvas-result-err-inline`）。
- **AC-R5-2（claude 档）——口径修正案已获批（评审 2026-10-07），修正口径为验收唯一口径**：PRD 原文「修复轮不重 spawn（/metrics CLI spawn 计数不增）」与 `--resume` 的物理现实冲突：claude `-p` 一次问答即退（`claude.ts:758-766` result 即终局），裁决必须等最终文本，**不存在进程复用窗口**；PRD 需求 4 自己已把「同进程会话延续」定义为「`--resume` 类适配器能力」——其语义实质是**同一 CLI 会话**（session id 守恒、上下文由会话文件自持、修复轮只发增量），OS 进程必然重 spawn（`dagents_cli_spawn_total` +1，走同一 spawn 闸 `cli-spawn-gate.ts`）。**断言口径（已回写 requirements.md AC-R5-2，单一真相源）**：① 修复轮 chat 返回的 `result.sessionId` === 原始轮（会话守恒，单测 + 真机 smoke 可钉）；② 过程流无 `会话重建` 活动行（mode = resume）；③ `/metrics` spawn 计数恰 +1 而非 +N（无逐轮会话链泄漏）。
- **AC-R5-4 e2e 面**：mock（HTTP）即回放档——断言 `会话重建` 活动行存在；claude 档对照由单测 + `scripts/real-cli-smoke.sh` 扩展一个 `--resume` 冒烟用例承担（claude 已真机 PASS 的适配器域，`:114` 旗标本身有单测覆盖）。

### 6.3 不做的测试（诚实边界）

- 不为「16 个 docs-only 适配器」写 resume 用例——能力披露协议下它们自动落回放路径，行为由 HTTP/claude 两档覆盖（PRD「不可承诺」原则）。

## 7. 涉及文件清单（ownedFiles）

**独占**：

1. `packages/workflow/src/nodes/platform-agent/platform-agent.node.ts`（裁决状态机 + outputSchema 声明 + verdict 活动）
2. `packages/workflow/src/nodes/platform-agent/platform-agent.node.test.ts`（扩展）
3. `apps/console/tests/e2e/25-agent-verdict.spec.ts`（新建；编号 25 与 artifacts/sharp 的 25- 前缀重号——仓库已有双 24 先例（`24-run-resume.spec.ts` 与 `24-run-trace-view.spec.ts` 并存），Playwright 不依赖编号唯一，文件名各异无物理冲突；集成期若统一分配 25/26/27 则以实施期定稿为准）
4. `docs/zcode-borrow/design-verdict.md`（本文档）

**共享（全部为追加式改动，标注冲突协调）**：

5. `packages/workflow/src/utils/json-schema-lite.ts`——SchemaIssue 加可选字段；R4/其他方向若同动此文件，以字段追加不碰判定逻辑为界
6. `packages/workflow/src/types/execution.ts`——IStreamActivityKind 加词 + chat 签名两处可选字段；**多方同文件追加（共享，合并批次对账）**：R8 会话铸造/R1 实例键（`IExecutionContext`/`sessionId`）、R4 `execRunner`、R10 `trialMode`——全部追加式互不覆盖；`IStreamActivityKind` 词表行若 R4/R10 亦加词（R5 加 `'verdict'`），同一 PR 合并为宜
7. `packages/workflow/src/nodes/node-registry-canvas.ts`——platformAgent 段加 input + defaultData；R4 声明字段同文件追加
8. `apps/gateway/src/routes/workflow-clients.ts`——CliChatParams/startSession/chat 返回三小处；**R8（会话铸造/pin）、R1（journal）同文件**，改动点不重叠（本设计只动 `:155-166`/`:286-315`/`:404` 邻域）
9. `apps/console/src/lib/run-terminal-format.ts`——TerminalLineKind/LINE_KINDS 加词；R2 cached 行同文件追加
10. `apps/console/src/lib/run-trace-model.ts`——TRACE_LINE_KINDS 加词；R2/R7（seq 排序）同文件
11. `apps/console/src/components/canvas/canvas-results-panel.tsx`——ACTIVITY_KINDS/activityIcon 两小处；**R2/R3/R6 按 NFR-5 合并批次动刀**，本设计仅白名单级追加，主动避让其批次
12. `apps/console/src/components/run-terminal.tsx`——lineIcon case + verdict 行样式
13. `packages/agent-adapters/src/claude.ts`——**零改动**（列出以显式排除：`--resume`/sessionId 已就位，F3）

## 8. 分步实施（每步可独立合入、可回滚）

| 步 | 内容 | 交付物 | 可恢复性说明 |
|---|---|---|---|
| **①地基：契约 + 校验器扩展 + 裁决核心（workflow 包内闭环）** | json-schema-lite expected/got（+单测）；types/execution.ts 三处追加（+注释同步说明）；platform-agent.node.ts 裁决状态机 + inputs 声明 + VERDICT_MAX_INTERACTIONS；node-registry-canvas 注册；platform-agent.node.test.ts 全量单测 | workflow 包独立可合：此状态下所有后端都无 sessionId 返回 → 修复轮全走回放路径 + 「会话重建」活动行，**功能已完整**（HTTP mock e2e 的 AC-R5-1/3/5/6 可先行验收） | 地基=契约+裁决核心；无迁移（§1 零迁移），回滚 = revert 单包 |
| ②gateway CLI 会话延续 | workflow-clients 四小处接线（§3.2）+ gateway 单测 | claude 档自动升级为 `--resume` 同会话修复（回放活动行消失、resume 活动行出现）；HTTP 路径无感知 | 依赖①的能力披露协议；②失灵时最坏回落回放路径（能力披露反查 sessionId 失败即回放）——降级安全 |
| ③console 白名单 + 样式 | §4 六文件小改 | verdict 行三视图专属样式；摘要行内错误可读（AC-R5-5 全量验收） | 依赖①的活动产生（无①时无数据、改动空转无害）；F8 兜底保证乱序合入不崩 |
| ④e2e + 真机 smoke | 新 spec + mock 规则脚本；real-cli-smoke.sh 加 resume 冒烟（可选） | AC-R5-1/2/4/5/6 全量钉子 | 依赖①③；②非 e2e 前置（mock 是 HTTP 回放档） |

## 9. 与其他方向的边界（防撞车）

- **R1/R7（journal/seq）**：R5 的轮次事件是 `IStreamDelta` 产出方，不感知存储真相源；R7 journal 化后 events 换数据源，R5 零改动（契约形状 RunLiveDelta 不变，F9）。R5 风险注记「轮次信息只能进 events——契约需与 R7 seq 对齐」已由「不新开 span 段、纯 delta 流」消解：seq 对 R5 而言只是透传排序，无 R5 侧设计依赖。
- **R8（会话身份/模型 pin）**：两个 id 空间已按评审终裁划界（2026-10-07）——**`ExecOptions.resumeSessionId` 只承载后端真实会话 id，R5 能力披露协议是它的取值单源**（chat 返回 → 修复轮透传，缺席 = 不传）；R8 的 `deriveSessionId(runId,nodeId,ordinal)` 是 **run 级寻址键**（runNodeSinks 键 `runId:nodeId:ordinal` 的确定性拼写与跨进程重挂查表），**不进 ExecOptions**——若 R8 实施时把自铸 id 注入 startSession 的 resumeSessionId，claude 档全部节点首跳即炸（自铸 id 无对应会话），此为双方共同红线。R8 落地后若需「修复轮跨进程重挂」，在 runNodeSinks 寻址层叠 R8 身份即可，本设计无需预留。共享 `workflow-clients.ts`/`execution.ts` 改动点不重叠（§7-6/8）。
- **R9d（上限语义两档）**：R5 裁决耗尽属「节点失败」档（红态，行级 error 定位）——与 R9d 对照表归类一致，无新档位。
- **spans CHECK 迁移（全体纪律）**：R5 零写方依赖（详 §5-7）；`1720000106200`（design-sharp 持有，词表 `+'rejected','cached','stopped'`）须先于 recover/artifacts/sharp 任一写方合入——R5 排期与之无序约束。
- **R10（试运行 mock）**：fake llmClient 不带 sessionId → platformAgent 修复轮自动走回放路径，与 R10 零耦合（能力披露协议的好处）。
- **NFR-5（UI 动刀窗口）**：本设计的 `canvas-results-panel.tsx` 改动仅两行级（白名单+icon），刻意不做面板级变更，不与 R2/R3/R6 的合并批次抢文件（若排期撞车，③可让位并入 NFR-5 批次，仅白名单两行随行）。

## 10. 决策台账（一句话版）

1. 零 DB 迁移：声明走 flow_data passthrough、轮次事件走 span output.events、合规对象走 output.json——R5 全部新状态是节点运行内瞬态。
2. 三值裁决状态机落在 platformAgent 节点内部（同 run() 多轮），预算 `VERDICT_MAX_INTERACTIONS = 3` 硬编码导出、无 env；repair/nudge 类型去重（各至多一次）。
3. 裁决判据：截断（maxIterations 耗尽）优先判 no-deliverable；空文本在有 schema 时降级 NUDGE（无 schema 保持现状立即失败）。
4. claude 会话延续 = 复用既有 `--resume` + `ExecOptions.resumeSessionId` + `AgentResult.sessionId`——agent-adapters 与 @dagents/contracts 零改动；gateway 只补 sessionId 回传与透传四小处。
5. 能力披露协议：节点只看 chat 返回带不带 sessionId 决定 resume/回放——后端类型无关，未来适配器升级零节点改动。
6. 「会话重建」活动行由节点层统一发（resume/replay 两态），HTTP mock 可断言（AC-R5-4 回放档仪器）。
7. SchemaIssue 扩可选 expected/got；llm.node 修复回路与预算零改动（回归基线不动）。
8. 新活动 kind `'verdict'`；console 四处白名单 + lineIcon 同步；run-trace-model 未知 kind 降级 log 的既有兜底保证灰度窗口不崩。
9. 修复/NUDGE 轮不传 tools（修复轮目标是交付 JSON，防再截断）；claude 修复轮自动落文本档。
10. AC-R5-2 断言口径修正已获批并回写 PRD（§6.2）：会话 id 守恒 + 无「会话重建」行 + spawn 计数恰 +1——`-p` 一次问答即退，无进程复用窗口。
