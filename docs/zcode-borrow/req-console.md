# 需求摸底 · 界面域（console 前端）

> 范围：flow-canvas / canvas-results-panel / canvas-trace-view / use-run-live / run-trace-model / FlowRunsPanel 重跑 / humanInput 挂起应答 / floating-chat 与 use-chat-execution / i18n。
> 所有结论锚定 2026-10-07 工作区代码（分支 feat/zcode-borrow），引用 `path:line`。R 编号对应十项需求种子。
> 本文只做现状与缺口分析，不含实现；不改业务代码。

---

## R1 Journal 确定性重放与 resume

### 现状锚点

- **resume 前端链路已完整存在**（2026-09-18 断点续跑）：
  - 失败终态拉 checkpoint：`apps/console/src/components/canvas/canvas-kit-page.tsx:591-596`（`runState === 'failed' && activeRunId` 时调 `refreshCheckpointState`）。
  - checkpoint 判定数据源：`canvas-kit-page.tsx:554-589`（`GET /api/workflows/runs/:runId/checkpoint`，解析 `status: 'resumable' | 'awaiting_input'` + `completedNodeCount` + awaiting 载荷）。
  - 「从此处继续」按钮：`apps/console/src/components/canvas/canvas-results-panel.tsx:346-355`（仅 `runState === 'failed' && resumeInfo` 时渲染，title 带「跳过 {n} 个已完成节点」）。
  - 提交走 resume 端点 + 新 runId 接管轮询 + 422「topology changed」自动回退全新跑：`canvas-kit-page.tsx:452-507`（`submit(asResume)` 分支、`x-run-id` 仅直跑携带 `:463`、`effectiveRunId = json.data?.runId ?? clientRunId` `:499`）。
  - BFF 路由已就位：`apps/console/src/app/api/workflows/runs/[runId]/resume/route.ts`、`.../checkpoint/route.ts`、`.../answer/route.ts`（目录列表见 `apps/console/src/app/api/workflows/`）。
- **boot sweep 现状是翻 failed 而非 stopped**（gateway 域，UI 消费其结果）：`apps/gateway/src/index.ts:86-99` —— `UPDATE runs SET status = 'failed' ... WHERE status IN ('running','pending')`，run_node_spans 的 running 行同样翻 failed。
- **DB 状态约束无 stopped**：`packages/db/src/migrations/1720000103000-widen-runs-status-chk.ts:16-18`（八态：pending/running/awaiting_input/completed/failed/cancelled/partial_success/budget_exceeded）。
- **run 轮询终态判定只认三态**：`canvas-kit-page.tsx:388`（`completed || failed || cancelled`）与旁观循环 `:702` 同款。
- **iteration 重跑的同节点多段展示已存在**（R1 的 ordinal 语义在 UI 侧的先例）：`apps/console/src/lib/run-trace-model.ts:12-15`（直播路同 lane 多 segment「它跑了几程」）、`apps/console/src/lib/run-terminal-format.ts:239-241`（终端路合并 section）。
- e2e 断点续跑钉子：`apps/console/tests/e2e/24-run-resume.spec.ts:34`（RM-01 零重跑证明）、`:112`（RM-02 拓扑变更 422）。

### 可复用

- `refreshCheckpointState` / `CanvasResumeInfo`（`canvas-results-panel.tsx:36-39`）的「判定→按钮→提交→接管」四段式管线可直接扩展出 stopped(interrupted) 入口；`x-run-id` 客户端预生成机制（`canvas-kit-page.tsx:446`）已是确定性 run 身份的雏形。
- 结果面板三视图 + `latestSpans` 快照渲染（`canvas-results-panel.tsx:500-721`）对「resume 后既有完成节点 + 新跑节点」同框展示天然兼容（按 nodeId 合并，无需改组件）。

### 缺口

- **`CanvasRunState` 无 stopped 态**：`canvas-results-panel.tsx:34`（`'idle' | 'running' | 'done' | 'failed' | 'awaiting'`）。stopped(interrupted) run 到达时：watchTick/spectateTick 的终态清单（`canvas-kit-page.tsx:388`、`:702`）不命中 → 轮询永不收尾（`hasRunning=false` 但 `runStatus` 非空，稳定启发式分支 `:708` 不触发）。
- **resume 入口只挂在 failed**：`canvas-kit-page.tsx:592`。stopped(interrupted) 可恢复需要新的判定分支（checkpoint 或等价 journal 判据）。
- **input_hash 不一致的结构化响亮失败无呈现面**：现状启动失败走通用 toast（`canvas-kit-page.tsx:491-496`）+ `runError` 横幅（`canvas-results-panel.tsx:420-431`），没有「哪个节点 input_hash 偏移、期望什么/实际什么」的结构化错误 UI。
- 节点实例键 `(runId, nodeId, ordinal)` 若进 span 行（新列或新表），console 的 `RunNodeSpan`（`apps/console/src/lib/node-spans.ts:19-40`，`normalizeRunNodeSpan :76-104`）需扩展字段；唯一索引现状是 `(run_id,node_id)`（`docs/ARCHITECTURE.md` §4），iteration 重跑行如何落库是跨领域决策，直接影响 UI 是「多行」还是「一行多段」。

### 建议验收要点（界面域）

1. stopped(interrupted) 的 run 在画布旁观（`?run=`）与直跑面板均能收尾定格并显示「已中断（可恢复）」，轮询停（现有 usePolling 终态即停语义不被新状态打破）。
2. stopped run 的结果面板出现「从此处继续」等价入口，点击后续跑复用现有提交管线；已完成节点零重跑的 UI 表现 = 节点徽章保持 done、终端视图无新的 nodeStart 段。
3. input_hash 不一致时，失败呈现携带结构化定位（nodeId + 期望 hash / 实际 hash），不是一串裸错误文本。
4. 存量 failed-on-boot 的旧 run 渲染不回归（迁移兼容）。

---

## R2 修订重跑暖缓存

### 现状锚点

- **「重跑」现状 = 重新发起全新 run**：结果面板按钮 `canvas-results-panel.tsx:358-367`（onRerun 只打开输入面板）；终端 stdin 行结束态同款（`canvas-results-panel.tsx:520-553`）；FlowRunsPanel 历史行重跑 `apps/console/src/components/flow-runs-panel.tsx:244-253`（`onRerun(r.input ?? preview)` 回传输入全文，父组件预填 `FlowRunDialog`，见 `apps/console/src/components/flow-run-dialog.tsx:32-33`）。
- **输入记忆**：`dagents.canvas.runInput.<flowId>` localStorage（`canvas-kit-page.tsx:169-177` 读、`:182-191` 写）。
- **run 谱系字段已有并在 UI 消费**：`resumedFromRunId`（`flow-runs-panel.tsx:39-41` 类型、`:226-233`「↩ 续跑」chip + title 溯源）；gateway 侧 `apps/gateway/src/repositories/runs.repo.ts:142,169`。
- **run POST 无任何暖缓存/dryRun 参数**：gateway 路由 grep `warmCache|dryRun|trial` 零命中（命令：`grep -rn "warmCache\|dryRun\|trial" apps/gateway/src/routes/*.ts`，输出为空）。
- **节点徽章体系四态**：`apps/console/src/components/flow-canvas/kit/run-state.tsx:10`（`NodeRunStatus = 'running' | 'done' | 'failed' | 'waiting'`）；状态映射 `canvas-kit-page.tsx:97-104`（`SPAN_STATUS_MAP`）；徽章渲染 `apps/console/src/components/flow-canvas/kit/NodeView.tsx:40-44`。
- **token 用量徽章**：`canvas-results-panel.tsx:172-178`（`tokensBadge`）；终端段 `apps/console/src/lib/run-terminal-format.ts:126-133`；用量账单页 `apps/console/src/lib/usage-summary.ts`（gateway 聚合口径）；FlowRunsPanel 节点画像 tokens 聚合 `flow-runs-panel.tsx:113-139`。

### 可复用

- 「↩ 续跑」chip 是现成的 lineage 展示位，暖缓存命中的 run 可同款标「⚡ 暖缓存自 {id}」。
- `SPAN_STATUS_MAP → NodeRunStatus → NodeView badge` 是一条单向数据流（`canvas-kit-page.tsx:314-321` applySpans），加一种 `cached` 显示态只需三处小改 + CSS。
- token lineage 继承展示可复用 `tokensBadge`/`formatTokensBadge` 的容错形状（`tokens: unknown`，缺字段自然不渲染）。

### 缺口

- span/run 契约无 `cached` 概念：`RunNodeSpan.status` 词汇（`node-spans.ts:24-25` 注释 running/done/failed/paused…）不含 cached；run-live 帧的 `nodeEnd.status` 契约是 `'done' | 'failed'`（`packages/contracts/src/run-live.ts:64`）——cached 命中走什么帧型/什么 status 需要契约先定。
- 「零 CLI/LLM 调用」的 UI 证明缺失：结果面板/终端视图没有「本节点来自缓存（未发起调用）」的行级标注位；`commandOf` 提示行（`run-terminal-format.ts:142-178`）会照常渲染 `$ agent · model-x`，对 cached 节点是误导。
- token 继承口径的 UI 双计风险：若 cached 节点 span.tokens 写继承值且 runs 行累计又含前驱值，`tokensBadge` 与节点画像（`flow-runs-panel.tsx:149,164` totalTokens）会双计——口径需与 gateway 对齐后 UI 才知显示「继承值」还是「0 + 标注」。
- 重跑入口（结果面板/历史行/终端行三处）目前都无「暖缓存重跑」与「全新重跑」的分叉交互。

### 建议验收要点（界面域）

1. 暖缓存 run 的画布节点徽章显示独立 cached 态（区别于 done），hover/结果面板行标注「复用前驱输出」。
2. 终端视图与轨迹视图对 cached 节点不出现假的 CLI 过程行；轨迹泳道可显示零时长段 + cached 标注。
3. 结果面板 token 徽章总额与账单页（usage-summary）一致，命中缓存不重复计费在 UI 可核（行级「继承 ↑x ↓y」标注）。
4. FlowRunsPanel 历史行能看出该 run 是暖缓存跑（lineage chip 扩展）。

---

## R3 结算状态机 cancel ≠ fail

### 现状锚点

- **状态词汇现状八态**（见 R1 迁移引用）：无 `stopped`；**无 `stopReason` 概念**——`grep -rn "interrupted|stopReason|stopped" packages/contracts/src` 仅命中 ws.ts 注释一行（chat cancel 帧说明），runs 无此字段。
- **UI 把 cancelled 折进 failed 态渲染**：`canvas-kit-page.tsx:355-369` `summarizeWatch`（`cancelled → setRunState('failed')` + summary 文案「已取消」）；直跑收尾同款 `:390-397`。
- **历史行状态词表**：`flow-runs-panel.tsx:43-53`（`STATUS_LABEL` 八词 + fallback 原文）。
- **聊天侧执行卡**：`apps/console/src/components/workflow-run-card.tsx:83`（终态判定同样只认 `completed/failed/cancelled`）。
- **span 状态中文映射**：`apps/console/src/lib/flows.ts:103-106`（`SPAN_STATUS_CN`）+ `:115-130`（`mapExecutionState`）。
- **runEnd 帧透传任意 status 字符串**：`packages/contracts/src/run-live.ts:70`（`{ type: 'runEnd'; status: string }`）——直播路对 stopped 天然兼容（use-run-live 只认帧型不校验词表，`apps/console/src/lib/use-run-live.ts:97`）。
- **终态通知现状**：画布直跑 toast（`canvas-kit-page.tsx:390-402`）；聊天侧桌面通知/声音/toast（`apps/console/src/lib/use-task-notification.ts:210-259`，仅 `chat:done`/`chat:error` 触发）。

### 可复用

- `STATUS_LABEL` 是加新词的单点（加 `stopped`/`interrupted` 词条 + `en/` 词典同步即可）；`st-${status}`/`d-${status}` CSS 类按状态名生成（`flow-runs-panel.tsx:216-221`），补 CSS 即得新状态点色。
- runEnd 帧的 status 直通（上面锚点）意味着直播路零改动就能收到 stopped 终态。

### 缺口

- **五态 + stopReason 与现状词汇表不兼容**：`stopped` 不在 DB check 约束（见 R1）也不在任何 console 词表；`cancelled → stopped(user)` 的迁移会把现有 `cancelled` 语义收编——`summarizeWatch`/`watchTick`/`STATUS_LABEL`/`workflow-run-card.tsx:83` 四处消费点需同步，漏一处就是「轮询不停」或「裸字符串上屏」。
- **UI 无「已停止（可恢复）」与「失败（终态）」的视觉分叉**：当前 cancelled 借 failed 的红态渲染（`setRunState('failed')`），R3 要求 cancel 有独立显示语义（非错误色 + resume 引导）。
- **superseded 不发终态通知**：现状没有任何「通知去重/抑制」通道——桌面通知 hook 只按帧型触发（`use-task-notification.ts:213`），若 gateway 对 superseded run 照发 runEnd/chat:done，console 无从分辨；需要帧/行带 stopReason 才能过滤。
- runSummary/按钮文案体系（`canvas-kit-page.tsx:861-870` runLabel 五分支）无 stopped 分支。

### 建议验收要点（界面域）

1. 用户取消的 run：结果面板/历史行/旁观三处显示「已停止」而非失败色，且提供 resume 入口（衔接 R1）。
2. gateway 重启中断的 run 显示「已中断（可恢复）」，与用户主动停止可区分（stopReason 可见于 tooltip 或详情）。
3. 被暖缓存取代（superseded）的旧 run 不产生 toast/桌面通知/声音。
4. 老数据（cancelled/partial_success/budget_exceeded 存量行）词表回退不裸显英文状态名。

---

## R4 声明式权限闭环

### 现状锚点

- **customFunction 节点注册只有 code/parameters**：`packages/workflow/src/nodes/node-registry-canvas.ts:437-462`（无命令白名单字段）；**http 节点只有 method/url/headers/body**：`:220-271`（无域名清单字段）。
- **inspector 表单由 spec.inputs 声明式驱动**：`apps/console/src/components/flow-canvas/inspector/InspectorPanel.tsx:83-92`（`spec.inputs.map → FieldWidget`）+ `apps/console/src/components/flow-canvas/inspector/form-engine.tsx:23-37`（string/number/options/code/json 五类控件派发；json 控件带即时空法校验红框 `:199-236`）。**在 workflow 包注册表加参数 = 配置 UI 自动出现，console 零新组件**。
- **拓扑校验单源 + 节点定位消费已闭环**：`packages/workflow/src/utils/validate-topology.ts:19-35`（`TopologyError/TopologyWarning` 带 `node/edge` 定位字段）；console 保存后 toast 折叠展示 + 问题节点画布标红（复用 failed 徽章样式）：`canvas-kit-page.tsx:749-774`（`formatTopologyIssues :84-94`）。
- **运行前确认面现状 = 运行输入面板**：`canvas-kit-page.tsx:951-1057`（`canvas-run-panel`：目录选择 + HumanInput 预答 + 输入文本 + ⌘⏎），无任何命令集/域名的展示。
- **白名单扫描的同类先例**：`extractHumanInputPrompts` 在运行面板预扫 flow 提取待答清单（`canvas-kit-page.tsx:180`、`apps/console/src/lib/flow-human-inputs.ts`）——「闭合命令集汇总展示」可复制此模式。
- 执行层 fail-closed / SSRF 现状（gateway 域背景）：`docs/ARCHITECTURE.md` §3「spawn 输入面」——HTTP 节点已有私网阻断，但没有「按节点声明的域名清单」这层。

### 可复用

- 表单引擎 + 注册表驱动（上述）使新增 `allowedCommands`/`allowedDomains` 字段的编辑面成本≈0；json 控件的非法 JSON 红框可直接用于白名单数组的即时校验。
- 保存管线的问题节点标红（`applyRunStates`）可直接复用为「白名单缺席的节点标红」预览。

### 缺口

- flow JSON 无白名单字段（zod `flowDataSchema` 与 CANVAS_NODES 均无——见注册表锚点），字段名/形状（字符串数组？对象？glob？）需与 gateway 执行层同一契约先行。
- 运行输入面板无「本次运行将执行的命令/请求域名」确认区；数据源（扫描本地 flow 文档）与服务端裁决结果（万一模板变量解析出动态命令，闭合集如何呈现）需定义。
- 校验错误文案目前是 workflow 包中文硬编码（`validate-topology.ts` 消息直出），console 直接 toast 原文——新增白名单校验消息遵循现状即可，但 en 词典无法翻译动态拼接部分（现状同样问题，不新增负担但需知晓）。
- validateFlowTopology 的白名单校验（结构合法性：JSON 形状、域名格式）与运行前 fail-closed（语义合法性：缺席即拒）在 UI 上是两层提示，需要区分呈现（保存时 vs 运行时）。

### 建议验收要点（界面域）

1. customFunction/http 节点 inspector 出现白名单/域名清单编辑控件（声明式自动渲染，含 JSON 即时校验）。
2. 保存含非法白名单的 flow 时，拓扑校验错误带节点定位、画布标红该节点（与现环检测同体验）。
3. 运行输入面板在提交前展示闭合命令集/域名清单（静态可扫部分）；带模板变量的命令有诚实的「运行时裁决」提示。
4. 执行层拒绝（fail-closed）时节点错误信息能定位到「哪条命令/哪个域名未声明」。

---

## R5 结构化提交裁决

### 现状锚点

- **LLM 节点 outputSchema 全链路已在**（对齐目标）：注册参数 `packages/workflow/src/nodes/node-registry-canvas.ts:169-176`；引擎契约解析 + 一轮修复重试 `packages/workflow/src/nodes/llm/llm.node.ts:86-92`（非法 JSON 直接抛）、`:254`（只修一轮注释）、`:296`（修复后仍失败的错误文案）；声明契约即禁流式 `:191`。
- **platformAgent 节点注册无 outputSchema**：`node-registry-canvas.ts:80-131`（agentId/systemPrompt/maxIterations/isolateFailure/finalOutput 五参数）；引擎侧 `packages/workflow/src/nodes/platform-agent/` grep `outputSchema` 零命中。
- **过程事件的终端/轨迹呈现已通**：活动流 kinds 白名单 `apps/console/src/lib/run-trace-model.ts:88-96`（TRACE_LINE_KINDS）与 `apps/console/src/lib/run-terminal-format.ts:62-70`（LINE_KINDS）同构；未知 kind 降级 log 行不丢内容（`run-terminal-format.ts:307-309`）。
- Inspector 的 json 控件（R4 同款）即 platformAgent outputSchema 的编辑面。

### 可复用

- LLM 节点的「解析→修复重试→失败文案」语义与 UI 表现（inspector json 字段 + 终端错误行）就是 R5 的样板，platformAgent 补一个注册参数即得配置面。
- 三值裁决的过程（回喂违规详情、NUDGE 追问）如果落成 span output.events 的活动行，终端/轨迹/摘要三个视图**零改动**就能显示（kinds 白名单内容之外的降级 log 通道兜底）。

### 缺口

- 裁决轮次的**结构化呈现**：`path/expected/got` 形式的回喂若只是纯文本 detail 行，用户可读但机器不可核；Inspector/摘要视图无「schema 违规对照表」组件。
- 轮次结束未交付的 NUDGE 追问若作为新帧型/kind 出现，`TRACE_LINE_KINDS`/`LINE_KINDS` 两处白名单（上述锚点）需要同步加词，否则降级为 log（可用但无专属图标/语义）。
- platformAgent 的会话式裁决（同一 CLI 会话内回喂，不整节点重跑）在 UI 侧的可见性依赖 live 帧流是否持续发 delta——契约上 nodeEnd 未到前窗口仍开着（`use-run-live.ts` 直播路），天然支持；但「这不是新一轮节点执行」需要视觉区分（同 lane 多段 vs 同段内多轮）。

### 建议验收要点（界面域）

1. platformAgent 节点 inspector 出现 outputSchema 编辑位（与 LLM 节点同控件同校验）。
2. 违规回喂轮次在终端视图可见（区分于节点重跑），轨迹视图不误开新 segment（除非产品定义为新段）。
3. 最终失败时错误信息含 schema 违规定位（path/expected/got），摘要视图行内可读。
4. i18n：裁决相关新文案入 en 词典（见「i18n」节）。

---

## R6 渐进产物与失败抢救

### 现状锚点

- **摘要视图已是逐节点渐进呈现**：spans 轮询驱动，running 行 live 预览（`canvas-results-panel.tsx:600-604`）、自动展开/滚动跟随（`:229-247`）、活动流尾 6 条（`:627-635`）。
- **失败/取消终态的已完成节点产出照常展示**：watchTick 终态收尾再 fetchSpans 定格一次（`canvas-kit-page.tsx:388-389`）；cancelled/failed 都走 `summarizeWatch` → 面板保留 `latestSpans`。
- **产物全文查看器**：`apps/console/src/components/result-viewer.tsx`（ResultViewer 全屏查看，结果面板行内三处复用 `:639-710`）。
- **run 级最终输出**：引擎 `finalOutput` 压过拓扑最深默认（注册表描述 `node-registry-canvas.ts:117-122`）——console 侧无「run 最终产物」聚合区，只有逐节点行。
- journal 化 report / resume 去重为 gateway 域；console 的消费面 = spans（或新 report 端点）。

### 可复用

- `spanToDisplay`（`canvas-results-panel.tsx:119-140`）+ `extractOutputText` 单源（`run-terminal-format.ts:103-123`）已把「正文 vs JSON 壳」分层，聚合产物清单可复用同一提取语义，避免第三套解析。
- 结果面板的视图切换框架（summary/terminal/trace 三 tab，localStorage 记忆 `:255-268`）可扩第四 tab 或在 summary 内加聚合区。

### 缺口

- **无跨节点「产出清单」聚合视图**：R6 要求 run 终态（含失败/取消）交付已完成节点的产出清单——现状用户要逐个展开节点行；缺一个「按拓扑序列出全部已完成节点产物 + 一键复制/下载」的聚合区。
- 渐进 report 的「去重、resume 不重复」若表现为 spans 增量追加，console 现有渲染天然幂等（按 nodeId 合并）；但若 report 是独立端点/独立帧型，use-run-live 与轮询两路都需要新消费分支。
- 失败抢救场景下「哪些节点有产出、哪些没有」的视觉汇总缺失（现状只有 done/failed 点色散布在行头）。

### 建议验收要点（界面域）

1. run 任意终态（completed/failed/stopped）下，结果面板能一屏看到全部已完成节点的产出清单（含正文预览与全文入口）。
2. resume 后渐进 report 不重复呈现同一节点产出（同 nodeId 幂等合并）。
3. 聚合区产物与单节点行内容一致（同一提取单源，不出现两套口径）。

---

## R7 事件全序与统一回放

### 现状锚点

- **双路投影架构已在**（R7 的「复用 run-trace-model 双路投影」正是现状设计）：DB 路 `buildTraceFromSpans`（`run-trace-model.ts:125-253`）、直播路 `createLiveTraceBuilder`（`:269-428`），同一 `RunTraceModel`；`use-run-live.ts:85-99` 单次解析喂双 builder（终端段 + 轨迹模型）。
- **断流回退现状 = spans 快照路**：`use-run-live.ts:109-116`（非 runEnd 断流 → `unavailable`）；结果面板据此切数据源（`canvas-results-panel.tsx:504-510` trace 路、`:524-537` terminal 路：live 优先、否则 spans）。
- **帧无 sequence**：`packages/contracts/src/run-live.ts`（RunLiveFrame 仅 `at` 时间戳，`RunLiveAt :42-46`）；gateway `apps/gateway/src/run-live-registry.ts` grep `seq|sequence` 零命中（文件 329 行）。
- **回放截断语义已在两 builder 对齐**：`run-trace-model.ts:402-417` 与 `run-terminal-format.ts:323-330`（truncated 帧 → 首段提示行/挂起补插）。
- **DB 侧 events 条目带 at**：`run-trace-model.ts:98-122`（`spanEventRecords` 解析 `e.at`，旧数据无 at 降级 sequence 投影并提示，`canvas-trace-view.tsx:140-143`）。

### 可复用

- 「同一 builder 吃回放流」的消费端形态已存在——`hello.replay` 前缀就是回放进 builder 的先例（`use-run-live.ts:86-91`）；journal 回放只需把数据源从「进程内帧缓冲」换成「DB journal 事件」，builder 零改动（若帧形状不变）。
- 直播/回放同一面墙钟的 `at` 单点打点设计（registry `emit()`，AGENTS.md 轨迹段）是全序之外已有的排序锚。

### 缺口

- **帧级 sequence 缺失**：现状两条路排序依据不同（直播路=到达序，DB 路=span started_at + events at 的稳定排序 `run-trace-model.ts:242-250`）——「重启后逐字节一致」要求 journal 事件与直播帧共享同一单调序号，契约（RunLiveFrame 加 seq 字段）与 DB（同事务原子分配）都是前置。
- 回退路径的数据源切换：`buildTraceFromSpans` 从 span 行的 events 重建，若 run-live 缓冲被截断（truncated）而 journal 全量，两路重建结果会不同——现状诚实呈现截断标记（上面锚点），改 journal 回放后截断标记应消失（数据源不再缺头）。
- 无「重建结果一致性」的测试锚：`run-trace-model.test.ts` 存在（`apps/console/src/lib/run-trace-model.test.ts`）但双路等价测试针对的是同源数据；跨源（帧 vs journal）逐字节一致需要新测试。

### 建议验收要点（界面域）

1. 运行结束后刷新页面（live 404 → 回退），轨迹/终端视图与关闭前直播视图内容一致（同事件、同序、同时间列）。
2. gateway 重启后旁观中断过的 run：journal 回放补全被截断的头部（truncated 提示不再出现于有 journal 的 run）。
3. 若引入 seq，直播路与回放路的台账行序在乱序投递下仍稳定（seq 优先于到达序排序）。

---

## R8 确定性会话身份与模型 pin

### 现状锚点

- **resolved model 的 UI 消费点**：终端/轨迹提示行 `commandOf`（`run-terminal-format.ts:142-178`，从 `span.input.model` 取模型名拼 `$ agent · model-x`）——resolved model 落库到 span.input 后此处自动受益，零改动。
- **模型选择 UI**：inspector model 下拉动态源 `apps/console/src/components/flow-canvas/registry/option-providers.ts`（modelOptions：providers + agents），兜底 FALLBACK_MODEL_OPTION（`form-engine.tsx:100-129`）。
- **agentId 下拉 + 广场入口**：`form-engine.tsx:152-165`。
- **插话寻址现状按 (runId, nodeId)**：`canvas-kit-page.tsx:524-550`（sendMessage POST message body `{nodeId, text}`）；gateway `execution-message.ts`（gateway 域）。
- persona 创建期冻结 / 会话 id 铸造为 gateway 域；console 无感知点（除非要在 UI 显示会话 id）。

### 可复用

- `commandOf` 单源已导出双消费（终端段 + 轨迹 lane，`run-terminal-format.ts:141` 注释）——模型名展示改口径只动一处。
- runError 横幅 + toast（R1 同款锚点）可承载「pin 不命中」的响亮失败。

### 缺口

- **pin 失败无结构化呈现**：现状所有启动/执行错误走通用 toast + runError 横幅；「persona 冻结的模型 X 已不存在，拒绝静默换模型」需要专属错误形态（含期望模型 vs 实际可用），最好节点行内可见（涉及该 agent 节点标红 + 明确文案）。
- 若 (runId, nodeId, ordinal) 铸造会话 id 且 iteration 并行（concurrency>1），同 nodeId 多 CLI 会话并存时插话寻址 `{nodeId}` 是否需带 ordinal——console 的 stdin 行按 nodeId 列出活跃节点（`canvas-results-panel.tsx:538-544`），同节点多会话会撞目标；契约变更需同步（跨领域问题）。
- 模型 pin 的可见性：inspector model 下拉当前显示的是「请求的模型」，resolved 结果（provider/CLI 实际模型）只在 run 后的 commandOf 出现——事前确认面（R4 的运行面板）可选展示 resolved 模型。

### 建议验收要点（界面域）

1. resume 重挂的 run，终端提示行显示同一模型名（会话确定性在 UI 侧的间接证据）。
2. pin 不命中时：run 失败 + 节点标红 + 错误信息含「冻结模型 X 不可用」而非泛化失败；绝不出现模型名悄悄变化的提示行。
3. （若引入 ordinal 寻址）插话在 iteration 并行场景送达正确会话，回执 user_input 帧落在正确段。

---

## R9 工程决策包（范围以 PRD 细化为准）

### 现状锚点（console 侧可核事实）

- **挂起应答 UI**：awaiting bar（`canvas-results-panel.tsx:290-328`：prompt + select/text + 提交按钮，回执 true 才清输入）；提交 `canvas-kit-page.tsx:638-663`（POST answer → 同 runId 回 running 续旁观）；awaiting 状态判定来自轮询 `runStatus === 'awaiting_input'`（`:383-386`、旁观 `:697-700`）。
- **挂起态进程内红线的 UI 后果已诚实处理**：gateway 重启后 awaiting run 被 boot sweep 收敛 failed（`apps/gateway/src/index.ts:106-121` 过期收敛；`docs/workflow-engine.md` 已知限制「HumanInput 挂起态在内存」）。
- **通知现状无 claim/dedup**：画布终态 toast 由 watchTick 收尾单次触发（终态即停 usePolling，`canvas-kit-page.tsx:425-429`）；聊天桌面通知 `use-task-notification.ts:210-259` 每连接每终态帧一次；多标签页/多入口（画布旁观 + 聊天执行卡）看同一 run 时通知天然多发。
- **拓扑诊断现状两级**（errors=不可执行 / warnings=可疑）+ 节点定位高亮（`canvas-kit-page.tsx:759-767`）+ toast 折叠（`:84-94`）。「withhold 分级（可修复错误不遮画布定位）」——现状定位信息已在（err.node → applyRunStates），但错误严重度没有第三档（可自动修复/可带病运行）。
- **上限失败现状**：run 并发闸满载 429 文案（`apps/gateway/src/routes/execution-resume.ts:16-23` gateFull）与 CLI spawn 闸；console 侧统一走 handleRun 的启动失败 toast（`canvas-kit-page.tsx:491-496`），无「节点级拒绝（可重试该节点）」vs「run 级失败」的区分呈现。

### 可复用

- awaiting bar 的「受控输入 + 回执清空 + 同 runId 续跑」是挂起交互的成熟样板；「持久表只会说谎」若要注释固化，console 侧对应物是 `refreshCheckpointState` 的容错注释风格（`canvas-kit-page.tsx:586-588`）。
- 通知去重 claim 若做成 gateway 域（终态通知单点），console 侧 `use-task-notification` 的帧过滤只需加 stopReason/superseded 判断（衔接 R3）。
- 诊断分级可扩展现有 `TopologyError`（加 severity 字段），console 的标红/toast 分支按级分叉，不需要新管线。

### 缺口

- 诊断三级的 UI 语义未定义（点色/图标/文案/是否阻断运行）。
- 两档上限失败的 UI 呈现未定义（节点拒绝=行级黄警可重试 vs run 失败=现有红态）。
- 「通知去重 claim」在 console 无对应机制；若 claim 在服务端，console 无缺口；若在客户端，需要 per-runId 的通知已发标记（localStorage/sessionStorage）。

### 建议验收要点（界面域）

1. （若采纳分级）保存时可修复错误仍标红定位但不吓人性文案；不可执行错误与现状一致。
2. （若采纳两档）节点级上限拒绝呈现为该节点可重试的黄警，run 不整体翻红。
3. （若采纳 claim）同一 run 终态在多入口（旁观页 + 聊天卡）只收到一次通知。

---

## R10 画布试运行

### 现状锚点

- **Mock LLM Provider 是 e2e 专用设施，非产品能力**：
  - server 本体：`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs`（零依赖 node:http；OpenAI 兼容面 `/v1/chat/completions` + 控制面 `/__control/script|calls|reset`；端口 `E2E_MOCK_LLM_PORT` 默认 4010）。
  - seed 方式：`apps/console/tests/e2e/helpers/seed.ts:353-376`（DB 直插 `e2e-mock-%` active provider + 暂时禁用其他 active provider，dispose 恢复）；端口常量 `:40-41`。
  - 明确的产品化障碍注释：`seed.ts:344-352`「⚠️ 直接改共享 dev 库的 llm_providers 状态」——测试假设与产品形态不同。
- **Provider CRUD UI 已有**（产品化 mock provider 的承接面）：设置页 LlmProvidersTab（`apps/console/src/components/settings-view.tsx:220` 起，tab id `keys` `:83`；CRUD + test 走 `/api/llm-providers`，`:33-44`）。
- **画布选中只有单选**：`apps/console/src/components/flow-canvas/flow-editor.tsx:108`（`selectedId` 单值）、`:396-397`（onSelection 只保留单选）；`FlowEditorHandle`（`:51-59`）不暴露 selection；多选/子图框选无 API。
- **run 端点无试运行参数**（R2 同一 grep，warmCache|dryRun|trial 零命中）；runs 无 kind/隔离标记，FlowRunsPanel 拉全量 `/api/runs?flowId=` 不过滤（`flow-runs-panel.tsx:94`）。
- **拓扑校验客户端可调**：保存干跑 `canvas-kit-page.tsx:749`（validateFlowTopology import 自 `@dagents/workflow` `:22`）——试运行前置校验零成本。

### 可复用

- mock server 的「规则脚本 + 调用记录」双面设计（`server.mjs` 头注释）直接可搬为产品能力的交互模型（用户配置期望响应、试运行后查看每节点收到的 prompt）。
- provider CRUD + test 通道（`/api/llm-providers` 全套 BFF）可挂「Mock Provider」类型；e2e 的 seed SQL 展示了 openai_compatible + base_url 指向 mock 的接入方式。
- 试运行的执行/旁观复用整个 run 旁观栈（`?run=` + node-spans + run-live），只需隔离历史。

### 缺口

- **子图/单节点选择无出口**：FlowEditor 单选 → inspector；「选中子图试运行」需要多选（React Flow 原生支持多选，但当前 onSelection 只取单选、Handle 无 API）——是本需求 console 侧最大的结构缺口。
- **mock server 不是常驻产品服务**：产品化需要 gateway 内嵌 mock 端点或独立进程管理（桌面形态下端口编排也要考虑，见 AGENTS.md 桌面段）；当前仅 playwright webServer 拉起。
- **试运行产物隔离机制不存在**：runs 无 kind 字段、FlowRunsPanel 无过滤、画布旁观链接不区分——「不污染正式 run 历史」需要数据标记 + UI 过滤双管。
- 试运行的 prompt/customFunction 验证面：现状 customFunction 无试执行入口（校验只查拓扑结构）；prompt 验证只能真跑。

### 建议验收要点（界面域）

1. 画布多选节点（或框选子图）后出现「试运行」入口；无选择时对全图可用。
2. 试运行使用 mock provider，过程与正式 run 同栈呈现（节点徽章/结果面板三视图），节点收到的 prompt 可查（对齐 mockLlmCalls 的证据价值）。
3. 试运行完成后 FlowRunsPanel 与 runs 相关 UI 不出现该产物（或显式分区标注「试运行」不与正式历史混排）。
4. 拓扑非法时试运行入口给出与保存一致的定位报错。

---

## i18n（贯穿约束）

- **现状机制**：自然键方案——中文文案即 key，`t('中文')` 包裹；en 词典分模块（`apps/console/src/i18n/en/`：agents/chat/common/daemons/flows/settings）；缺译回退中文（`apps/console/src/i18n/index.tsx:1-14` 设计说明、`:84-101` useI18n/t 实现）。
- **对本批需求的影响**：R1-R10 的新界面文案（stopped/已中断/cached/暖缓存/白名单确认/试运行……）一律中文 key + `en/flows.ts`（或归属模块）补英文词条；`STATUS_LABEL`（`flow-runs-panel.tsx:43-53`）等词表的新中文词需同步入 en 词典，否则英文界面裸显中文（现状 fallback 行为，非阻断但属词条欠账）。
- 原生 confirm 的双语特例模式见 `canvas-kit-page.tsx:52-56`（`unsavedMessage`）——试运行确认等若用原生弹窗需复制此模式，建议新 UI 一律走 React 组件 + t()。

---

## 跨领域问题（需需求整合者裁决）

1. **状态词汇表冻结时机**：R1 的 `stopped(interrupted)` 与 R3 的五态+stopReason 是同一张词表的两次扩容——DB check 约束（`1720000103000-widen-runs-status-chk.ts`）、contracts（run-live runEnd status / ws 帧）、gateway（boot sweep、cancel 端点）、console（STATUS_LABEL/watchTick/summarizeWatch/workflow-run-card 四消费点）必须同批改。建议契约先行、一次定稿，避免 console 对中间态词表适配两轮。`cancelled` 是否保留（作为 stopped(user) 的别名）需明确。
2. **span 行形状与 iteration ordinal**：R1 的 `(runId, nodeId, ordinal)` 落库形态（run_node_spans 加列 vs 新 journal 表）决定 console 是「一行多段」还是「多行」——现唯一索引 `(run_id,node_id)`、轨迹直播路已是多 segment、DB 路恒单段（`run-trace-model.ts:47-48` 注释）。若 spans 变多行，摘要视图/终端合并/`latestSpans` 全链需按 (nodeId, ordinal) 重键。
3. **cached 的契约表达**：R2 的 cached 命中在 run-live 帧（nodeEnd status 目前仅 'done'|'failed'，`contracts/src/run-live.ts:64`）与 span 行各需什么标记？token 继承值写在哪（span.tokens 还是独立 lineage 字段）？UI 标注与防双计依赖此口径。
4. **R7 sequence 的契约位**：RunLiveFrame 加 `seq`（int，写入同事务分配）后，回退路径「journal 回放进同一 builder」的数据源端点是什么（复用 live 404 后的 journal 拉取？新端点）？帧形状是否保持 RunLiveFrame 以复用双 builder。
5. **R4/R5 的字段命名与 zod schema**：`allowedCommands`/`allowedDomains`/platformAgent `outputSchema` 的字段名、类型（字符串数组 vs JSON）、默认值（缺席=fail-closed 拒绝 vs 警告）需 workflow 包（CANVAS_NODES + flowDataSchema + validateFlowTopology）与 gateway 执行层同步定稿；console 的表单/校验/确认面全部声明式依赖它。
6. **R10 试运行的产品形态**：mock provider 是 gateway 内嵌端点、随桌面编排的子进程、还是用户自配 provider 的预设模板？runs 的隔离标记（kind 列？id 前缀？独立表？）决定 FlowRunsPanel/用量账单/retention 是否要过滤。multi-select 交互是否进 P0（无多选则 R10 退化为「全图试运行」）。
7. **R8 插话寻址与并发 iteration**：会话 id 带 ordinal 后，`POST /runs/:runId/message` 的 body 是否需加 ordinal？console stdin 行的活跃节点清单（按 nodeId）如何呈现同节点多会话。
8. **R3 superseded 通知抑制的实现位置**：gateway 不发终态帧/通知（服务端 claim）还是 console 按 stopReason 过滤——决定 `use-task-notification` 是否要改。
9. **既有 UI 债务是否顺带清**：summarizeWatch 把 cancelled 折进 failed 态（`canvas-kit-page.tsx:359-362`）是 R3 的直接改动点；若 R3 不做，是否单独修「取消≠失败」的显示语义。
