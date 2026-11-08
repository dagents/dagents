# 需求摸底 · 流程语言域（req-flowlang）

> 范围：节点 schema 与校验（`validateFlowTopology`）、flow-generator 生成管线、customFunction / http 节点与 SSRF 防护、platformAgent（CLI）spawn 路径、outputSchema 修复重试、权限与确认相关 UI。
> 所有锚点均在本仓真实代码中核过（`path:line` 为 2026-10-07 工作区状态）。本域不覆盖：DB 迁移细节、run 编排与通知链路、桌面端——涉及处列入文末「跨领域问题」。
> 结论速览：R1/R2/R3/R7/R8 共享同一块地基（节点实例键 + input_hash + 全序事件），现状只有「按 nodeId 的粗粒度续跑种子」；R4/R5/R10 在流程语言面几乎全新；R6 有一半（spans 已存产物）缺另一半（交付面）；R9 多数是「把已有取舍写成决策记录」。

---

## R1 Journal 确定性重放与 resume

**需求要点**：节点实例键 `(runId, nodeId, ordinal)`、记录 `input_hash`、执行前查 journal（completed 短路 / running 重派 / hash 不一致响亮失败）、boot sweep 改标 stopped(interrupted)、提供 resume 入口。

### 现状锚点

- **续跑种子按 nodeId，无 ordinal**：`ResumeOptions.seedOutputs: Record<nodeId, output>`（`packages/workflow/src/engine/executor.ts:99-106`）；预填充在 `executor.ts:228-235`，根图已种节点跳过执行在 `executor.ts:541-551`。迭代体内节点没有实例级键——迭代进度是**控制器级游标** `IterationProgress { completed, itemOutputs }`（`executor.ts:93-96`，维护于 `executor.ts:1013-1014`、并行归并 `executor.ts:957-964`），体节点本身每项重跑或按游标整体跳过。
- **spans 唯一键就是 (run_id, node_id)**：迁移 `packages/db/src/migrations/1720000093000-unique-run-node-spans.ts:24-26` 建唯一索引 `uq_run_node_spans_run_node`；span-writer 单条幂等 upsert `ON CONFLICT (run_id, node_id)`（`apps/gateway/src/span-writer.ts:76-85`）。**推论**：iteration 第 n 项执行体节点时，`opts.onNodeEnd` 经 childCtx 继承照常触发（`executor.ts:598/612`，childCtx spread 自 ctx），同一节点每项的 span 相互覆盖——最后一项的 output 覆盖前项，started_at 保留第一项（`span-writer.ts:72-74` 注释）。这正是 R1 实例键要治的病。
- **无 input_hash，配置漂移静默放行**：唯一的指纹是拓扑级 `computeTopoHash`（`apps/gateway/src/routes/resume-execution.ts:40-54`，只含节点 id + 边三元组）。resume 守卫注释明说「结构变更后续跑拒绝；**配置变更允许**（新配置跑剩余节点）」（`apps/gateway/src/routes/execution-resume.ts:113-117`）——上游 prompt 改了，已完成的下游种子输出仍是旧输入的产物，无任何提示。
- **boot sweep 一律标 failed**：`apps/gateway/src/index.ts:86-89` 把 `runs` 的 `running/pending` 全量改 `failed`；`index.ts:92-99` 把 `run_node_spans` 的 running 行也改 `failed`。`index.ts:39-41` 注释明确「'cancelled' 留给显式用户取消」——没有「可恢复中断」态。
- **resume 入口已存在**：`POST /workflows/runs/:runId/resume`（新 runId + `resumed_from_run_id` 谱系）与 `POST .../answer`（同 runId 原地续）在 `apps/gateway/src/routes/execution-resume.ts:93-158 / 160-234`；checkpoint 快照 `RunCheckpointSnapshot { outputs, runtime, iterationProgress, failedAt }`（`executor.ts:112-117`）经 `makeCheckpointHook` 串行链落 `run_checkpoints`（`resume-execution.ts:79-128`）。直跑路径同样挂钩（`apps/gateway/src/routes/workflows.ts:463`）。

### 可复用件

- `run_checkpoints` 表 + 快照结构 + `buildResumeSeed`（含迭代控制器不种子化的坑位处理，`resume-execution.ts:366-402`）——journal 可视为它的实例级精细化。
- `claimCheckpointRun` / `releaseCheckpointRun` 在途互斥（`resume-execution.ts:185-198`，进程内 Set）。
- `computeTopoHash` 的排序序列化 SHA-1 写法可直接套到 input_hash（对节点 resolved 输入做规范化序列化再哈希）。
- span-writer 的按节点串行写链（`span-writer.ts:49-55`）是 journal 写入的并发安全范式。

### 缺口

1. 无 `(runId, nodeId, ordinal)` 实例键：spans 表结构 + 引擎种子结构 + 迭代游标三处都要动；`run_node_spans` 扩列或新表需迁移兼容存量（存量行 ordinal 可默认 0）。
2. 无 input_hash：引擎执行节点前「先查 journal 短路」的判定依据缺失；「running 按记录重派」语义当前完全没有（崩溃后 running span 直接被 boot sweep 改 failed，重派无从谈起——依赖 R3 的 stopped(interrupted) 先落地）。
3. hash 不一致的结构化失败：错误需要带 expected/got hash + node 定位，现在没有任何可比对物。
4. boot sweep 改标 + `runs_status_chk` 约束放宽（见 R3）。

### 建议验收要点

- 迭代 3 项中第 2 项失败 → resume 只重跑第 2、3 项，且 spans 中每个 (node, ordinal) 各有一行、互不覆盖。
- resume 时上游配置已改（input_hash 不一致）→ run 以结构化错误失败（错误文本含节点 id + expected/got hash），绝不静默用旧输出。
- gateway 重启后原 running run 显示为 stopped(interrupted) 且可 resume，不再伪装 failed。
- 存量 run（无 ordinal / 无 hash）resume 行为不劣于今天（跳过校验、照旧种子化）。

---

## R2 修订重跑暖缓存

**需求要点**：「重跑」/新 run 按 `(nodeId, inputHash)` 导入前驱 run 完成节点输出；cached 命中零 CLI/LLM 调用、UI 标注；token 按 lineage 继承。

### 现状锚点

- **「重跑」= 打开运行面板重新提交，零缓存**：`handleRerun` 只 `openRunPanel()`（`apps/console/src/components/canvas/canvas-kit-page.tsx:665-669`），输入从 localStorage 预填（`dagents.canvas.runInput.<flowId>`，`canvas-kit-page.tsx:169-185`）。`handleRun` 要么全新 `/run?async=1` 要么 resume 旧 checkpoint（`canvas-kit-page.tsx:431-519`）。
- **resume 只认同 run 的 checkpoint**：`ckpt.status !== 'resumable'` 即 409（`execution-resume.ts:104-108`）；跨 run 导入种子不存在。
- **token 记账是每 run 独立终态一笔**：`usage_events` 追加式（AD-3 唯一真相源），`recordUsageEvent({ source: 'workflow_run', runId, usage: aggregateExecutedNodesUsage(result.executedNodes) })`（`apps/gateway/src/routes/resume-execution.ts:339-346`；`apps/gateway/src/usage-events.ts:1-24`）。resume 新 run 的 executedNodes 只含本次真正执行的节点——种子节点 tokens 已记在前驱 run 的账上，天然不重复计费；但「继承累计值」的展示口径没有（runs 行无累计 tokens 列）。
- **谱系列已有**：`runs.resumed_from_run_id`（`apps/gateway/src/repositories/runs.repo.ts:142、232-247`，COALESCE 保已存值）。

### 可复用件

- `buildResumeSeed` 的 seedOutputs 机制（`resume-execution.ts:366-402`）——跨 run 导入只是换数据源（按 (nodeId, inputHash) 查前驱 spans/checkpoint 而非本 run checkpoint）。
- span 徽章渲染管线（`applyRunStates`，保存校验已在用：`canvas-kit-page.tsx:761-767`）——cached 标注可加一档样式。
- `runs.resumed_from_run_id` 谱系 + `usage_events` 幂等追加。
- `/metrics` 已有 run 计数与 CLI 闸水位（`lib/metrics.ts`），可作「零 CLI 调用」的验收观测面。

### 缺口

1. **inputHash 不存在**（同 R1）——`(nodeId, inputHash)` 匹配的前提缺失。
2. `NodeSpanStatus` 无 `cached` 态（`packages/db/src/entities/run-node-span.entity.ts:32-39`：running/done/failed/paused/unknown）。
3. 无跨 run 种子组装器；引擎侧 `ResumeOptions` 可直接复用，但 gateway 侧需要新的「前驱查找 + 受影响子图判定」（改了节点 C 的 prompt → C 及其下游重跑，上游缓存命中）。
4. UI 无 cached 标注词汇（i18n 自然键方案，新文案需 `t('中文')` + `apps/console/src/i18n/en/flows.ts` 补英文词条）。
5. token 继承：runs 行/结果面板的 tokens 徽章读 span tokens 聚合，cached 节点无新 span tokens——需要在结果摘要上做「lineage 继承值 + 本次新增」的双口径。

### 建议验收要点

- 只改节点 C 的 prompt 后重跑：C 的严格上游全部 cached（徽章 + 零新增 usage_events tokens），C 及下游真实执行。
- e2e 断言 `/metrics` 中 CLI spawn 计数为 0（配 Mock Provider 时）。
- 结果面板 token 总数 = 前驱累计 + 本次新增，且 usage_events 不出现种子节点的重复记账。

---

## R3 结算状态机：cancel ≠ fail

**需求要点**：五态（completed/errored/running/pending/stopped，保留 partial_success）+ stopReason（user/model/provider/interrupted/superseded）；cancelled → stopped(user) 可 resume；failed 终态；superseded 不发终态通知。

### 现状锚点

- **类型层五态是另一套**：`RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`（`packages/db/src/entities/run.entity.ts:23`）。
- **DB CHECK 约束真存在（迁移必做）**：`runs_status_chk` 现为 8 值 `('pending','running','awaiting_input','completed','failed','cancelled','partial_success','budget_exceeded')`（`packages/db/src/migrations/1720000103000-widen-runs-status-chk.ts:14-18`）。'stopped' 不在其中；stopReason 无列。
- **引擎→run 状态映射有两份**：直跑路径走单源 `toRunStatus`（`workflows.ts:560` 调用，定义在 `apps/gateway/src/routes/workflow-engine-service.ts:259-267`）；resume/answer 路径自带一份手写三元链（`resume-execution.ts:319-328`），另 `recordRunFinished` 有一处小映射（`workflows.ts:526-532`）。**新状态要同步三处，收敛 `resume-execution.ts` 那份进 `toRunStatus` 是第一改造点。**
- **cancelled 语义现状**：引擎 `status: cancelled` 仅在 `signal.aborted` 时产生（`executor.ts:293-319、343-355`）；取消端点 `POST /runs/:runId/cancel` → registry abort（`apps/gateway/src/routes/execution-cancel.ts:47-64`）；boot sweep 注释明确 cancelled 专属用户取消（`index.ts:39-41`）。
- **无 stopReason、无 superseded、无 run 终态通知**：grep 全仓无 stop_reason 列；run 完成通知在 gateway 侧不存在（WS 只有 `chat:cancelled`，`apps/gateway/src/ws-hub.ts:34`；console 侧仅本地提示音 `apps/console/src/lib/notification-sound.ts`）。

### 可复用件

- `partial_success` / `budget_exceeded` 的「新终态落地」完整先例：引擎枚举（`executor.ts:301-307、325-333`）→ `toRunStatus` → CHECK 放宽迁移 → console 按标签渲染。照此路径加 stopped/stopReason。
- dispatch 域已有失败原因落列先例：`dispatch_tasks.failure_reason`（`index.ts:126-128` boot sweep 写入）。
- `recordRunFinished(status)`（run-gate 终态计数，`workflows.ts:526-532`）——新状态要并入指标标签集。

### 缺口

1. `stopped` 状态 + `stop_reason` 列 + CHECK 迁移 + 状态映射收敛（`resume-execution.ts:319-328` 的手写三元链并入 `toRunStatus` 单源）。
2. 「cancelled 落为 stopped(user)」是**破坏性改名**：e2e 断言、console 轮询终止条件（`canvas-kit-page.tsx:702` 判 `runStatus === 'cancelled'`）、旁观启发式全部引用旧词——需要一次性全链路改名或双读兼容期。
3. superseded 语义依赖 R2（暖缓存取代前驱 run）才有触发场景；「不发终态通知」的前提是通知机制存在（现在没有，见 R9）。
4. boot sweep 分流：gateway 重启中断（interrupted）与真失败分开——但 `catch` 分支的执行异常仍是 failed（`resume-execution.ts:347-350`），只有 sweep 场景改标。

### 建议验收要点

- 用户取消 → runs 行 (stopped, user) 且可 resume；真异常 → (failed/errored, model|provider) 不可 resume。
- gateway 重启 → 在途 run (stopped, interrupted)，resume 入口可用。
- 同一 run 的终态在 runs 行 / node-spans 端点 / live runEnd 帧三处一致（`toRunStatus` 单源化后用单测钉住；现状直跑与 resume 路径各有一份映射，是漂移温床）。
- `partial_success` 语义保持不变（已有 executor-semantics 测试，`packages/workflow/src/__tests__/executor-semantics.test.ts`）。

---

## R4 声明式权限闭环

**需求要点**：flow JSON 为 customFunction 声明命令白名单、为 http 节点声明域名清单；`validateFlowTopology` 一并校验；运行前确认面展示闭合命令集；执行层 fail-closed。

### 现状锚点

- **校验器是纯结构校验**：`validateFlowTopology` 只查 shape / start 唯一性 / 边端点 / 已知类型 / 孤儿 / agentId 缺席警告 / 环（`packages/workflow/src/utils/validate-topology.ts:172-270`）。错误结构带 `node?/edge?` 定位（`validate-topology.ts:19-25`）——R4 新校验项可直接复用该定位结构。
- **内容层风险扫描已存在但是警告级**：`scanGeneratedFlowRisks` 对生成产物扫 customFunction 代码（提示「隔离非沙箱请审阅」+ 16KB 上限）与 http URL（非 https / 内网地址警告）（`apps/gateway/src/routes/flow-generator.ts:584-622`）。这是「内容进校验器」的现存形态，但只挂在生成管线，不挂保存/运行。
- **customFunction 现状是 JS 函数不是命令**：worker_threads 执行，危险全局形参 shadow（require/process/globalThis/Worker/fetch → undefined，`packages/workflow/src/nodes/custom-function/user-code-exec.ts:22-37`），头注释如实声明「隔离不是沙箱」（`user-code-exec.ts:14-18`）。**它当前根本没有「执行命令」的合法通道**——R4 说「命令白名单」在现有节点语义上无直接对应物（见跨领域问题 §1）。
- **http 节点防线是黑名单式 SSRF**：协议白名单 http(s)（`packages/workflow/src/nodes/http/http.node.ts:74-82`）+ 私网/环回/链路本地阻断（`ssrf-guard.ts:77-85`，含云元数据段）+ 手动跟重定向逐跳复检（`http.node.ts:120-144`）+ 逃生门 `DAGENTS_HTTP_ALLOW_PRIVATE=1`（`ssrf-guard.ts:68-71`）。**没有域名白名单**：任何公网域名都放行。
- **确认面现状**：运行输入面板只有 输入 + 项目目录 + HumanInput 预供答案（`canvas-kit-page.tsx:431-519`；runBodySchema `workflows.ts:346-354` 亦无权限字段）。CLI 侧默认 `bypassPermissions`（AGENTS.md 权限模型表）。
- **gateway 保存/运行不跑拓扑校验**：`POST /:id/run` 只查 nodes/edges 是数组（`workflows.ts:396-399`）；拓扑校验发生在 console 保存时（`canvas-kit-page.tsx:749`）与生成管线（`flow-generator.ts:638`）。fail-closed 若只写进校验器而不进运行前置，改一道 JSON 就绕过。

### 可复用件

- `TopologyError {node, message}` 定位 + 画布红标管线（`canvas-kit-page.tsx:758-767` 复用 failed 样式）。
- `scanGeneratedFlowRisks` 的内容扫描骨架可升级为校验器内的 error 级规则。
- `assertPublicHttpUrl` 的调用位（http.node.ts:86、内置 http_request 工具 `workflow-clients.ts:987`）——域名清单校验可做成同款守卫函数插在协议校验之后。
- `refusal-detect.ts`（console 侧权限拒绝黄警）是「权限语义可感知」的既有 UI 词汇。

### 缺口

1. flow JSON 无 `allowedCommands` / `allowedDomains` 字段：节点 inputs schema（`http.node.ts:21-55`、`custom-function.node.ts:32-48`）与 `flowDataSchema` 的 passthrough data（`packages/workflow/src/utils/flow-data.ts:12-22`）都要扩。
2. 执行层 fail-closed 双落点：http 节点（域名 ∉ 清单即拒）与 platformAgent CLI 路径（bypassPermissions 之下白名单如何落地——claude `--allowedTools` 之类适配器旗标，`workflow-clients.ts:277-280` 的 `--disallowedTools` 是现成的反向先例）。
3. 运行前确认面：新的 UI 面 + i18n 词条（`t('中文')` + `en/flows.ts`）。
4. **存量兼容**：fail-closed 对无声明的历史 flow 意味着全拒——需要明确的存量策略（见跨领域问题 §2）。
5. 生成管线 prompt（`flow-generator.ts:100-114` Rules 段）要教 LLM 产出声明字段，`normalizeToCanonicalFlow`（`flow-generator.ts:217-282`）要保真透传。

### 建议验收要点

- http 节点声明 `allowedDomains: ['api.github.com']` 后，请求 `api.gitlab.com` → 节点失败且错误带节点定位；无声明 → 校验器 error（带 node id），保存可过、运行被拒。
- 域名清单校验对重定向每一跳同样生效（复用 `http.node.ts:125-144` 的逐跳结构）。
- 确认面列出的命令集与执行层实际放行集**逐字一致**（同一常量源生成，防止 UI 说的和守卫放的两张皮）。
- 白名单缺席即拒绝这条规则有单测钉住（fail-closed 的反例：逃生门语义必须显式、不静默）。

---

## R5 结构化提交裁决

**需求要点**：platformAgent 节点支持 outputSchema；CLI 结果同会话三值裁决（合格 / path·expected·got 回喂修复不重跑 / 轮次尽 NUDGE）；与 LLM 节点 outputSchema 语义对齐。

### 现状锚点

- **LLM 节点的修复重试是完整参照系**：声明 `outputSchema` 后 schema 编进 system 首条（`packages/workflow/src/nodes/llm/llm.node.ts:192-199`）、禁流式（`llm.node.ts:207`）、`extractJsonFromText` + `validateAgainstSchema` 校验（`llm.node.ts:255-258`）、失败带 `SchemaIssue{path,message}` 清单回喂做**一轮**修复（`llm.node.ts:280-292`，`MAX 2 attempts`），再失败响亮抛错（`llm.node.ts:294-302`）。校验器是手写子集 `json-schema-lite`（`packages/workflow/src/utils/json-schema-lite.ts:23-88`），错误即 path 表达（`$.a.b[0]`）。
- **platformAgent 没有 outputSchema**：inputs 只有 agentId / systemPrompt / maxIterations（`packages/workflow/src/nodes/platform-agent/platform-agent.node.ts:39-60`）；输出恒 `{ text, content }`（`platform-agent.node.ts:233`）。
- **CLI 路径「同会话」不存在**：每次 `chat()` 都 `startSession` 新起 CLI 子进程，整段对话压成一个 prompt（`apps/gateway/src/routes/workflow-clients.ts:286-315`、`buildCliMessages` `workflow-clients.ts:173-187`）；注释明说 CLI 路径「tool_calls are never returned——工具循环退化为单调用」（`workflow-clients.ts:209-216`）。**回喂修复 = 再 spawn 一次全新进程重述全部上下文**，成本与「不整节点重跑」的诉求直接冲突。
- **会话保活的种子已埋**：`runNodeSinks`（runId:nodeId → 活 CLI 会话的 send 通道，`workflow-clients.ts:60-107`）与插话 `sendToRunNode`（`workflow-clients.ts:90-97`）证明会话可跨 chat 调用存活并被外部写入——但它只登记 `session.send`，没有「等回执」的 await 语义。

### 可复用件

- `json-schema-lite` 全套（校验 + path 错误 + 容错 JSON 提取）——三值裁决的「违规以 path/expected/got 回喂」直接用 `SchemaIssue`，需扩 expected/got 字段（现在只有 path+message）。
- llm.node 的 repairMessages 构造模式（assistant 原文 + user 修正指令）。
- `runNodeSinks` 注册表 + `AgentSession.send`（插话已验证 stdin 可写、turn 边界事件可观测：`workflow-clients.ts:332-340` TurnBoundary 处理）。
- mock provider 的 `toolResultContains` / `hasToolResult` 匹配谓词（`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs:36-73`）可复用来写裁决轮次的 e2e 断言。

### 缺口

1. platformAgent inputs 加 `outputSchema`；节点内在 tool 循环收敛后做同款校验（结构上可整段抄 llm.node 的非流式分支）。
2. **CLI 同会话回喂通道**：需要「chat 调用返回后会话仍存活 + 可再发一条消息 + 可等待新一轮结果」的会话生命周期管理——当前 `createCliLlmClient` 的 API 形状（一次性 chat/chatStream）不支持，`runNodeSinks` 需扩为双向。这也是 R8「确定性会话身份」的同一块地基。
3. NUDGE 式追问（轮次结束未交付）：maxIterations 耗尽现在只追加尾注（`platform-agent.node.ts:208-212`），不追问。
4. 裁决轮次可观测：span 的 events 里要能看出「第 N 轮裁决 / 回喂了什么 / 结果如何」。

### 建议验收要点

- platformAgent + outputSchema：mock 返回不合规 JSON → 同一 CLI 会话内出现第二条 user 消息（turn boundary 可见于 events），不重 spawn（进程数守恒可用 mock + `/metrics` CLI 计数断言）。
- 修复成功 → 输出带 `json` 字段（对齐 `{{id.json}}` 模板语义，AGENTS.md 节点体系段）；修复轮上限耗尽 → 节点失败，错误含 path/expected/got。
- NUDGE 一轮后仍无合格交付 → 失败语义清晰（不伪装成功）。

---

## R6 渐进产物与失败抢救

**需求要点**：节点完成即写 journal 化 report（去重、resume 不重复）；run 终态（含失败/取消）交付已完成节点产出清单；canvas-results-panel 增渐进结果区。

### 现状锚点

- **每节点产物已经在落**：span-writer `onNodeEnd` 把 output（含 activity/events 双通道）终态写入 `run_node_spans.output`（`apps/gateway/src/span-writer.ts:187-221`）；checkpoint 快照也带全量 outputs（`executor.ts:112-117`）。
- **失败 run 的 runs.output 是 null**：引擎失败路径 `finalOutput: null`（`executor.ts:314-319、344-354`），`persistWorkflowRunRow` 照实入库（`runs.repo.ts:213-260`）。已完成节点的产出只活在 spans / checkpoint，没有「清单」形态的交付物。
- **结果面板三视图**（摘要/终端/轨迹）：摘要视图统计 done/failed 数与最终产出（`apps/console/src/components/canvas/canvas-results-panel.tsx:446-470`）；终端视图按节点分区（`run-terminal-format.ts`）；无「渐进产物聚合」区。
- **子流程 spans 并入父 run**（同 runId，`workflow-engine-service.ts:139-177`）——产物清单需处理子流程节点的归属展示。
- **去重锚点**：span 唯一键 (run_id, node_id) + 幂等 upsert（`span-writer.ts:76-85`）已是「同节点不重复写行」的机制；resume 同 runId（answer 路径）天然续写不重开。

### 可复用件

- `run_node_spans.output` 就是产物存储；`GET /runs/:runId/node-spans` 已是读取端点。
- `run-trace-model.ts` 纯投影层（`buildTraceFromSpans` `apps/console/src/lib/run-trace-model.ts:125`）——渐进结果区可以做成第四投影，而不是新拉数据链。
- R1 的 (run,node,ordinal) journal 落地后，「journal 化 report」直接以同一张表为源。

### 缺口

1. 失败/取消终态的「产出清单」装配：需要 gateway 端点（或复用 node-spans 响应加 `deliverables` 投影）+ runs.output 之外的第二交付物概念。
2. resume / 暖缓存场景的 report 去重依赖 R1 实例键。
3. 结果面板渐进结果区：新 UI + i18n 词条；注意孤儿 CSS 护栏（组件 css 随组件走并被 import，`scripts/check-orphan-css.mjs` 挂 lint）。
4. HumanInput awaiting 中断的 run：清单要标注「未完成节点」而非混入失败。

### 建议验收要点

- 5 节点流程第 4 节点失败 → 终态响应/面板能列出前 3 个节点的产出（含截断预览 + 全文入口），runs.output 语义不变（仍为 null）。
- resume 后清单中已种子节点只出现一次。
- 产物行点击跳终端视图对应区段（复用 spanToTerminalSection 的锚点机制）。

---

## R7 事件全序与统一回放

**需求要点**：run-live SSE 帧与 DB journal 事件统一 sequence（写入同事务原子分配）；断流回退改 journal 回放进同一 builder；重启后视图逐字节一致。

### 现状锚点

- **live 帧无序号，只有 `at` 时间戳**：`RunLiveFrame` 五型（nodeStart/nodeEnd/delta/runEnd/truncated），`at` 由 registry `emit()` 单点打点（`packages/contracts/src/run-live.ts:47-73`；`apps/gateway/src/run-live-registry.ts` 注释「registry emit() 单点打点」）。grep 全仓无 sequence/seq 字段（run-live 链路）。
- **DB 侧事件是每节点 events 数组，非全局序**：span-writer 把 activity/events 攒在节点 buffer 节流落库（text/activity 1s、events 5s，`span-writer.ts:119-120`），事件带 `at`（`span-writer.ts:239`）但有**保险丝**：单条 64KB / 总量 1MB / 800 条环形丢弃（`span-writer.ts:125-127、236-254`）——「保真数据源」并不保全，且跨节点无全序。
- **断流回退是降级不是回放**：404（gateway 重启/条目被清）→ 客户端回落 node-spans 轮询渲染（`run-live.ts:32-34` availability ladder；AGENTS.md「断流诚实回退」）。两路数据经 `run-trace-model` 双 builder 收敛为同一 `RunTraceModel`（`createLiveTraceBuilder` `run-trace-model.ts:269` / `buildTraceFromSpans` `run-trace-model.ts:125`）——**投影层已统一，数据源未统一**：spans 里的 events 是节流+保险丝后的子集，重启后重建的视图天然少于 live 期所见，做不到「逐字节一致」。
- **同事务原子分配序号的仓内先例**：`dispatch_task_events` 的 `MAX(seq)+1` 折进 INSERT 同一语句 CTE（`apps/gateway/src/routes/dispatch/tasks.ts:218-232`）+ 唯一索引 `uq_dispatch_task_events_task_seq`（`packages/db/src/migrations/1720000095000-unique-dispatch-task-events-seq.ts:27-29`）——单写者场景下已验证的范式。

### 可复用件

- `dispatch_task_events` 的 (task_id, seq) 模型 + 唯一索引迁移写法。
- `run-trace-model` 双投影架构（frames 与 spans 已产出同构模型）——journal 回放只需新增第三条数据源进同一 builder。
- `RunLiveFrame` 契约文件（双端单源，`run-live.ts` 头注释明说防漂移）——加 `seq` 字段是契约演进而非重写。

### 缺口

1. journal 事件表（或 spans 事件列拆表）+ 全局 seq 分配（写入同事务）；live registry 的 emit 与 journal 写入需在同一序号源上取号。
2. 保险丝语义重定义：回放要「逐字节一致」则 events 不能再环形丢弃——保真与 1MB 上限的取舍要重裁（可改「落库保全 + 展示截断」）。
3. 404 回退路径从「轮询渲染」改为「journal 回放进 createLiveTraceBuilder」；`hello.replay` 前缀与 journal 前缀的对齐规则。
4. 截断标记（truncated）在 journal 回放中的等价物。

### 建议验收要点

- 长跑 run 中重启 gateway → 刷新后轨迹视图事件数/顺序与重启前快照一致（e2e 可比帧序列 hash）。
- 同一 run 的 SSE 帧序号与 journal 行序号一一同位（帧 seq = 行 seq），无空洞无重复（唯一索引兜底报错而非静默乱序，对齐 dispatch 先例）。
- delta 高峰（mock provider 慢速流）下 journal 无丢失（对比 live 期累计帧数）。

---

## R8 确定性会话身份与模型 pin

**需求要点**：run 内 agent 会话 id 由 (runId, nodeId[, ordinal]) 铸造；persona 创建期冻结；resolved model 落库；pin 不命中响亮失败。

### 现状锚点

- **sessionId 是可选透传，画布/续跑路径不传**：`ExecuteOptions.sessionId?`（`executor.ts:37`）只进 runtime `$flow.sessionId`（`executor.ts:203-206`）；直跑（`workflows.ts:498-509`）与 resume（`resume-execution.ts:284-307`）的 execute 调用都没传；chat 路径只在 SSE metadata 里把 runId 当 sessionId 回显（`apps/gateway/src/routes/chats.ts:685`）。
- **CLI 会话与 run 无绑定**：每 chat() 新 spawn（`workflow-clients.ts:286-315`）；`runNodeSinks` 按 (runId, nodeId) 登记活会话但身份是内存 Map（`workflow-clients.ts:67`），重启即空。dispatch 路径有 `AgentDaemonCall.sessionId` + `ExecOptions.resumeSessionId` 的会话延续概念（`packages/db/src/entities/run.entity.ts:48-49`），workflow 内联路径没有。
- **persona 运行期实时读库**：`createAgentFetcher` 每次节点执行现查 agents 表（`workflow-clients.ts:920-951`）；人格库 instantiate/drift 三态同步（`apps/gateway/src/routes/agent-library.ts:44-78`）是启用面，不是 run 冻结面——**run 进行中改人格，下一个节点执行立即吃到新 instructions**。
- **模型 pin 现状是静默兜底**：agentConfig.model 空串直传（`platform-agent.node.ts:78`）；HTTP 路径 `model = override.model || params.model || provider.default_model`（`workflow-clients.ts:874-877`）——请求模型为空就静默用 provider 默认档；CLI 路径 model 参数干脆被忽略（`flow-generator.ts:373` 传 `model: ''`）。resolved model 不落库：span.input.model 记的是请求值（`llm.node.ts:324`）；CLI 侧 `result.usage` 按模型名分桶（`workflow-clients.ts:359-377`）但聚合后真实模型名丢失。
- **agents 表有 model/kind/library_meta**：`createAgentFetcher` SELECT id/name/instructions/model/kind/skills（`workflow-clients.ts:930-935`）。

### 可复用件

- `runNodeSinks` 的 (runId, nodeId) 键位 + `forRunLive` 的 nodeType 查找表模式（`workflow-engine-service.ts:183-188`）。
- R1 的实例键（含 ordinal）就是会话身份的铸造公式——两需求同键。
- checkpoint 快照可携 sessionId map 实现「resume 重挂同一会话」（CLI 会话 id 需适配器层暴露；claude `--resume` 类旗标属适配器域，见跨领域问题 §3）。
- `generator_attempts` 的显式失败先例（`flow-generator.ts:548-560`：不静默兜底、结构化 outcome）可作为 model pin 失败的形态参照。

### 缺口

1. 会话 id 铸造函数 + 注入链（executor opts → node context → llmClient chat params）。
2. persona 冻结：run 创建时快照 instructions/model/skills 进 run 级载荷（或 checkpoint），agentFetcher 增加「冻结版」读取路径；与 agent-library drift 语义划界（冻结的是 run 视角，不回写库）。
3. 模型 pin：`model` 为空时「响亮失败」与现有「零配置 CLI 基线」（AGENTS.md：CLI 第一性，model 空 = CLI 默认档）**语义冲突**——需要区分「显式 pin 过的模型不命中」与「从未配置模型走基线」两种场景（见跨领域问题 §4）。
4. resolved model 落库位：runs 列 or spans 列 or usage_events.model（后者已有 model 字段，`usage-events.ts:37`）。

### 建议验收要点

- 同一 run 内同节点（含迭代体第 n 项）的会话 id 稳定可预测（确定性公式单测）；resume 后一致。
- run 进行中修改人格 instructions → 本 run 后续节点仍用创建期快照（对照 run 可见差异）。
- 显式 pin 的模型不可用 → 节点失败且错误含 expected/got 模型名；未配置模型 → 走 CLI 基线并在 span 记 resolved model（如 `cli:claude-default`）。
- usage_events/spans 能查出每个节点实际使用的模型。

---

## R9 工程决策包（范围以 PRD 摸底后细化为准）

### 9a 挂起/escalation registry 纯内存 + 注释固化论证

- **现状**：chat 路径的 HumanInput 挂起 promise 注册表已是纯内存，且头注释已写明理由（单进程网关本机模式、重启即死由 HUMAN_INPUT_TIMEOUT_MS 收敛，`apps/gateway/src/routes/human-input.ts:1-18`）。但 P2 持久化改造后并存两机制：内存 promise（chat SSE 路径）与 checkpoint awaiting（画布/answer 路径，`resume-execution.ts:137-145` 持久 resolver「不持有任何内存 Promise（重启安全）」）。
- **缺口**：「持久表只会说谎」的完整论证（挂起态的真相在进程里，表只能记意图；重启后承诺无法兑现所以诚实失败优于假承诺）散落在两处注释，需收成一份决策记录 + 两机制并存的边界说明（何时用哪个）。
- **验收**：ADR 文档落档；human-input.ts 与 resume-execution.ts 注释互引；「两机制并存」有明确判据注释。

### 9b run 完成通知去重 claim

- **现状**：**run 完成通知机制本身不存在**——WS 事件面只有 `chat:cancelled`（`ws-hub.ts:34`）；console 完成提示音是纯客户端行为（`notification-sound.ts`）。
- **可复用**：`claimCheckpointRun` 的 claim/release 范式（`resume-execution.ts:185-198`）；`activeResumeCheckpoints` 防双发先例（曾实弹逮出并发双 200，注释在 `resume-execution.ts:19-23`）。
- **缺口**：先有通知载体（WS hub 事件型？notification 表？）才谈得上去重 claim——载体选型是前置决策，本域无现状可锚。
- **验收**：通知载体定型后，claim 语义（首claim 者发、其余静默）有并发单测。

### 9c validateFlowTopology 诊断 withhold 分级

- **现状**：校验器已是两级（errors=不可执行 / warnings=可疑，`validate-topology.ts:12-13`）；保存不阻断（`canvas-kit-page.tsx:746-749`「全部不阻断保存」）+ 错误节点画布红标（`canvas-kit-page.tsx:758-767`）。**「withhold」（可修复错误不遮画布定位）的细分不存在**——现在只有 toast 列表 + 红标，没有「部分结果可用/部分被扣留」的分级语义。
- **缺口**：第三级（如 `repairable`）或错误分级字段的定义；与 R4 白名单校验错误（可修复）和结构错误（不可执行）的归档划分。
- **验收**：白名单缺失类错误在保存时不遮蔽其他结构诊断（一次校验全量返回，现状已是全量收集 `validate-topology.ts:171` 注释「Warnings are collected even when errors are present」——保持并扩展）。

### 9d 上限失败语义两档（节点拒绝 vs run 失败）+ 闸门词汇对齐

- **现状词汇盘点**：迭代超上限 = 节点 failed（`iteration.node.ts:76-81`「拒绝静默截断」）+ executor 同值兜底（`executor.ts:807-816`）；platformAgent maxIterations 耗尽 = **软截断**（尾注说明，不失败，`platform-agent.node.ts:208-212`）；run 并发闸满 = 429 拒绝新 run（`workflows.ts:415-420`、`run-gate.ts`）；CLI spawn 闸 = FIFO 排队（`cli-spawn-gate.ts`）；tokenBudget 超限 = run 级 budget_exceeded 终态（`executor.ts:562-568、699-709`）；customFunction 超时 = 节点失败（`user-code-exec.ts:78-82`）。
- **缺口**：两档语义（「这个节点拒绝执行」vs「整个 run 判失败」）没有统一词汇表；软截断（maxIterations）与硬失败（MAX_ITEMS）的取舍没有成文决策。
- **验收**：上限语义对照表落档（哪个上限→哪档失败→runs 终态→UI 呈现）；新闸门实现时按表对齐。

---

## R10 画布试运行

**需求要点**：选中子图/单节点对 mock LLM provider 试运行；验证 prompt/customFunction/拓扑；产物不污染正式 run 历史。

### 现状锚点

- **无试运行概念**：grep `dryRun|试运行|trialRun` 全仓无业务命中（仅 i18n 词条「▶ 重试运行」）。
- **executor 只能整图从 start 跑**：`execute(flow, input, opts)` 公有入口无 scope 参数；`runWaves` 的 scope/entryEdges 子图机制是私有且只服务迭代体（`executor.ts:506-551`、`planIterationBody` `executor.ts:1066-1100`）——**子 DAG 提取的算法已有**，缺公有化入口。
- **mock provider 蓝本**：e2e Mock LLM Provider（:4010，`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs`）：OpenAI 兼容面 + `/__control/*` 规则编排面（规则谓词 systemContains/hasToolResult/modelIs 等，`server.mjs:36-73`）；零依赖 node:http 独立进程，由 playwright webServer 拉起（`server.mjs:13-18`）。
- **确定性开关已有**：`DAGENTS_DISABLE_LLM_FALLBACK=1` 关降级保失败确定性（`workflow-clients.ts:494-497`）。
- **run 历史污染面**：直跑必写 runs 行（`persistWorkflowRunRow`，无 trial 标记列）；spans 按 runId 隔离（唯一索引含 run_id）。
- **画布无选中→运行动作**：运行入口唯一（openRunPanel，`canvas-kit-page.tsx:598-604`），无子图选择语义。

### 可复用件

- mock-llm-server 的双面设计（OpenAI 兼容 + 控制面）可直接产品化为 gateway 内置 mock provider（注册进 `llm_providers` 或代码级 provider）。
- `planIterationBody` 的传递闭包子图提取 + entryEdges 种子机制——「选中子图」的图算法核心。
- `runBodySchema`（`workflows.ts:346-354`）扩展 trial 标记 / 子图节点集；`x-run-id` UUID 校验链（`workflows.ts:401-408`）。
- `applyRunStates` 徽章 + run-trace-model 投影——试运行结果呈现不需要新数据链。

### 缺口

1. engine 公有「受限作用域执行」入口（scope 节点集 + 伪 start 种子），或 gateway 侧临时图裁剪（把选中子图包成临时 FlowData 跑——更少侵入引擎，二选一需设计裁决）。
2. mock provider 的产品化形态：进程内 fake llmClient 注入（`assembleWorkflowEngine` 已接受 llmClient 装配，`workflow-engine-service.ts:108`）vs llm_providers 行——前者不动 DB、天然不污染账单，倾向前者（见跨领域问题 §5）。
3. customFunction / http 节点在试运行中**真实执行**（需求明说验证 customFunction）——SSRF 守卫照常生效；试运行的 http 应考虑强制 mock 或保持真发（决策点）。
4. 隔离：runs 行加 trial 标记列或独立表；node-spans/live registry 按 runId 天然隔离但要防旁观列表（FlowRunsPanel）混入。
5. 画布交互：子图选择 UI + 试运行入口 + i18n。

### 建议验收要点

- 选中单 LLM 节点试运行：mock 规则命中可在面板看到 scripted 输出；prompt 模板解析错误在试运行即暴露（未解析占位符计数 `llm.node.ts:316-319` 可复用作诊断）。
- customFunction 在试运行真实执行（超时/异常如实呈现）。
- 试运行不产生 runs 正史行 / usage_events 记账 / FlowRunsPanel 条目（三处隔离各有断言）。
- 环（若选中子图含回边）被拒并定位（复用 detectCycle `validate-topology.ts:118-164`）。

---

## 跨领域问题（需需求整合者/其他域回答）

1. **R4「customFunction 命令白名单」的语义指向**：现有 customFunction 是 worker 里的纯 JS（无命令执行通道，危险全局被 shadow，`user-code-exec.ts:27-31`）。「命令白名单」是指 (a) 未来给 customFunction 增加受控 shell/http 能力后的授权面，还是 (b) platformAgent CLI（bypassPermissions）的 Bash 工具授权面？两者的实现层完全不同（前者在节点执行器，后者在 agent-adapters 旗标层）。
2. **R4 fail-closed 的存量策略**：无声明的历史 flow 与全部内置模板/团队模板（flow_templates）是否一律拒跑？需要产品裁决（一次性迁移加声明 vs 灰度期警告）。
3. **R5/R8 的 CLI 会话延续能力边界（适配器域）**：「同会话回喂」依赖适配器暴露会话 id 与 resume 旗标（claude `--resume` 类）。claude 之外的 16 个适配器（15 个 docs-only）是否纳入第一版范围？建议 v1 只对 claude 档承诺、其余 kind 诚实降级为「重跑节点」。
4. **R8 模型 pin 与「CLI 第一性零配置」的冲突裁决**：model 空串静默走 CLI/provider 默认档是现有基线（`workflow-clients.ts:874-877`、`flow-generator.ts:373`）。pin 不命中响亮失败应只约束「显式声明过模型」的节点/Agent——「显式」的判定信号（flow 里写了 model 字段？agent.model 非空？）需要定义。
5. **R10 mock provider 的部署形态**：e2e 式独立进程不可产品化。倾向 gateway 内置 fake llmClient（零部署、零计费污染），但若要走 llm_providers CRUD（用户可见可配），则属 LLM Provider 域改造——需该域确认。
6. **R3 通知载体前置依赖**：「superseded 不发终态通知」与 R9b 通知去重 claim 都先要一个存在的 run 终态通知机制（现在没有）。载体（WS hub 事件 / notification 表 / 推送）属执行编排域决策，本域只能预留 stopReason=superseded 语义位。
7. **R1/R7 的表结构选址（DB 迁移域）**：journal 是扩 `run_node_spans`（加 ordinal/input_hash/seq，破坏唯一索引语义需重建）还是新表（`run_node_journal`），影响 retention 清理策略（`apps/gateway/src/retention.ts`）与 gateway 单测库迁移链，需 DB 域评估。
8. **词汇改名的 e2e 影响面**：cancelled→stopped(user) 改名将波及 console 轮询终止条件（`canvas-kit-page.tsx:702`）、chat 执行卡、e2e 断言与 Mock Provider 脚本——改名 PR 必须带上 e2e 同步（AGENTS.md 已有「e2e 残留清扫」教训条目）。
