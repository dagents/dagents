# 需求摸底 · 运行时域（gateway + 引擎）

> 范围：R1–R10 十项需求种子，落在 gateway（`apps/gateway/src`）与 `@dagents/workflow` 引擎、`@dagents/db`/`@dagents/contracts` 的现状锚点、可复用件与缺口。
> 全部结论来自本次对真实代码的阅读（引用 `path:line`，行号以当前工作区 `feat/zcode-borrow` 为准）；未运行任何业务代码、未改动任何业务代码。
> 环境背景见 `docs/zcode-borrow/env-report.md`（dev gateway :8080 / console :3000 在跑，摸底期间未触碰）。

---

## R1 Journal 确定性重放与 resume

### 现状锚点

- **引擎已支持 resume 种子**：`ExecuteOptions.resume`（`packages/workflow/src/engine/executor.ts:71`）→ `ResumeOptions { seedOutputs, seedRuntime, iterationProgress }`（`executor.ts:98-106`）。种子预填充 outputs 后正常波次调度（`executor.ts:230-235`、`executor.ts:261-266`），已种子节点视为 processed 并释放出边 pending（`executor.ts:537-551`）——「从断点继续」的引擎本质就是预填充 outputs，改造成本天然低（`docs/design-run-checkpoint-resume.md` §3 同结论）。
- **run_checkpoints 表（控制态快照）**：状态机 `running/awaiting_input/resumable/terminal`（`packages/db/src/entities/run-checkpoint.entity.ts:14`），snapshot JSONB = `{outputs, runtime, iterationProgress, failedAt}`（`executor.ts:112-117`）。唯一行 per run、终态单向门 upsert（`apps/gateway/src/repositories/run-checkpoints.repo.ts:21-52`）。
- **快照写入时机**：根图每波次收敛（`executor.ts:770-774`）、迭代每项完成（`executor.ts:1013-1017`）、挂起（`executor.ts:272-287`）、终态前（`executor.ts:309/335`）；宿主 `makeCheckpointHook` 串行链保序落库（`apps/gateway/src/routes/resume-execution.ts:79-128`）。
- **resume 入口已存在**：`POST /api/v1/workflows/runs/:runId/resume`（挂载 `apps/gateway/src/app.ts:238`；路由 `apps/gateway/src/routes/execution-resume.ts:93-158`）——只接受 `checkpoint.status === 'resumable'`（`execution-resume.ts:106-108`），`topo_hash` 护栏拒结构变更（`execution-resume.ts:115-117`，指纹算法 `resume-execution.ts:40-54`），新 runId + `resumed_from_run_id` 谱系（`execution-resume.ts:129,149`；COALESCE 保已存值 `apps/gateway/src/repositories/runs.repo.ts:241`）。
- **answer 回流（同 runId 原地续跑）**：`execution-resume.ts:160-234` + 聊天消息命中挂起 run 自动续跑 `resume-execution.ts:411-474`。
- **认领互斥**（防并发双 resume）：进程内 Set，`resume-execution.ts:23,185-198`。
- **boot sweep**：`runs` running/pending → `failed`（`apps/gateway/src/index.ts:86-89`）；`run_node_spans` running 行 → `failed`（`index.ts:92-99`）；awaiting 超时 → run `failed` + checkpoint `terminal`（`index.ts:106-122`）。
- **chat 触发的工作流不写 checkpoint**：`@flow` 路径（`apps/gateway/src/routes/chat-execute.ts:496-506`）与 chat 流式路径（`apps/gateway/src/routes/chats.ts:733-737`）传给 `executor.execute` 的 options 均无 `onCheckpoint`——chat 起 run 永远不可 resume。

### 可复用件

- `ResumeOptions` 种子机制 + `IterationProgress` 迭代游标（`executor.ts:92-96,819-831`）——R1 journal 的「短路复用」可以直接挂在这套语义上扩展。
- `run_checkpoints` 表与串行链钩子（`makeCheckpointHook`）——journal 若按「扩展该表或新表」落，写入管线现成。
- `buildResumeSeed`（`resume-execution.ts:366-402`，含迭代控制器不种子化的教训注释）。
- `topo_hash` 护栏与 resume 三端点（checkpoint/resume/answer）+ e2e `24-run-resume.spec.ts` 既有覆盖。

### 缺口

1. **无节点实例键 (runId, nodeId, ordinal)**：`run_node_spans` 唯一索引 `(run_id, node_id)`（迁移 `packages/db/src/migrations/1720000093000-unique-run-node-spans.ts`；upsert `ON CONFLICT (run_id, node_id)` `apps/gateway/src/span-writer.ts:78`），迭代体节点跑 N 项 = 同一行末次覆盖。设计文档明言「spans 不能作为恢复数据源」（`docs/design-run-checkpoint-resume.md` §3/§5——迭代产出只剩最后一项，且 output 列是展示策展形态非引擎原始输出）。
2. **无 input_hash**：种子复用前不校验「输入是否与上次一致」。resume 时未受影响节点直接复用种子输出，若剩余节点重跑导致下游输入变化，种子输出与新输入静默错配——引擎执行节点前没有任何「先查 journal」的环节（`runNode` 直接执行，`executor.ts:434-479`）。
3. **快照粒度 = 波次收敛、异步落库**：checkpoint 走 fire-and-forget promise 链（`resume-execution.ts:84-87`），进程崩溃时最后未收敛的波次丢失（at-least-once 重跑，无 per-node-instance 记账）。
4. **gateway 崩溃后实际不可恢复（R1 核心矛盾）**：boot sweep 把 interrupted runs 改标 `failed`（`index.ts:88`）；且崩溃时进程内的 `terminalize('resumable')`（`workflows.ts:546-556`）从未执行，checkpoint 停在 `status='running'` → resume 路由 409 拒绝（`execution-resume.ts:106-108`）。现状只有「进程内优雅失败/取消」才可 resume；R1 要求的 `stopped(interrupted)` 可恢复不成立。
5. **迭代体节点无 per-ordinal 记录**：`IterationProgress.itemOutputs` 只存聚合末值（`executor.ts:93-96`），body 节点第 n 次执行的输入输出无处可查。

### 建议验收要点

- e2e：run 进行中 kill gateway → 重启 boot sweep 后 run 标 `stopped(interrupted)`（非 failed）→ `POST resume` 成功，已完成节点零 CLI/LLM 调用（mock provider 调用记录为证），从断点节点继续。
- input_hash 不一致（改上游配置后 resume/重跑）→ 结构化响亮失败（错误带 nodeId + 期望/实际 hash），绝不静默复用种子。
- iteration 第 n 次执行 = journal 里独立一档（ordinal 维度可查、可逐档回放）。
- 存量兼容：迁移不破坏既有 `run_checkpoints` / `run_node_spans`（老 run 数据仍可读）。

---

## R2 修订重跑暖缓存

### 现状锚点

- **无任何暖缓存机制**：全仓 grep `inputHash|input_hash` 零命中（apps+packages，含 console）。
- **「重跑」= 记忆输入的全量新 run**：结果面板「重跑」按钮（`apps/console/src/components/canvas/canvas-results-panel.tsx:356-365`），输入按 flowId 记忆在 localStorage（`apps/console/src/components/canvas/canvas-kit-page.tsx:169-185`，键 `dagents.canvas.runInput.<flowId>`）——重跑从 Start 全量重烧。
- **血缘列已有**：`runs.resumed_from_run_id`（迁移 `packages/db/src/migrations/1720000096000-create-run-checkpoints.ts:40-42`；读取 `runs.repo.ts:142,169`）——但目前只有 resume 用它，「重跑」不用。
- **span output 列有节点输出但不可作种子**：策展形态 + 迭代末次覆盖（同 R1 缺口 1；`docs/design-run-checkpoint-resume.md` §3 的关键事实）。
- **token 记账**：每 run 终态各写一条 `usage_events`（`apps/gateway/src/usage-events.ts:76-107`；调用点 `workflows.ts:598-605`），`runs.cost` 是本 run 聚合（`workflows.ts:576-588`）——无跨 run 继承概念。

### 可复用件

- 引擎 `ResumeOptions.seedOutputs`——跨 run 导入前驱输出在引擎侧就是「换个来源组种子」，调度器无感。
- `runs.resumed_from_run_id` 谱系列（lineage 继承 token 的数据链）。
- `aggregateExecutedNodesUsage`（`usage-events.ts:135-162`）——lineage 累计可在此扩展。
- mock provider 的调用记录（`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs` 控制面 `/__control/*`）可当「零调用」验收仪器。

### 缺口

1. (nodeId, inputHash) 索引与查询不存在——依赖 R1 journal 先行（input_hash 的定义与计算口径需设计：节点输入合并结果？含模板解析后的？）。
2. 新 run 导入前驱种子的编排层（现 `POST /:id/run` 不读任何历史）。
3. token lineage 继承：usage_events/runs.cost 均无「继承前驱累计值、命中缓存不重复计费」的语义。
4. UI「cached」标注：`NodeSpanStatus` 无 cached 态（`packages/db/src/entities/run-node-span.entity.ts:32-39`），live 帧/事件亦无。

### 建议验收要点

- 修订单节点后重跑：未受影响子图全部 cached 命中（mock provider 调用数 = 受影响节点数），执行时间显著缩短。
- token 总量（usage_events 聚合）= 前驱累计 + 仅新执行节点增量；命中缓存节点 span 带 cached 标记、tokens 标 0 且不重复入账。
- 前驱 run 被删除/清理（retention，`apps/gateway/src/retention.ts`）后暖缓存诚实 miss 而非报错。

---

## R3 结算状态机：cancel ≠ fail

### 现状锚点

- **runs.status CHECK 约束（DB 真相）**：`pending/running/awaiting_input/completed/failed/cancelled/partial_success/budget_exceeded` 八态（`packages/db/src/migrations/1720000103000-widen-runs-status-chk.ts:17`）。TS 类型 `RunStatus` 仍是旧五态（`packages/db/src/entities/run.entity.ts:23`）——类型与 DB 已漂移。
- **cancelled 已是独立终态**：引擎 cancel 后报 `cancelled` 非 `failed`（`executor.ts:289-319`）；`toRunStatus` 映射（`apps/gateway/src/routes/workflow-engine-service.ts:259-267`）；HTTP 200 + `status:'cancelled'`（`workflows.ts:742-750`）；chat 路径 `persistCancelled` 与 done 分流（`apps/gateway/src/routes/internal-runs-helpers.ts:149-186`）。
- **cancel 链路完整**：`POST /api/v1/workflows/runs/:runId/cancel`（`apps/gateway/src/routes/execution-cancel.ts:47-64`）→ `executionRegistry.cancelRun`（5s settle 预算，`apps/gateway/src/execution-registry.ts:138-152`）→ AbortSignal 贯穿引擎/CLI/HTTP；级联取消 run 名下 dispatch 任务（`execution-cancel.ts:80-92`）。
- **cancelled 后可 resume 已成立（数据面）**：非 success 终态（含 cancelled）checkpoint 落 `resumable`（`workflows.ts:546-556`）。
- **无 stopReason**：全仓 grep `stop_reason|stopReason` 零命中。
- **superseded 语义部分存在**：同 chat 新执行 latest-wins abort 旧句柄，reason `'superseded by a new execution in this chat'`（`execution-registry.ts:67-88`）——但落库终态仍是 cancelled，无独立区分；run 级终态通知本身不存在（见 R9），故「superseded 不发通知」暂无承载面。
- **boot sweep 中断=失败**：`index.ts:86-89`（与 R1 缺口 4 同源）。

### 可复用件

- `toRunStatus` 单点映射（三入口共用）——状态机重塑只改一处。
- checkpoint `resumable` 语义与 resume 路由（cancelled→resume 已通）。
- `persistCancelled` 的「取消不是失败」先例（chat 路径已践行 D6 决议）。
- runs status CHECK 迁移先例（`1720000103000`）——加 `stopped` + `stop_reason` 列照抄该模式。

### 缺口

1. 五态重塑：`stopped` 态不存在（CHECK 无该值）；`cancelled` → `stopped(user)` 的迁移 + console 全部标签映射联动。
2. `stop_reason` 列与赋值链（user/model/provider/interrupted/superseded）不存在；boot sweep 无法区分中断来源。
3. superseded：暖缓存取代旧 run（R2/R3 联动）时旧 run 的终态收敛与通知抑制——通知层缺失（R9）。
4. `RunStatus` TS 类型落后于 DB 约束，重塑时需一并对齐（含 console 侧 status 标签）。

### 建议验收要点

- cancel → run `stopped(stop_reason=user)`，运行历史可 resume；`failed` 仍是终态不可 resume。
- kill gateway → boot sweep 落 `stopped(interrupted)` 而非 failed（与 R1 验收同一条 e2e）。
- superseded run 不产生任何用户可见终态通知（需 R9 通知层落地后验）。
- 状态枚举单点化：DB CHECK、TS 类型、console 标签三处同源（现状已有一处漂移作前车之鉴）。

---

## R4 声明式权限闭环

### 现状锚点

- **customFunction 现无命令通道**：用户代码在 worker_threads 执行，`require/process/globalThis/Worker/fetch` 以形参 shadow 成 undefined（`packages/workflow/src/nodes/custom-function/user-code-exec.ts:22-37`）——「隔离不是沙箱」的头注释（`user-code-exec.ts:14-19`）。R4 的「命令白名单」实质是**新增受控命令执行能力**（白名单缺席即拒绝 = fail-closed 起点已经是全封）。
- **HTTP 节点无域名清单**：只有协议白名单 http(s)（`packages/workflow/src/nodes/http/http.node.ts:74-82`）+ SSRF 私网阻断（`http.node.ts:84-86` → `packages/workflow/src/nodes/http/ssrf-guard.ts:77-85`）+ 重定向逐跳复检（`http.node.ts:120-144`）——任意公网域名 fail-open 放行。`http_request` 内置工具同款守卫（`apps/gateway/src/routes/workflow-clients.ts:978-990`）。
- **validateFlowTopology 单源校验器**：shape/拓扑/环检测/start 唯一性/孤儿 warning/platformAgent agentId warning（`packages/workflow/src/utils/validate-topology.ts:172-270`）；错误已带 `node`/`edge` 定位（`TopologyError`，`validate-topology.ts:19-25`）。无任何权限声明规则。
- **生成器已有内容风险扫描**：`scanGeneratedFlowRisks` 对 http 节点 URL 出内网/非 https warning（`apps/gateway/src/routes/flow-generator.ts:600-625`）——「运行前确认面」最接近的现成挂点。
- **运行入口**：`POST /:id/run` 只验 body schema 与 flowData 形状（`workflows.ts:346-399`），无权限确认环节。

### 可复用件

- `TopologyError { node?, edge?, message }` 定位结构 + 画布问题节点标红链路（保存后错误高亮，AGENTS.md 已述）。
- `assertPublicHttpUrl` 单源守卫——域名白名单判定可以做成同款「节点侧 fail-closed 抛错、错误面向 flow 作者」的模式。
- `scanGeneratedFlowRisks` 的 warning 注入模式（确认面数据源）。
- 运行输入面板（`canvas-kit-page.tsx` 运行前置区）是确认 UI 的天然位置。

### 缺口

1. flow JSON 声明字段（customFunction 命令白名单 / http 域名清单）在节点 inputs schema（`custom-function.node.ts:32-48`、`http.node.ts:21-55`）与 `flowDataSchema`（`packages/workflow/src/utils/flow-data.ts`）均不存在。
2. 执行层判定：customFunction 无命令执行 API（需先设计受控 spawn 接口再谈白名单）；http 节点无 per-flow 域名集合校验。
3. `validateFlowTopology` 无白名单语法/一致性校验（如声明的命令格式合法、域名可解析）。
4. 运行前确认面（闭合命令集展示）不存在；运行 body 无「已确认」位。
5. 模板中心与 flow-generator 产物需同步带上声明字段（否则存量 flow 全部 fail-closed 拒绝——迁移策略要裁决：存量放行 or 存量也拒）。

### 建议验收要点

- 未声明白名单的 customFunction 调命令 / http 访问未列域名 → 节点拒绝，错误带 node 定位与「如何声明」指引（fail-closed）。
- `validateFlowTopology` 在保存时即报非法声明（带节点定位），不到运行时才炸。
- 运行前确认面展示全图闭合命令集与域名集；确认后 run 才启动。
- e2e：恶意 flow JSON（未声明外域名/命令）被拦在执行层而非靠生成器自觉。

---

## R5 结构化提交裁决（platformAgent outputSchema 三值裁决）

### 现状锚点

- **LLM 节点已有 outputSchema 全链**：输入声明（`packages/workflow/src/nodes/llm/llm.node.ts:53-61`）→ schema 编入 system 头部（`llm.node.ts:192-200`）→ `extractJsonFromText` + `validateAgainstSchema` 判定（`packages/workflow/src/utils/json-schema-lite.ts:27-33`，路径化错误 `a.b[0].c`）→ **一轮修复重试**：违规清单以 user 消息回喂（`llm.node.ts:280-292`），再失败则诚实抛错（`llm.node.ts:294-302`）。输出带 `json` 字段供 `{{id.json}}` 引用。
- **platformAgent 无 outputSchema**：inputs 仅 agentId/systemPrompt/maxIterations（`packages/workflow/src/nodes/platform-agent/platform-agent.node.ts:39-60`）；工具循环的 `messages` 数组就在节点作用域（`platform-agent.node.ts:131-203`）——三值裁决的挂点现成（循环内可继续 push 修复回喂消息）。
- **轮次耗尽现状**：maxIterations 耗尽只追加尾注文本（`platform-agent.node.ts:205-212`），无 NUDGE 追问；空产出守卫已有（`platform-agent.node.ts:214-218`）。
- **CLI 后端「同一会话」的语义边界**：`createCliLlmClient` 每次 `chat()` 新起 CLI 进程，全部 messages 折叠成单 prompt 下发（`apps/gateway/src/routes/workflow-clients.ts:173-187` `buildCliMessages`）——「同一会话内回喂」在 CLI 后端 = messages 数组回放（逻辑会话），非进程级会话延续（与 R8 联动）。

### 可复用件

- `json-schema-lite`（零依赖子集校验器 + 面向 LLM 的错误消息）直接复用。
- LLM 节点的 repairMessages 回喂模式（`llm.node.ts:236-302`）作为语义对齐基准。
- platformAgent 工具循环的 messages 数组（`platform-agent.node.ts:171-196` 的 assistant/tool 消息追加点）。

### 缺口

1. platformAgent inputs 无 `outputSchema`；循环内无「合格收下 / 违规回喂修复 / 轮尽 NUDGE」三值分支。
2. NUDGE 式追问（轮次结束未交付时追问而非失败）不存在——需定义追问预算与最终失败语义（与 LLM 节点「只修一轮」的克制哲学对齐还是放宽，需 PRD 裁决）。
3. 修复回喂不得整节点重跑：span 记账需区分「修复轮」与「新执行」（当前 `onNodeStart/End` 一节点一档，修复轮发生在节点 run() 内部，events 流可承载过程但无结构化轮次标记）。

### 建议验收要点

- platformAgent 声明 outputSchema 后：合格 → 输出带 `json` 字段；违规 → 同一节点内回喂（mock provider 断言收到含 path/expected/got 的修复消息，且不重跑上游）；轮尽未交付 → NUDGE 追问一次，仍无合规产出 → 诚实失败。
- 与 LLM 节点行为对齐：同一份 schema 在两类节点产出一致的可定位错误格式。

---

## R6 渐进产物与失败抢救

### 现状锚点

- **「节点完成即写」在观测层已成立**：span-writer `onNodeEnd` 终态把节点输出整体落 `run_node_spans.output`（`apps/gateway/src/span-writer.ts:187-221`）——增量、实时、崩溃前已持久（每节点串行链保序 `span-writer.ts:49-55`）。
- **失败 run 的产出交付现状**：`runs.output` 失败时为 NULL（`workflows.ts:581` `result.finalOutput ?? null`，failed 时 finalOutput=null `executor.ts:313-319`）；同步失败响应带 `executedNodes`（`workflows.ts:751-754`）；**异步路径失败时**调用方只能轮询 node-spans 逐节点看产出——无「产出清单」聚合交付。
- **部分产出已有先例文案**：partial_success 时 chat 路径明确带「（部分分支失败，以下为完成分支的产出）」前缀（`chat-execute.ts:528-535`）。
- **结果面板**：摘要视图渲染已执行节点 + 失败即时检测（`canvas-results-panel.tsx`）；运行中渐进可见（watchLoop 700ms 轮询 spans，`docs/ARCHITECTURE.md` §2）——「渐进呈现」的管道在，**聚合呈现区**不在。
- **checkpoint snapshot.outputs** 与种子复用（R1）——「resume 不重复」的数据面。

### 可复用件

- span-writer 增量管线 + node-spans 读路径（`workflows.ts:899-972`）。
- `RunCheckpointSnapshot.outputs`（journal 化 report 的近亲——resume 复用已证明 outputs 快照可靠）。
- results-panel 三视图骨架（摘要/终端/轨迹）——渐进结果区是第四块或摘要视图的扩展。

### 缺口

1. journal 化 report（去重、resume 不重复累加）不存在——依赖 R1 journal 的 per-instance 键；当前 spans 是 (run_id,node_id) 覆盖语义。
2. run 终态（含失败/取消）的「已完成节点产出清单」交付：终态响应体、runs 行、运行历史（`runs.repo.ts:146-181` listRunsHistory 只有 first_error）都没有该聚合。
3. UI 渐进结果聚合区不存在。

### 建议验收要点

- 失败/取消 run 的终态响应与运行历史可见「已完成节点产出清单」（节点名 + 产出摘要 + token）；重跑/resume 后 report 不出现重复条目。
- 长跑 run 中途失败：前 5 分钟已完成节点的产出在面板渐进结果区完整呈现（不因 run 终态失败而丢失）。

---

## R7 事件全序与统一回放

### 现状锚点

- **live 帧无序号、只有 `at` 时间戳**：帧类型（`packages/contracts/src/run-live.ts:57-73`）无 seq；`at` 由 registry `emit()` 单点打点（`apps/gateway/src/run-live-registry.ts:134-139`）。
- **DB 侧独立落库、无共享序**：spans 走 per-node promise 链（`span-writer.ts:49-55`），checkpoint 走全局链（`resume-execution.ts:84-87`）——live 帧流与 DB 写入完全两路，非同事务，无原子序号分配。
- **双节拍节流 + 双侧截断（逐字节一致的敌人）**：span events 1s/5s 双节拍落库（`span-writer.ts:119-120`）+ 保险丝 EVENTS_MAX 800 条/64KB 单条/1MB 总量（`span-writer.ts:125-127`）；live 缓冲 512KB 头部截断 + truncated 标记（`run-live-registry.ts:79,102-132`）。restart 后 live 条目全丢（进程内 Map，`run-live-registry.ts:56`）。
- **断流回退已是双路投影**：live 404 → console 回退 node-spans 轮询（`apps/gateway/src/routes/execution-live.ts:45-51` 注释；契约 `run-live.ts:32-34`），`buildTraceFromSpans`（`apps/console/src/lib/run-trace-model.ts:125`）与 `createLiveTraceBuilder`（`run-trace-model.ts:269`）产出同一 `RunTraceModel`——**结构一致但非逐字节一致**（节流/截断/重启丢帧三重差异）。
- **journal 序号先例**：`dispatch_task_events` 有 `(task_id, seq)` 唯一索引（`packages/db/src/entities/dispatch-task-event.entity.ts:15-27`；迁移 1720000095000）——run journal 事件表可整套照抄该模式。

### 可复用件

- `run-trace-model.ts` 纯函数投影层（双路收敛的架构已经是对的，R7 只需把「DB 路」的数据源从 spans 换成 journal 事件）。
- run-live registry 的 emit 单点（打序号与打时间戳同位）。
- `dispatch_task_events` 的 seq 唯一索引模式。
- `use-run-live` 同流解析喂双 builder 的装配（AGENTS.md 轨迹视图段）。

### 缺口

1. run journal 事件表（runId + 全序 seq）不存在。
2. SSE 帧与 journal 写入「同事务原子分配 sequence」不存在——当前 live 与 DB 是旁路镜像（`workflow-engine-service.ts:216-248` 组合钩子里一份进 span-writer 一份进 live registry）。
3. 断流/重启后「journal 回放进同一 builder」不存在——现状回退数据源是 spans（策展形态），重启后无法逐字节复现直播视图。

### 建议验收要点

- 同一 run：直播中途重启 gateway → 客户端断流重连 → 从 journal 回放，轨迹/终端视图与重启前逐字节一致（同 seq、同事件数）。
- live 帧序号与 journal 行序号同源连续，无空洞、无重复（可用 e2e 断言 seq 连续性）。
- 截断标记（truncated）语义保留：journal 侧保险丝触发时回放端能如实降级。

---

## R8 确定性会话身份与模型 pin

### 现状锚点

- **CLI 会话身份非确定性**：每次 `chat/chatStream` 调用 `backend.execute()` 新起会话（`apps/gateway/src/routes/workflow-clients.ts:286-315` `startSession`）；PlatformAgent 工具循环**每轮**新建会话（`platform-agent.node.ts:144-157` 循环内调 llmClient.chat）。
- **run×node→会话映射只为插话**：进程内汇点表 `runNodeSinks`（`workflow-clients.ts:60-107`），生命周期 = 单次 chat 调用（finally 注销 `workflow-clients.ts:406`）；`ExecutionHandle.sendToNode` 也走它（`workflows.ts:488`）。非持久身份，resume 重挂不同会话。
- **`sessionId` 仅是模板变量**：`ExecuteOptions.sessionId` 进 runtime flow scope 供 `{{...}}` 解析（`executor.ts:206`），不参与会话铸造。
- **persona 无冻结**：`createAgentFetcher` 每次调用实时读 agents 表（`workflow-clients.ts:920-951`）——run 执行中改人格立即影响后续节点（grep `冻结|freeze` 于 persona-compiler/agents 路由/repo 零命中）。
- **model 解析不落库、且会静默换引擎**：`prepareRequest` 里 `override.model || params.model || provider.default_model`（`workflow-clients.ts:874`）——解析结果无 run 级落点；HTTP 瞬时故障/熔断开启时**降级本地 CLI**（`workflow-clients.ts:499-526,537-547`，过程流留一条活动帧但执行引擎从配置的 HTTP 模型变成 claude CLI——这正是 R8「绝不静默换模型」的反面，且降级是 2026-10-04 稳定性专项的**特意设计**，注释里有完整论证）。
- **runs 无 model 列**（`packages/db/src/entities/run.entity.ts` 全列已读，无）；`usage_events.model` 只有 chat 路径填（`internal-runs-helpers.ts:99`）；span tokens jsonb 键是模型名（`workflow-clients.ts:383-403` 聚合自 result.usage 的 per-model 结构）——模型信息散落、非 run 级快照。

### 可复用件

- `runNodeSinks` 的 (runId, nodeId) 键结构——确定性铸造只需把它从「临时反查表」升格为「身份派生源」。
- `createLlmClient` 的 `{ providerId, model }` override（`workflow-clients.ts:663-665,845-876`）——模型解析点集中，pin 检查可单点插入。
- run_checkpoints snapshot——persona/model 的 run 级冻结快照可挂进 journal/run 行。
- `DAGENTS_DISABLE_LLM_FALLBACK` 总闸（`workflow-clients.ts:497`，e2e 用）——「pin 不命中响亮失败」可复用该开关的语义并产品化。

### 缺口

1. (runId, nodeId[, ordinal]) → 会话 id 的确定性铸造 + resume 重挂同会话（CLI 侧需适配器支持 resume 会话，如 claude `--resume`；当前 `backend.execute` 每次全新会话）。
2. persona/model 创建期冻结：无快照机制。
3. resolved model 落库 + pin 不命中响亮失败——与熔断降级的产品语义**直接冲突**（降级保可用 vs pin 保确定性），需产品裁决边界（建议：声明 pin 的 run 禁降级，未声明的维持降级）。

### 建议验收要点

- 同 (runId, nodeId[, ordinal]) resume 后会话 id 不变（CLI 会话可续）；跨 run 不串。
- run 内修改 agent 人格/模型 → 本 run 不受影响（后续节点仍用创建期冻结值）。
- runs 行可查 resolved model；模型 pin 后 provider 故障 → 节点响亮失败，过程流明示「因 pin 拒绝降级」。

---

## R9 工程决策包（以 PRD 细化为准，本域供锚点）

### 现状锚点

- **挂起 registry 双轨制**：
  - chat 流式路径 = 纯内存 `pendingByChat` Map（`apps/gateway/src/routes/human-input.ts:44-46`；头注释 `human-input.ts:1-18` 已论证 in-memory 取舍：单进程网关 + 重启即死 + 超时失败）；重启后 `markOrphanedHumanInputs` 给受影响会话补中断说明（`human-input.ts:60-80`、`index.ts:142-146`）——「历史不说谎」的补偿机制已在。
  - 画布/@flow 持久路径 = checkpoint `awaiting_input` + deadline（`resume-execution.ts:102-113`；超时 boot sweep 收敛 `index.ts:104-122`）。
  - 单进程红线论证素材：`execution-registry.ts:10-16`（「DB 是状态真相源，registry 只是控制通道」）——R9 要求的「持久表只会说谎」注释固化，素材已在两处，缺的是合并成一段权威注释。
- **run 完成通知现状**：唯一广播出口是 chat 路径的 `chat:done`/`chat:cancelled` WS 事件（`internal-runs-helpers.ts:71-82,174-182`；契约 `packages/contracts/src/ws.ts:62-64`）——**画布 run 无任何推送通知**（纯轮询），因此「通知去重 claim」与「superseded 不发通知」目前没有承载面：通知层本身是 R9/R3 的前置新建项。
- **诊断 withhold 分级**：`TopologyError/TopologyWarning` 两档已带 node/edge 定位（`validate-topology.ts:19-31`）；生成器 repair loop 一轮修复（`flow-generator.ts` 头注释）后失败显式返回 errors（`flow-generator.ts:637-660` `validate` 收口）。「可修复错误不遮画布定位」部分成立——保存/生成两个入口都带定位，缺的是分级语义（哪些错误可修复降级为 warning+指引）。
- **上限失败语义现状词汇表（散落）**：
  | 上限 | 现行为 | 词汇锚点 |
  |---|---|---|
  | run 并发闸 | 拒绝 429（run 不创建） | `apps/gateway/src/lib/run-gate.ts:60-77` |
  | CLI spawn 闸 | FIFO 排队（等待优于失败） | `apps/gateway/src/lib/cli-spawn-gate.ts:1-15,39` |
  | 迭代项上限 100 | 节点错误 → run failed | `executor.ts:806-815` |
  | platformAgent maxIterations | 尾注 + 仍算 success | `platform-agent.node.ts:205-212` |
  | tokenBudget | 独立终态 budget_exceeded | `executor.ts:562-568,699-709` |
  | 子流程深度 3 | throw → 节点失败 | `workflow-engine-service.ts:144-149` |
  | 节点重试 0-3 | 耗尽后波次失败 | `executor.ts:88-90,462-478` |

  「节点拒绝 vs run 失败」两档语义事实上已散落存在（上表第 3/4/6 行即两种档位），缺统一词汇与归类原则。

### 可复用件

- `pendingByChat` 头注释 + `execution-registry.ts` 红线注释 = 「持久表只会说谎」论证的现成素材。
- dispatch 任务的 claim 语义（daemon 认领任务，`index.ts:123-136` 的认领判别 SQL）——「通知去重 claim」可类比其「认领-释放」模式。
- `TopologyError` 定位结构 + 生成器 repair loop。

### 缺口

- 按 R9 需求文本：「以 PRD 摸底后细化范围为准」——本节锚点即细化输入；三件事（注释固化 / 通知 claim / 诊断分级+上限两档）在 gateway 侧均未成文成机制。

### 建议验收要点

- PRD 细化后定；建议至少钉：挂起 registry 注释固化后 code review 可引用单一权威段；上限行为表进入 `docs/workflow-engine.md` 现状与限制一节。

---

## R10 画布试运行（Mock Provider 产品化 + 子图试跑）

### 现状锚点

- **Mock Provider = e2e 专属独立进程**：`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs`（node:http 零依赖；OpenAI 兼容面 `/v1/chat/completions` + 控制面 `/__control/*`：规则匹配 systemContains/userContains/toolResultContains/modelIs、toolLoop、delay、流式调速）。由 Playwright webServer 拉起，默认 :4010（`E2E_MOCK_LLM_PORT`，`server.mjs:12`）。
- **接入方式 = seed 直插库**：`seedMockLlmProvider` 禁用其他 active provider 后插入 `llm_providers` 行（provider_type='openai_compatible'，base_url 指 mock，`apps/console/tests/e2e/helpers/seed.ts:354-378`）——**动全局 active 配置**，非产品化路径。
- **引擎无子图/单节点执行入口**：`runWaves` 的 scope 是引擎私有参数（`executor.ts:506-519`）；`POST /workflows/:id/run` 只跑全图（`workflows.ts:367-755`）；无「选中子图」请求形态。
- **试运行隔离无承载**：runs 表无 source/trial 列（`run.entity.ts` 全列已读）；`RunExecutionInput.source` 字段已声明「触发来源标记（runs 行溯源）」（`resume-execution.ts:168-170`）但 `persistRunRow` 从不使用——**死字段**，可复活。
- **指定 provider 的执行通道已存在**：`createLlmClient({ providerId, model })` override（`workflow-clients.ts:663-665`）——试运行可直连 mock provider 行而不动 active 配置。

### 可复用件

- mock server 的脚本引擎（rules/fallback/toolLoop/delay/流调速）已是完整产品能力，迁移成本低（单文件 node:http）。
- `llm_providers` 表天然多 provider 并存（status active 选择 `workflow-clients.ts:127-152`）+ override 直连——「试运行用 mock、正式用真 provider」无需切换全局配置。
- `RunExecutionInput.source` 死字段 + `listRunsHistory` 的 where 过滤（`runs.repo.ts:146-181`）——trial 隔离的最小改造面。
- `assembleWorkflowEngine` 单源装配——试运行走同一引擎即可复用全部执行语义（含 R4/R5 新能力）。

### 缺口

1. mock provider 的部署形态：gateway 内嵌（Hono 子路由挂 /__mock-llm）vs 独立进程 vs 桌面编排器拉起——需与桌面客户端端口规划（`docs/desktop-architecture.md`）对齐。
2. 子图执行入口：引擎 scope 参数化 + 路由（`POST /:id/trial-run` 之类）+ 子图拓扑校验（选中集的入口边解析——可复用 `planIterationBody` 的闭包思想 `executor.ts:1066-1100`）。
3. 试运行产物隔离：runs 标记 + 历史过滤 + 旁观模式区分。
4. console UI：画布选中子图 → 试运行面板（脚本规则配置或默认脚本）。

### 建议验收要点

- 选中单节点/子图 → 试运行全部 LLM 调用落在 mock provider（真 provider 调用数 0，可用 mock 控制面调用记录断言）；customFunction/prompt 真实执行。
- 试运行不出现在正式运行历史（或显式隔离标注）；不写 usage_events 账单（mock usage 不入账或标记 trial）。
- 不影响当前 active provider 配置（试运行后正式 run 仍走原 provider）。

---

## 跨领域问题（需需求整合者裁决）

1. **R1 journal 与 R7 事件表可能是同一张表**：per-node-instance 决策记录（input_hash/输出复用）与全序事件流（seq）若分表会造成双写与双真相源；若合表需先定 schema 边界。建议合并设计。
2. **R3 状态机重塑是全域联动**：DB CHECK + TS 类型 + console 全部 status 标签/运行历史过滤/FlowRunsPanel/ws-client 需同步；`RunStatus` 类型与 DB 已有一处漂移（5 态 vs 8 态）是重塑时必须一并清的技术债。UI 域摸底需覆盖。
3. **R8 model pin 与 llm-breaker 降级直接冲突**：降级保可用（2026-10-04 稳定性专项特意设计，`workflow-clients.ts:476-485` 注释论证）vs pin 保确定性（R8 需求）。需产品裁决：建议「声明 pin 的 run 禁降级」作为边界，但这是产品决策非技术决策。
4. **R4 存量 flow 的 fail-closed 迁移策略**：白名单缺席即拒绝意味着所有存量 flow（含模板中心 50+ 内置人格相关 flow 与内置 JSON 模板）在新规则下全部被拒——需裁决存量放行期或全量补声明。
5. **R10 mock provider 部署形态与桌面客户端端口规划耦合**：gateway 内嵌最简但改产品边界；独立进程要进桌面编排器（`apps/desktop/src/main/orchestrator/`）的 spawn/健康/端口让位体系。需桌面域意见。
6. **chat 触发的工作流 run 不可 resume（R1 缺口 5）是否纳入范围**：chat 流式/@flow 路径不写 checkpoint 是现状取舍（chat 有自己的挂起回流机制 `answerAwaitingRunForChat`）；R1 若要求全路径可恢复，chat 路径要接 checkpoint 管线——范围裁决。
7. **R6 产出清单与 R2 暖缓存的 UI 都落在 canvas-results-panel / 运行历史**：cached 徽章、渐进结果区、stopped 状态标签三项 UI 变更应合并排期，避免结果面板反复动刀。
8. **验收依赖 e2e 基建**：多项验收以 mock provider 调用记录为仪器（零调用证明/回喂消息断言）；若 R10 顺势把 mock 产品化，e2e 与产品可共用同一实现——建议排期上 R10 的基建部分先行。
