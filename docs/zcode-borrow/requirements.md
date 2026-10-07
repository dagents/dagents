# Dagents 可恢复执行与权限闭环 · 产品需求文档（PRD）

> 文档定位：十项需求种子（R1–R10）经三路现状摸底整合后的需求定稿。上游输入：`docs/zcode-borrow/req-runtime.md`（gateway+引擎域）、`req-console.md`（界面域）、`req-flowlang.md`（流程语言域）、`env-report.md`（环境保障）；架构基线 `docs/ARCHITECTURE.md` 与 `AGENTS.md`。
> 锚点核验说明：本文引用的 `path:line` 锚点，关键承重项已在 2026-10-07 工作区（分支 `feat/zcode-borrow`）逐批抽读核验（boot sweep、状态 CHECK 迁移、RunStatus 类型漂移、run-live 契约、STATUS_LABEL、summarizeWatch/watchTick/旁观终态判定、ResumeOptions、种子跳过、toRunStatus、resume 手写映射、superseded abort、runNodeSinks、工具循环、x-run-id 提交分支、user-code-exec shadow、platformAgent inputs/尾注、llm.node 修复重试、model 解析与降级注释、validate-topology、span-writer upsert、flow-data passthrough、节点注册、mock server、ws-hub 事件面、usage-events、dispatch seq CTE、live registry 截断、retention、human-input 头注释、checkpoint hook/claim、partial_success 前缀、planIterationBody、seed.ts 直插库等 50+ 处，零偏差）。
> 需求条目口径：验收标准（AC）一律可核验、可量化；「单测」= vitest，「e2e」= `apps/console/tests/e2e/`（Mock LLM Provider :4010 为确定性仪器）。
> 修订记录：v1.1（2026-10-07 评审修订）——修复 R3.4「failed 不可 resume」与 AC-R1-2/AC-R1-5 硬冲突（现状 failed 可 resume，e2e RM-01 即此场景）、补 partial_success/budget_exceeded resume 策略、DB CHECK 迁移双词表兼容（防 VALID 扫全表炸库）、boot sweep 补 run_checkpoints 收敛与 chat 无 checkpoint 诚实边界、R2 暖缓存谱系书写裁决、R7 seq 执行模型设计期裁决（正确性模型非吞吐）、AC-R3-6 分步口径、R10 试运行写入口径、stop_reason 去死值。锚点勘误：superseded abort 字符串实际位于 `execution-registry.ts:80`。
> 修订记录：v1.2（2026-10-07 二轮评审修订）——NFR-3 与 R7.1/NFR-7 的 seq 口径矛盾修复（SQL CTE → 进程内单写者计数器）；R3.4 budget_exceeded resume 缺省口径修正（v1.1「原样续跑立即再触顶」失实——引擎 `tokensSpent` 启动置 0、种子不结转 `executor.ts:258,631`，缺省=沿用前驱预算值 + 从零起算 + 谱系累计黄警，AC-R3-1 补双路径）；R3.2 superseded 来源收口径为 chat latest-wins 唯一链路（暖缓存前驱必已终态无 abort 语义，注明不产生该值）；R7 结构帧定稿先落库后发帧 + AC-R7-1 补 kill 时机锚定（节点边界静默期）与任意时机鲁棒口径（回放 ⊇ 已收前缀、至多一条边界帧）；R3.6/AC-R3-4 显式要求 workflow-run-card 终态清单扩为词表全集（顺带修 partial_success/budget_exceeded 轮询泄漏现状 bug，`workflow-run-card.tsx:83/87`）。
> 修订记录：v1.3（2026-10-07 架构师评审修订）——AC-R5-2 断言口径修正并回写：claude `-p` 一次问答即退、裁决须待最终文本，「不重 spawn/计数不增」物理不可实现；落为「会话 id 守恒 + 无『会话重建』活动行 + spawn 计数恰 +1」（design-verdict §6.2 论证，评审获批）。

---

## 需求总览与方向分工

| 需求 | 一句话 | 负责方向 |
|---|---|---|
| R1 | Journal 确定性重放与 resume（节点实例键 + input_hash + stopped(interrupted) 可恢复） | 可恢复性 |
| R2 | 修订重跑暖缓存（(nodeId, inputHash) 导入前驱输出，零调用命中） | 可恢复性 |
| R3 | 结算状态机 cancel ≠ fail（五态定稿 + stopReason + superseded 通知抑制） | 可恢复性 |
| R4 | 声明式权限闭环（命令白名单 / 域名清单，fail-closed） | 权限闭环 |
| R5 | 结构化提交裁决（platformAgent outputSchema 三值裁决） | 提交裁决 |
| R6 | 渐进产物与失败抢救（journal 化 report + 产出清单聚合区） | 渐进产物 |
| R7 | 事件全序与统一回放（seq 同事务分配 + journal 回放逐字节一致） | 可恢复性 |
| R8 | 确定性会话身份与模型 pin（会话铸造 + persona 冻结 + 禁静默换模型） | 可恢复性 |
| R9 | 工程决策包（挂起注释固化 / 通知 claim / 诊断分级 / 上限两档） | 工程决策与试运行 |
| R10 | 画布试运行（mock 执行通道产品化 + 单节点/全图试跑 + 产物隔离） | 工程决策与试运行 |

排期耦合提示：R1/R3/R7/R8 共享同一块地基（节点实例键 + 状态词表 + journal 真相源），契约须先行一次定稿；R2/R3/R6 的 UI 变更（cached 徽章 / stopped 标签 / 渐进结果区）同落 `canvas-results-panel` 与运行历史，应合并一批交付（见全局非功能要求 NFR-5）。多项验收以 mock 调用记录为仪器，R10 的产品化 mock 内核建议基建先行（req-runtime.md 跨领域问题 8）。

---

## R1 Journal 确定性重放与 resume

### 背景

现状断点续跑只覆盖「进程内优雅失败/取消」：gateway 崩溃后 boot sweep 把在途 run 一律改标 `failed`（`apps/gateway/src/index.ts:86-99`），且崩溃时进程内的 `terminalize('resumable')`（`apps/gateway/src/routes/workflows.ts:546-556`）从未执行，checkpoint 停在 `status='running'` → resume 路由 409 拒绝（`apps/gateway/src/routes/execution-resume.ts:106-108`）。同时续跑种子按 nodeId 粗粒度复用：`run_node_spans` 唯一索引 `(run_id, node_id)` 使迭代体节点跑 N 项只剩最后一项（`packages/db/src/migrations/1720000093000-unique-run-node-spans.ts`；upsert `ON CONFLICT (run_id, node_id)` `apps/gateway/src/span-writer.ts:76-85`），且无 input_hash——上游配置变更后种子输出与新输入静默错配（resume 守卫明言「配置变更允许」，`execution-resume.ts:113-117`）。

### 现状锚点

- 引擎种子机制现成：`ExecuteOptions.resume`（`packages/workflow/src/engine/executor.ts:71`）→ `ResumeOptions { seedOutputs, seedRuntime, iterationProgress }`（`executor.ts:98-106`）；已种子节点跳过执行并释放出边（`executor.ts:537-551`）。
- checkpoint 管线现成：`makeCheckpointHook` 串行链（`apps/gateway/src/routes/resume-execution.ts:79-95`）、`buildResumeSeed`（`resume-execution.ts:366-402`）、认领互斥（`resume-execution.ts:185-198`）、`topo_hash` 护栏（`resume-execution.ts:40-54`）。
- 缺口：无节点实例键、无 input_hash、boot sweep 中断=失败、迭代体无 per-ordinal 记录（三路摸底 R1 节一致结论）。
- chat 触发路径不写 checkpoint（`apps/gateway/src/routes/chat-execute.ts:496-506`、`apps/gateway/src/routes/chats.ts:733-737` 均未传 `onCheckpoint`）——范围裁决见开放问题 OQ-5。

### 需求描述

1. **节点实例键 `(runId, nodeId, ordinal)`**：iteration 第 n 次执行体节点即独立一档（非迭代节点 ordinal=0）。journal 数据源可基于 `run_node_spans` 扩展或新表，但必须与 R7 事件流**同一真相源**（单表或同事务写入，禁止双写双真相源）；具体 schema 选址见开放问题 OQ-1。
2. **input_hash 定义（定稿口径）**：对「模板解析完成后的节点 resolved 输入」做键序规范化 JSON 序列化后 SHA-1（写法对齐 `computeTopoHash`，`resume-execution.ts:40-54`）。序列化必须排除非确定性字段（时间戳类），确定性由单测钉住。
3. **执行前查 journal**：引擎执行节点前先查——`completed` 且 hash 一致 → 短路复用输出（零 CLI/LLM 调用）；`running`（崩溃残留）→ 按记录重派；hash 不一致 → 结构化响亮失败（错误带 nodeId + expected/got hash），绝不静默偏移。
4. **boot sweep 三件收敛 + 诚实边界**：① `runs` 在途行 `running/pending` → `stopped`（`stop_reason='interrupted'`）——无 checkpoint 的 run（chat 触发路径，OQ-5 未纳入 P0）同样标 stopped（中断事实本身诚实），但其 resume 可用性按 checkpoint 存在性判（见⑤）；② `run_node_spans` 悬空 running 行同步收敛 stopped(interrupted)；③ **`run_checkpoints` 悬空 `running` 行 → 收敛 `resumable`**——崩溃时进程内 `terminalize('resumable')` 从未执行，checkpoint 停在 `running` 会让 resume 路由 409（`execution-resume.ts:104-108` 只认 `resumable`），不收敛则 AC-R1-1 的 resume 步骤走不通；④ 真失败（catch 路径）仍 `failed`；⑤ **resume 可用性判据 = checkpoint 存在且 `resumable`**，UI 入口与该判据联动——无 checkpoint 的 stopped run 显示「已中断」但不渲染「从此处继续」（不假承诺，NFR-6）。
5. **resume 入口（checkpoint 词表不扩）**：沿用 `POST /workflows/runs/:runId/resume`（新 runId + 谱系）。checkpoint 侧词表维持现有四值 `running / awaiting_input / resumable / terminal`（`packages/db/src/entities/run-checkpoint.entity.ts:14`），**不新增 'stopped'**——stopped 的可恢复性由「runs 行 stopped(interrupted) + boot sweep 将 checkpoint 收敛为 `resumable`」组合表达，resume 路由的 `resumable` 闸门原样复用、无需扩词表。
6. **P0 范围**：已接 checkpoint 管线的路径（画布直跑 `workflows.ts:463`、resume、answer）。chat 触发路径（@flow / chat 流式）不纳入 P0，见 OQ-5。
7. **迁移兼容存量**：存量行 ordinal 默认 0、无 hash 则跳过校验照旧种子化（行为不劣于今天）。

### 验收标准

- **AC-R1-1（e2e）**：mock provider run 进行中 kill gateway → 重启 boot sweep 后 runs 行 `status='stopped'`（非 failed）且 `stop_reason='interrupted'`、对应 checkpoint 行收敛为 `resumable`（非 running）→ `POST resume` 成功返回新 runId → mock provider 调用记录证明已完成节点零重调（前驱调用数 = 前后总调用数），从断点节点继续。
- **AC-R1-2（e2e/DB）**：迭代 3 项中第 2 项失败 → resume 只重跑第 2、3 项；journal 中每个 `(nodeId, ordinal)` 各一档、互不覆盖（SQL 查询可验）。
- **AC-R1-3（单测）**：改上游节点 prompt 后 resume（input_hash 不一致）→ run 结构化失败，错误文本含 nodeId + expected/got hash；绝不静默复用种子输出。
- **AC-R1-4（单测）**：input_hash 确定性——同输入多次计算同 hash；对象键序打乱后 hash 不变。
- **AC-R1-5（迁移）**：迁移后既有 `run_checkpoints`/`run_node_spans` 老数据可读可渲染；gateway 单测库 `dagents_gw_test` 迁移链自动建库通过；老 run resume 行为不劣于现状。
- **AC-R1-6（UI，入口与 checkpoint 存在性联动）**：stopped(interrupted) run 在直跑面板、`?run=` 旁观与 chat 执行卡（`apps/console/src/components/workflow-run-card.tsx`，R3.6 所列第四消费点）三处均收尾定格（轮询停、显示「已中断」）。**有 checkpoint**（画布直跑路径）→ 显示「已中断（可恢复）」并出现「从此处继续」入口，点击后续跑已完成节点徽章保持 done、终端视图无新 nodeStart 段；**无 checkpoint**（chat 触发路径）→ 显示「已中断」**不渲染**可恢复入口（诚实不假承诺，NFR-6）。

### 涉及面

`packages/workflow/src/engine/executor.ts`（种子短路前置查询）、`packages/db`（迁移：实例键/序号列）、`apps/gateway/src/index.ts`（boot sweep 分流）、`apps/gateway/src/routes/execution-resume.ts` + `resume-execution.ts`（stopped 可 resume、journal 查询）、`apps/console/src/components/canvas/canvas-kit-page.tsx`（resume 入口扩展至 stopped）+ `canvas-results-panel.tsx`（CanvasRunState 加 stopped 态）。

### 风险

- 表选址未定（OQ-1）：`run_node_spans` 加列需重建唯一索引，console 消费键从 `(nodeId)` 变 `(nodeId, ordinal)`，波及摘要/终端/latestSpans 全链。
- input_hash 口径错杀：非确定性输入（时间戳、随机）会导致永久 miss——canonical 化规则须在设计评审专项确认。
- boot sweep 改标与 R3 状态机耦合，须同批交付（词汇表一次定稿，见 R3）。

### 负责方向

可恢复性（R1 R2 R3 R7 R8）

---

## R2 修订重跑暖缓存

### 背景

「重跑」现状 = 记忆输入的全量新 run（`apps/console/src/components/canvas/canvas-results-panel.tsx:356-367` 只打开输入面板；输入记忆 localStorage `dagents.canvas.runInput.<flowId>`）。修一个节点的 prompt 也要从 Start 全量重烧全部 LLM/CLI 调用。全仓无 `inputHash|input_hash|warmCache|dryRun` 任何命中（本次 grep 核验为零）。token 记账每 run 独立一笔（`apps/gateway/src/usage-events.ts`，AD-3 唯一真相源），无跨 run 继承概念。

### 现状锚点

- 谱系列已有：`runs.resumed_from_run_id`（`apps/gateway/src/repositories/runs.repo.ts:142,232-247` COALESCE 保已存值）；UI 已消费（「↩ 续跑」chip，`apps/console/src/components/flow-runs-panel.tsx:226-233`）。
- 引擎 `ResumeOptions.seedOutputs` 对跨 run 导入天然兼容（换来源组种子，调度器无感）。
- 契约缺口：`NodeSpanStatus` 无 cached 态（`packages/db/src/entities/run-node-span.entity.ts:32-39`：running/done/failed/paused/unknown）；run-live `nodeEnd.status` 仅 `'done' | 'failed'`（`packages/contracts/src/run-live.ts:64`）。
- token 双计风险：cached 节点若 span.tokens 写继承值且 runs 聚合又含前驱值，`tokensBadge` 与节点画像（`flow-runs-panel.tsx:149,164`）会双计（req-console.md R2 缺口）。

### 需求描述

1. **暖缓存导入与谱系书写（定稿，解鸡生蛋）**：「暖缓存重跑」本身**写 `resumed_from_run_id` 指向被重跑的 run**——谱系列从 resume 专用升格为暖缓存第一等公民；否则首次暖缓存重跑的前驱（被重跑的那个 run）不在任何 lineage 链上（现状重跑 = 全新 run 不写谱系，`runs.repo.ts:142` 谱系是 resume 专用），按链查找永远 miss，AC-R2-1 无法达成。查找域 = 沿 `resumed_from_run_id` 链溯源至根的 `(nodeId, inputHash)` 最近命中；导入命中前驱的完成节点输出为种子，未受影响子图全部 cached 命中。「全新重跑」（需求 5 分叉）不写谱系、零缓存。
2. **受影响子图判定必须保守**：任一上游真实重跑（hash 变化），其下游全部强制重跑（宁可多跑不错复用）。
3. **cached 契约（定稿）**：`NodeSpanStatus` 与 run-live `nodeEnd.status` 各增 `'cached'` 枚举（帧形状不变，双 builder 兼容）；span 行 cached 节点 tokens 记继承值 + 新增 lineage 载荷（`inheritedFromRunId` + 继承 token 数）用于 UI 标注与对账。
4. **token 记账口径（定稿）**：`usage_events` 只记真实调用——cached 节点不入账、不重复计费；runs 行与结果面板提供「lineage 继承累计 + 本次新增」双口径展示。
5. **交互分叉**：重跑入口（结果面板/历史行/终端行三处）提供「暖缓存重跑」（默认）与「全新重跑」显式分叉。
6. **诚实 miss**：前驱 run 被 retention 清理（`apps/gateway/src/retention.ts`）后暖缓存 miss 全量重跑，不报错。

### 验收标准

- **AC-R2-1（e2e）**：5 节点线性链改第 3 节点 prompt 后暖缓存重跑 → 节点 1-2 span `status='cached'`、零新增 `usage_events` tokens、mock provider 调用数 = 3（仅节点 3-5 真实执行）。
- **AC-R2-2（e2e/UI）**：cached 节点画布徽章独立态（≠done）；终端视图不出现假 CLI 提示行（`commandOf` 对 cached 节点渲染「来自缓存」或跳过）；轨迹泳道零时长段 + cached 标注。
- **AC-R2-3（对账单测）**：暖缓存 run 总 token = 前驱累计 + 本次新增；`usage_events` 无种子节点重复记账；结果面板 token 徽章与账单页（usage-summary）口径一致。
- **AC-R2-4（e2e）**：删除/retention 清理前驱 run 后暖缓存重跑 → 全量真实执行，无 5xx、无残留报错。
- **AC-R2-5（UI）**：FlowRunsPanel 历史行可见暖缓存 lineage（「⚡ 暖缓存自 {runId 短码}」chip，同「↩ 续跑」样式模式）。

### 涉及面

`apps/gateway/src/routes/workflows.ts`（run 编排层前驱查找+种子组装）、`packages/db`（span cached 态 + lineage 载荷）、`packages/contracts/src/run-live.ts`（nodeEnd.status 扩枚举）、`apps/console`：`canvas-kit-page.tsx`（SPAN_STATUS_MAP/cached 态）、`canvas-results-panel.tsx`（行级标注 + 重跑分叉）、`flow-runs-panel.tsx`（lineage chip）、`lib/run-terminal-format.ts`（cached 行）、`apps/console/src/i18n/en/flows.ts`（词条）。

### 风险

- 依赖 R1 input_hash 先行（口径同源，不得两套 hash）。
- 受影响子图判定漏判 = 错误复用旧输出（比浪费更严重），判定逻辑须有专项单测（改上游 → 下游全重跑的传递闭包用例）。
- token 双计是真实风险（现状 UI 两处聚合），对账口径须与 R6 产出清单的 token 展示一并定。

### 负责方向

可恢复性

---

## R3 结算状态机：cancel ≠ fail

### 背景

现状八态 DB CHECK（`packages/db/src/migrations/1720000103000-widen-runs-status-chk.ts:17`）但 TS `RunStatus` 仍五态（`packages/db/src/entities/run.entity.ts:23`）——类型与 DB 已漂移。cancelled 已是独立终态（引擎 `executor.ts:289-319`、`toRunStatus` `apps/gateway/src/routes/workflow-engine-service.ts:259-267`），但 UI 把 cancelled 折进 failed 红态渲染（`summarizeWatch` `canvas-kit-page.tsx:355-369`）、无 stopReason（全仓 grep 仅 ACP 协议域命中，runs 域零命中）、superseded 语义只有 abort 理由字符串（`apps/gateway/src/execution-registry.ts:80` `'superseded by a new execution in this chat'`）落库仍是 cancelled。

### 现状锚点

- 引擎→run 状态映射有两份：单源 `toRunStatus`（`workflow-engine-service.ts:259-267`）与 resume/answer 路径手写三元链（`resume-execution.ts:319-328`）——漂移温床，重塑时须收敛单源。
- cancelled 已可 resume（数据面）：非 success 终态（含 failed）checkpoint 一律落 `resumable`（`workflows.ts:546-556`），resume 路由只查 checkpoint 状态不查 run 状态（`execution-resume.ts:104-108`）——**现状 failed run 可以 resume**，e2e RM-01「第 3/4 节点失败 → resume 零重跑」即此场景的实弹钉子（`apps/console/tests/e2e/24-run-resume.spec.ts:34`）。
- console 四个消费点：`STATUS_LABEL`（`flow-runs-panel.tsx:43-53` 八词）、watchTick 终态判定（`canvas-kit-page.tsx:388`）、旁观循环（`:702`）、聊天执行卡（`apps/console/src/components/workflow-run-card.tsx:83`）。
- runEnd 帧透传任意 status 字符串（`packages/contracts/src/run-live.ts:70`）——直播路对新词天然兼容。
- run 完成通知机制不存在（WS 仅 chat 域事件 `apps/gateway/src/ws-hub.ts:29-35`；console 桌面通知只认 `chat:done`/`chat:error`，`apps/console/src/lib/use-task-notification.ts:210-259`）——superseded 抑制依赖 R9b 载体（OQ-2）。

### 需求描述

1. **状态词表定稿（一次改齐，冻结）**：

   | 类别 | 词表 |
   |---|---|
   | 非终态 | `pending` / `running` / `awaiting_input` |
   | 终态 | `completed` / `partial_success` / `budget_exceeded` / `failed` / `stopped`（新增） |

   `partial_success`/`budget_exceeded` 现有语义原样保留。**终态 resume 策略一次裁齐**（checkpoint 现状：非 success 终态一律落 `resumable`，`workflows.ts:546-556`）：`completed` → 不可（checkpoint `terminal`）；`failed` / `partial_success` / `budget_exceeded` / `stopped` → **可**（详见第 4 条，不劣化现状）。种子五态中的 `errored` 并轨处理：**保留 `failed` 不做二次改名**（cancelled→stopped 已是一次破坏性改名，failed→errored 是第二次，破坏大收益低），错误来源分类由 `stop_reason` 承担（见 OQ-7 确认项）。
2. **`stop_reason` 列（五值落位，无死值、无双重归属）**：`stopped` 行取 `user`（= 旧 cancelled）/ `interrupted`（boot sweep）/ `superseded`（**chat 域 latest-wins 取代**——同 chat 新执行 abort 旧句柄，`execution-registry.ts:72-84` one-execution-per-chat，是 superseded 唯一真实产生链路；**暖缓存不产生该值**：R2.1 定稿暖缓存写谱系指向被重跑 run，该前驱必已终态（暖缓存导入其完成节点输出才有意义），对已终态 run 无 abort 语义可言，「被暖缓存取代」链路不存在，实现者不得去找/造该链路）；`failed` 行取 `model`（引擎/模型执行错误，默认）/ `provider`（HTTP/provider 调用失败归因）。**不设 `stopped(provider)`**——引擎失败出口只有 failed/cancelled（`executor.ts:313-319`），provider 故障在 R8 裁决下走 `failed(provider)`（pin 响亮失败）或降级 CLI（非 pin），全链路无产生 `stopped(provider)` 的路径；若未来要「provider 故障可恢复中断」属新链路需求另行立项。`provider` 归属唯一化：同为 provider 故障，pin 场景落 `failed(provider)`、非 pin 走降级不产生终态。
3. **cancelled → stopped(user)（写新读旧）**：写侧新 run 一律落 `stopped(user)`；**存量 cancelled 行不迁移**，读侧（console 终态判定/标签映射）双读兼容同时认两词；**DB CHECK 新词表显式保留 `cancelled`**——PostgreSQL `ADD CONSTRAINT ... CHECK` 默认 VALID 模式扫全表校验存量行，词表若剔除 cancelled、存量行会直接让迁移失败（炸库，NFR-1 通用条款）；改名 PR 必须同批更新 e2e 断言与 Mock Provider 脚本（AGENTS.md e2e 残留清扫教训）。
4. **终态与 resume 正交（现状能力不劣化，消除与 AC-R1-2/AC-R1-5 的硬冲突）**：种子「failed 是终态」是**词表归类陈述**（终态行不再被 boot sweep/后台任务自然流转，只有显式 resume/answer 开新 run），**不是 resume 禁令**。resume 闸门 = checkpoint 状态（`resumable` 即可 resume，`execution-resume.ts:104-108`），现状非 success 终态一律落 `resumable`（`workflows.ts:546-556`）——因此 `failed` / `partial_success` / `budget_exceeded` / `stopped` / 存量 `cancelled` **全部保留可 resume**（e2e RM-01「失败→resume 零重跑」`24-run-resume.spec.ts:34` 是必须继续通过的回归钉子；迭代项失败场景 run 终态正是 failed，`executor.ts:313-319`）。`budget_exceeded` 的 resume 支持可选 `tokenBudget` 覆盖。**缺省口径（定稿，修正 v1.1 失实描述）**：不覆盖时沿用前驱预算值，且新 run 预算计数**从零起算**——引擎现状 `ctx.tokensSpent` 启动置 0（`executor.ts:258`）、仅真实执行节点累加（`:631`）、种子节点跳过执行不产生 usage，前驱已耗**不结转**，故缺省续跑**不会**立即再触顶；为防对账错觉，resume 启动时过程流黄警披露「预算重新起算（谱系链累计已耗 X tokens）」。`completed` 的 checkpoint 落 `terminal` 不可 resume（现状语义不变）。
5. **superseded 不发终态通知**：抑制以服务端为主（gateway 对 `stop_reason='superseded'` 的 run 不产生用户可见终态通知；runEnd/live 帧带 stopReason 供客户端兜底过滤 `use-task-notification.ts:210-259`）——通知载体选型见 OQ-2，载体落地前先以帧标注 + 客户端过滤最小实现。
6. **词汇单点化（清债）**：DB CHECK 迁移、TS `RunStatus` 类型（清 5/8 漂移，对齐 DB）、`toRunStatus` 收敛 resume 手写映射为单源、console 四消费点（STATUS_LABEL/watchTick/summarizeWatch/workflow-run-card）**同一批次**改齐；`recordRunFinished` 指标标签集（`apps/gateway/src/lib/run-gate.ts`）并入新词。**顺带修现状 bug**：`workflow-run-card.tsx:83/87` 的轮询起停终态清单只有 completed/failed/cancelled 三词——chat 执行卡看 `partial_success`/`budget_exceeded`（2026-10-04 引入）终态时 700ms 轮询永不 `clearInterval`（轮询泄漏）；改齐批次必须将该清单扩为**词表全集**，不得只做 cancelled→stopped 双读而留存该泄漏。
7. **boot sweep 分流**：中断 → `stopped(interrupted)`（与 R1 同批）；真失败 catch 路径仍 `failed`。

### 验收标准

- **AC-R3-1（e2e）**：用户取消 → runs 行 `(stopped, user)` 且可 resume；**failed run 保留可 resume**（现状能力不劣化——RM-01「失败→resume 零重跑」场景 `24-run-resume.spec.ts:34` 回归通过；迭代项失败场景同款）；`budget_exceeded` resume **双路径**：携新 `tokenBudget` 覆盖生效、缺省沿用前驱预算值且新 run 预算从零起算（不立即触顶）+ 过程流有「预算重新起算（累计已耗 X）」黄警。「终态」归类语义核验：终态行不被 boot sweep/后台任务改写（仅显式 resume/answer 开新 run）。
- **AC-R3-2（e2e，与 AC-R1-1 同场景）**：kill gateway → 在途 run `(stopped, interrupted)`，resume 入口可用。
- **AC-R3-3（单测）**：`toRunStatus` 单源覆盖三入口（直跑/resume/answer）产出一致；TS `RunStatus` 词表与 DB CHECK 一致（类型测试 + 迁移测试双钉）。
- **AC-R3-4（UI）**：用户取消显示「已停止」（非失败色）+ resume 入口；interrupted 显示「已中断」且 stopReason 可见于 tooltip/详情，两者可区分；watchTick（`canvas-kit-page.tsx:388`）与旁观（`:702`）终态清单含 stopped、轮询正确收尾；**`workflow-run-card.tsx` 终态清单扩为词表全集**——chat 执行卡对 completed/failed/stopped/partial_success/budget_exceeded 全部终态正确 `clearInterval`（现状三词清单的轮询泄漏一并修复，组件测试或 e2e 断言 partial_success 终态后定时器清除）。
- **AC-R3-5（存量回归）**：cancelled/partial_success/budget_exceeded 存量行渲染不回归（双读兼容生效）；全量 e2e 同步更新后绿。
- **AC-R3-6（通知抑制，分步口径）**：**最小实现阶段**（载体未落地，runEnd 帧带 stopReason + 客户端过滤）——过滤逻辑以单测/组件测验证：注入带 `stop_reason='superseded'` 的帧断言 `use-task-notification` 通知链与画布 toast 链零触发（注：画布 run 现状零推送通知、该路径为结构性成立，实弹验证面 = chat 路径通知链 + 画布 toast 链，不是空验证）；**载体落地后**——多入口清单（画布旁观页 + 聊天执行卡 + 第二标签页同看同一 run）e2e 场景下 superseded run 零通知、正常 run 仅一次通知（与 AC-R9-3 同批并发单测）。
- **AC-R3-7（债务清理）**：`summarizeWatch` 不再把 cancelled 折进 failed 态（`canvas-kit-page.tsx:359-362` 现状债务清除）。

### 涉及面

`packages/db`（CHECK 迁移 + stop_reason 列，先例 `1720000103000` / `dispatch_tasks.failure_reason`）、`packages/db/src/entities/run.entity.ts`（类型对齐）、`apps/gateway`：`workflow-engine-service.ts`（toRunStatus 单源化）、`resume-execution.ts`、`index.ts`（sweep）、`execution-cancel.ts`、`run-gate.ts`（指标）；`packages/contracts/src/run-live.ts`（runEnd 帧 stopReason）；console 四消费点 + `use-task-notification.ts`；e2e 全量断言同步。

### 风险

- 破坏性改名波及面大（console 轮询终止条件、chat 执行卡、e2e、Mock 脚本）——必须契约先行、单 PR 全链路改齐或明确双读期，禁止中间态词表导致 console 适配两轮。
- run 终态通知载体不存在（OQ-2），superseded 抑制的完整验收依赖 R9b 载体落地——分两步验收（帧标注先行）。

### 负责方向

可恢复性

---

## R4 声明式权限闭环

### 背景

customFunction 现状是 worker_threads 纯 JS、**无命令执行通道**（危险全局形参 shadow，`packages/workflow/src/nodes/custom-function/user-code-exec.ts:14-19,22-37`「隔离不是沙箱」）；http 节点只有协议白名单 + SSRF 私网阻断（`packages/workflow/src/nodes/http/http.node.ts:74-86`），任意公网域名 fail-open 放行。`validateFlowTopology` 是纯结构校验（`packages/workflow/src/utils/validate-topology.ts:172-270`），无任何权限声明规则；gateway 保存/运行入口不跑拓扑校验（`apps/gateway/src/routes/workflows.ts:396-399` 只查数组形状）——fail-closed 若只写进校验器不进运行前置，改一道 JSON 就绕过。

### 现状锚点

- `TopologyError { node?, edge?, message }` 定位结构 + 画布标红管线现成（`canvas-kit-page.tsx:758-767` 复用 failed 徽章样式）。
- console 表单声明式驱动：注册表加参数 = inspector 配置 UI 自动出现（`apps/console/src/components/flow-canvas/inspector/InspectorPanel.tsx:83-92` + `form-engine.tsx` json 控件带即时校验红框）——编辑面成本≈0。
- 运行前确认面天然位置：运行输入面板（`canvas-kit-page.tsx:951-1057`）；预扫先例 `extractHumanInputPrompts`（`apps/console/src/lib/flow-human-inputs.ts`）。
- 生成器内容风险扫描先例：`scanGeneratedFlowRisks`（`apps/gateway/src/routes/flow-generator.ts:584-622`，warning 级）。
- flowDataSchema data 是 passthrough（`packages/workflow/src/utils/flow-data.ts:12-22`）——新字段无需破坏性 schema 变更。

### 需求描述

1. **语义指向（定稿）**：customFunction 的「命令白名单」授权的是**新增的受控命令执行通道**——声明 `allowedCommands` 后用户代码经受控 exec API（gateway 层受控 spawn，非用户代码直连 child_process）调用白名单命令；**缺席 = 通道不存在 = 全封**（与现状零命令能力兼容，存量 customFunction flow 不受冲击）。platformAgent CLI Bash 工具授权面（`--allowedTools` 旗标层，反向先例 `workflow-clients.ts:277-280` `--disallowedTools`）**不纳入 R4 v1**，见 OQ-3。
2. **契约先行（字段定稿）**：`allowedCommands: string[]`（customFunction）、`allowedDomains: string[]`（http）——workflow 包（CANVAS_NODES 注册 + `flowDataSchema` + `validateFlowTopology`）与 gateway 执行层**同一 PR** 定稿；console 表单/校验/确认面全部声明式依赖它。
3. **http 域名清单 fail-closed**：请求域名 ∉ 清单即节点拒绝，错误带 node 定位与「如何声明」指引；重定向**逐跳复检**同清单（复用 `http.node.ts:120-144` 结构）；与既有 SSRF 守卫叠加（两层都过才放行）。
4. **validateFlowTopology 校验声明合法性**（语法/形状/域名格式/命令格式），错误带 node 定位，保存时即报（与环检测同体验），不到运行时才炸。
5. **运行前确认面**：提交前展示全图闭合命令集与域名集（客户端预扫静态部分；模板变量解析出的动态命令给「运行时裁决」诚实提示）；确认面文案与执行层放行集**同源常量**（一张皮，UI 说的和守卫放的一致）。
6. **存量策略（建议方案，终裁 OQ-4）**：内置/团队模板与 flow-generator 产物一次性全量补声明（生成管线 prompt 教 LLM 产出 + `normalizeToCanonicalFlow` 保真透传）；用户存量 http flow 设过渡期（未声明 = 确认面黄警 + 放行），过渡期后 enforcement 默认开启。
7. **执行层 fail-closed**：白名单缺席即拒绝，逃生门语义必须显式（不静默）；customFunction 受控 exec 通道继承 executablePath 注册校验与 CLI spawn 闸（`apps/gateway/src/lib/cli-spawn-gate.ts`）。

### 验收标准

- **AC-R4-1（单测）**：http 节点声明 `allowedDomains: ['api.github.com']` 后请求 `api.gitlab.com` → 节点失败、错误含节点 id 与未声明域名；重定向跳转至未声明域名同样被拒。
- **AC-R4-2（单测）**：customFunction 无声明 → 受控 exec 通道不可用（调用即结构化错误带指引）；声明后未列命令被拒、已列命令放行且经 spawn 闸。
- **AC-R4-3（单测/UI）**：保存含非法声明（域名格式错/白名单非数组）→ `validateFlowTopology` error 带 node 定位、画布标红（与环检测同体验）。
- **AC-R4-4（单测）**：确认面展示的命令集/域名集与执行层放行集逐字一致（同源常量测试钉住）。
- **AC-R4-5（e2e）**：恶意 flow JSON（未声明外域名/命令）被拦在执行层而非靠生成器自觉。
- **AC-R4-6（清单扫描）**：模板中心与生成器产物全量带声明（对内置 JSON 模板 + `flow_templates` 做一次扫描断言零缺席）。

### 涉及面

`packages/workflow`：`custom-function.node.ts` + 受控 exec API + `http.node.ts` 域名守卫 + `validate-topology.ts` 新规则 + `node-registry-canvas.ts` 注册；`apps/gateway`：`flow-generator.ts`（prompt + 保真 + 风险扫描升级）、`workflows.ts`（运行前置校验）、受控 spawn 层；console：inspector 自动渲染 + 运行面板确认区 + i18n（`t('中文')` + `en/flows.ts`）；模板中心迁移脚本。

### 风险

- 受控命令执行通道是**新增攻击面**：必须 gateway 层受控 spawn（继承 executablePath 双重校验、spawn 闸、无 shell 注入面），设计评审重点。
- 存量策略终裁未落（OQ-4）：fail-closed 全量立即生效会拒掉所有存量 http flow——过渡期机制必须与执行层同批落地，不能只做守卫不做迁移。
- 确认面与放行集漂移（两张皮）——同源常量是硬约束。

### 负责方向

权限闭环（R4）

---

## R5 结构化提交裁决

### 背景

LLM 节点已有 outputSchema 全链（声明 `llm.node.ts:53-61` → schema 编入 system `:192-200` → 校验 + **一轮**修复回喂 `:280-292` → 仍失败诚实抛错 `:294-302`，校验器 `json-schema-lite` 错误即 path 表达）。platformAgent 完全没有 outputSchema（inputs 仅 agentId/systemPrompt/maxIterations，`platform-agent.node.ts:39-60`），maxIterations 耗尽只追加尾注不追问（`:205-212`）。CLI 路径「同一会话」现状 = 每次 `chat()` 新起进程、全部 messages 折叠单 prompt（`apps/gateway/src/routes/workflow-clients.ts:173-187,286-315`）——「回喂修复不重跑」在 CLI 后端的落地依赖会话延续能力（与 R8 同一块地基）。

### 现状锚点

- 工具循环 messages 数组就在节点作用域（`platform-agent.node.ts:131-203`）——回喂消息的 push 点现成。
- `runNodeSinks` 证明 CLI 会话可跨 chat 调用存活并被外部写入（`workflow-clients.ts:60-107`），但只有 send 无 await 回执。
- `SchemaIssue` 现只有 path+message（`packages/workflow/src/utils/json-schema-lite.ts`）——需扩 expected/got。
- e2e 仪器先例：mock 的 `toolResultContains`/`hasToolResult` 谓词可断言回喂内容。

### 需求描述

1. platformAgent inputs 增 `outputSchema`（json 控件，与 LLM 节点同声明同校验；inspector 零新组件）。
2. **三值裁决**：① 合格 → 收下，输出带 `json` 字段（`{{id.json}}` 可引用，对齐 LLM 节点）；② 违规 → 以 `path/expected/got` 形式回喂修复（`SchemaIssue` 扩 expected/got），**同一会话内修复、不整节点重跑**（上游零重调）；③ 轮次结束未交付 → NUDGE 式追问一次。
3. **预算尺度（定稿，对齐「只修一轮」克制哲学）**：每节点至多 **3 次** LLM/CLI 交互 = 原始执行 + 1 轮修复回喂 + 1 轮 NUDGE 追问；两轮后仍无合规产出 → 诚实失败（不降级收下、不伪装成功）。
4. **CLI 会话延续边界（定稿）**：v1 只对 claude 档承诺同进程会话延续（`--resume` 类适配器能力）；其余 kind 诚实降级为 messages 数组回放的逻辑会话（重 spawn），过程流留「会话重建」活动行，**合规性判定不因降级放宽**。
5. **轮次可观测**：span events 可见「第 N 轮裁决 / 回喂了什么 / 结果如何」；回喂轮在终端视图可见且与节点重跑视觉区分（同段内多轮，不新开 segment）。

### 验收标准

- **AC-R5-1（e2e）**：platformAgent + outputSchema，mock 返回不合规 → 同一节点内出现第二条 user 修复消息（含 path/expected/got），上游节点零重调（mock 调用数不变）。
- **AC-R5-2（claude 档，口径修正 v1.3——原「不重 spawn/计数不增」与 `--resume` 物理现实冲突）**：修复轮以 `--resume` 恢复同一 CLI 会话——断言三点：① 修复轮 chat 返回的 `result.sessionId` 与原始轮相同（会话 id 守恒）；② 过程流无「会话重建」活动行（mode = resume）；③ `/metrics` CLI spawn 计数恰 +1（OS 进程必然重 spawn——claude `-p` 一次问答即退、裁决须待最终文本，无进程复用窗口；+N 才是异常，示逐轮会话链泄漏）。
- **AC-R5-3（单测）**：修复成功 → 输出带 `json` 字段；修复 + NUDGE 两轮后仍失败 → 节点失败、错误含 path 违规定位、无空壳成功。
- **AC-R5-4（降级路径）**：非 claude kind 走逻辑会话重放，过程流有「会话重建」活动行；同场景合规性判定结果与 claude 档一致（同一 mock 脚本两档对照）。
- **AC-R5-5（UI）**：inspector 出现 outputSchema 编辑位（json 控件即时校验，与 LLM 节点同控件）；最终失败的 schema 违规对照在摘要视图行内可读。
- **AC-R5-6（预算上限单测）**：违规场景下每节点 LLM/CLI 交互总数 ≤ 3（无限追问被钉死）。

### 涉及面

`packages/workflow`：`platform-agent.node.ts`（outputSchema + 三值分支）、`json-schema-lite.ts`（expected/got）、`node-registry-canvas.ts`；`apps/gateway/src/routes/workflow-clients.ts`（会话延续/回放）；`packages/agent-adapters`（claude resume 旗标）；console：events kinds 白名单同步（`run-trace-model.ts:88-96` / `run-terminal-format.ts:62-70`）+ i18n。

### 风险

- 会话延续依赖适配器域能力（claude `--resume` 类），16 个 docs-only 适配器不可承诺——降级路径必须同批交付（不能只做 claude 档）。
- 修复轮与节点重跑的 span 记账区分：当前 onNodeStart/End 一节点一档，轮次信息只能进 events——契约需在实现前与 R7 seq 设计对齐。
- NUDGE 放宽尺度若产品后续要调，必须改本 PRD 定稿值（3 次上限），不许实现层私调。

### 负责方向

提交裁决（R5）

---

## R6 渐进产物与失败抢救

### 背景

观测层「节点完成即写」已成立（span-writer onNodeEnd 终态落 `run_node_spans.output`，`apps/gateway/src/span-writer.ts:187-221`，增量、崩溃前已持久），但失败 run 的交付面缺失：`runs.output` 失败时为 NULL（`workflows.ts:581`，failed 时 finalOutput=null `executor.ts:313-319`），异步路径失败调用方只能逐节点轮询 spans，无「产出清单」聚合；长跑 run 中途失败的产出抢救只能人肉逐个展开节点行。partial_success 已有先例文案（`chat-execute.ts:528-535`「部分分支失败，以下为完成分支的产出」）。

### 现状锚点

- 摘要视图已是逐节点渐进呈现（running 行 live 预览、自动展开跟随，`canvas-results-panel.tsx:600-635`）；终态收尾定格 fetchSpans（`canvas-kit-page.tsx:388-389`）。
- 提取单源已有：`spanToDisplay`（`canvas-results-panel.tsx:119-140`）+ `extractOutputText`（`run-terminal-format.ts:103-123`）——聚合区复用同一提取语义，避免第三套解析。
- 子流程 spans 并入父 run 同 runId（`workflow-engine-service.ts:139-177`）——清单需处理归属展示。
- 去重依赖 R1 实例键（现状 spans 是 (run_id,node_id) 覆盖语义）。

### 需求描述

1. **journal 化 report**：节点完成即写基于 R1 实例键的产出记录，幂等去重（同 `(runId, nodeId, ordinal)` 只一档）；resume/暖缓存不重复累加。
2. **终态产出清单交付**：run 任意终态（completed/partial_success/budget_exceeded/**failed/stopped**）在终态响应体与读面（node-spans 投影或等价端点）提供「已完成节点产出清单」：节点名 + 产出摘要 + tokens + 全文入口；`runs.output` 语义不变。
3. **canvas-results-panel 渐进结果聚合区**：摘要视图扩展（或独立区），按拓扑序聚合已完成节点产物 + 一键复制/下载；未完成节点显式标注（≠失败）；HumanInput awaiting 中断的 run 照常交付已完成部分。
4. **单源原则**：聚合区与单节点行同一提取单源（`extractOutputText`），不出现两套口径。
5. 子流程节点（executeFlow 并入父 run）在清单中有归属标注。

### 验收标准

- **AC-R6-1（e2e）**：5 节点流程第 4 节点失败 → 终态响应与运行历史可见前 3 节点产出清单（节点名+摘要+tokens）；`runs.output` 仍为 null（语义不变）。
- **AC-R6-2（e2e）**：长跑 run 中途失败/stopped → 渐进结果区完整呈现失败前已完成节点产出（不因终态丢失）。
- **AC-R6-3（单测）**：resume 后清单中已种子节点只出现一次（幂等合并，不重复条目）。
- **AC-R6-4（单测）**：聚合区产物文本与单节点行内容一致（同一提取单源测试）。
- **AC-R6-5（UI）**：子流程节点产出有归属标注；产物行可跳终端视图对应区段（复用 spanToTerminalSection 锚点机制）。

### 涉及面

`apps/gateway`：span-writer/journal 读路径 + 清单投影端点；console：`canvas-results-panel.tsx`（聚合区 + CSS 就近 import 遵守孤儿 CSS 护栏）、`run-terminal-format.ts`；i18n 词条。依赖 R1 实例键先行。

### 风险

- 与 R2 cached 标注、R3 stopped 标签同落结果面板——必须按 NFR-5 合并排期，避免反复动刀。
- 清单端点形态（复用 node-spans 响应加投影 vs 新端点）影响 console 消费分支，实现前与 R7 回放端点设计对齐。

### 负责方向

渐进产物（R6）

---

## R7 事件全序与统一回放

### 背景

live 帧无序号只有 `at` 时间戳（`packages/contracts/src/run-live.ts:47-73`，registry `emit()` 单点打点 `apps/gateway/src/run-live-registry.ts:134-139`）；DB 侧独立落库无共享序（spans per-node promise 链 + checkpoint 全局链，两路完全旁路）。双节拍节流（span events 1s/5s）+ 双侧截断（spans 保险丝 800 条/64KB/1MB；live 缓冲 512KB 头部截断 + truncated 标记，`run-live-registry.ts:95-132`）+ restart 后 live 条目全丢（进程内 Map）——「逐字节一致」的三重敌人。断流回退现状是降级不是回放：404 → node-spans 轮询渲染，双 builder 结构一致但数据源是节流+截断后的子集（`apps/console/src/lib/run-trace-model.ts:125/269` 双路投影、`use-run-live.ts:109-116` 断流 unavailable）。

### 现状锚点

- 同事务原子分配序号的仓内已验证范式：`dispatch_task_events` 的 `MAX(seq)+1` 折进 INSERT 同一语句 CTE（`apps/gateway/src/routes/dispatch/tasks.ts:215-235`）+ `(task_id, seq)` 唯一索引（`packages/db/src/entities/dispatch-task-event.entity.ts:15-27`）。
- `hello.replay` 前缀就是「回放进 builder」的先例（`use-run-live.ts:86-91`）——journal 回放只需换数据源，builder 零改动（帧形状不变的前提下）。
- 截断语义已在两 builder 对齐（`run-trace-model.ts:402-417` / `run-terminal-format.ts:323-330`）。
- 现有测试：`apps/console/src/lib/run-trace-model.test.ts`（同源双路等价）；跨源逐字节一致需新测试。

### 需求描述

1. **统一 sequence（执行模型定稿——正确性模型在设计期裁决，不留实测重估）**：seq 在 registry `emit()` 单点由**进程内 per-run 单调计数器**分配（与 `at` 打点同位；run 执行是单进程内串行 emit 的单写者，无需跨进程取号）；journal 落库走异步串行链且**按 seq 保序写入**，`(run_id, seq)` 唯一索引兜底（冲突显式报错而非静默乱序）。**不采用** dispatch 的「INSERT 同语句 CTE 取号」于高频路径（`tasks.ts:215-235` 是同步落库模型，与 NFR-7 热路径约束矛盾）。「同事务原子分配」的本意是防双写者抢号——单写者 + 进程内计数器 + 唯一索引已封死该竞态。为兑现「重启后一致」，帧写库分两层：**结构帧（nodeStart/nodeEnd/runEnd）write-through 同步落库，顺序定稿为先落库后发帧**（journal ⊇ 客户端已收——任意 kill 时机下回放至多多一条在途边界帧；先发帧后落库则回放会缺帧、破坏结构帧承诺，禁止）（低频，与节点数同阶，同步成本可控）；**delta 帧 write-behind 异步落库**（崩溃窗口的未落库尾部允许丢失，以截断/中断标记如实呈现——不劣于现状 live 缓冲重启即全丢）。
2. **RunLiveFrame 增可选 `seq?: number`**（truncated 除外，与 `at` 同位由 emit 单点补）；journal 与 R1 决策记录**同一真相源**（OQ-1 schema 边界内一并承载事件流与 input_hash/输出复用决策）。
3. **断流/重启回放**：live 404/断流 → 从 journal 回放进同一 builder（复用 run-trace-model 双路投影）；回放数据源端点复用 live 路径（hello.replay 由 journal 前缀重建）或等价新端点，**帧形状保持 RunLiveFrame**（console 双 builder 零改动是设计约束）。
4. **保真重裁**：journal 侧不再环形丢弃（落库保全），展示截断语义保留；truncated 标记在 journal 回放中有如实等价物（journal 全量后，有 journal 的 run 不再出现头部缺失提示）。
5. **一致性口径分层（逐字节一致的诚实边界）**：结构帧（nodeStart/nodeEnd/runEnd）承诺**回放 ⊇ 重启前客户端已收前缀、逐字节一致、至多多一条在途边界帧且如实标注**（先落库后发帧顺序的推论——任意 kill 时机下「先落库后发帧」与「先发帧后落库」必有其一侧差一帧，选前者的超集方向；`at`/seq 原值重放、不得重打）；delta 帧承诺「已落库前缀逐字节一致 + 未落库尾部诚实截断标记」——崩溃丢失仅限异步尾部，正常流式期间零丢失。

### 验收标准

- **AC-R7-1（e2e，分层口径 + kill 时机锚定）**：主断言以**节点边界静默期 kill** 消除在途帧竞态（服务端日志断言「节点 N 已完成」后 kill，非任意时机）→ 重连回放 → 结构帧（nodeStart/nodeEnd/runEnd）与重启前**逐字节一致**（帧序列 hash/事件数相同）；辅以任意时机 kill 的鲁棒性断言：回放 ⊇ 重启前已收结构帧前缀、至多多一条在途边界帧且如实标注（先落库后发帧保证，见需求 1/5）；delta 帧已落库前缀一致、未落库尾部以截断/中断标记如实呈现（不静默缺行）。
- **AC-R7-2（e2e/单测）**：同 run 的 SSE 帧 seq 与 journal 行 seq 一一同位，无空洞无重复（唯一索引兜底）。
- **AC-R7-3（e2e）**：无崩溃的正常流式期间（delta 高峰 mock 慢速流全程跑完）journal 零丢失（对比 live 期累计帧数）；崩溃场景丢失仅限异步未落库尾部，且回放端可见截断标记。
- **AC-R7-4（单测）**：跨源（帧 vs journal）双 builder 产出逐字节一致的新测试（扩展 `run-trace-model.test.ts`）。
- **AC-R7-5（UI）**：运行结束后刷新页面（live 404 回退）轨迹/终端视图与关闭前直播一致；有 journal 的 run 不再出现 truncated 头部提示。

### 涉及面

`packages/contracts/src/run-live.ts`（seq 字段）、`apps/gateway/src/run-live-registry.ts`（emit 取号）+ journal 写入事务 + `execution-live.ts`（回放源）；console：`use-run-live.ts`（回放分支）+ `run-trace-model.ts`（seq 优先排序）；`packages/db`（seq 列 + 唯一索引，随 OQ-1）；retention 策略扩展。

### 风险

- seq 执行模型已设计期定稿（emit 单点进程内计数器 + 唯一索引兜底，见需求 1），不再是开放风险；残余量级点：结构帧 write-through 在高节点数 run 的写放大（与 spans 现状同阶）需设计期做一次量级评估。
- 保险丝取消后的存储增长：events 全量落库放大 JSONB 体量——retention（90 天默认）是既有兜底，需在实现时评估单 run 上限与保护性拒收语义（拒收要留痕不静默）。
- 「逐字节一致」验收强度高：at/seq/事件序三方都要钉，测试基建先行的成本要在排期里显式承认。

### 负责方向

可恢复性

---

## R8 确定性会话身份与模型 pin

### 背景

CLI 会话身份非确定性：每次 chat/chatStream 新起会话（`workflow-clients.ts:286-315`），platformAgent 工具循环每轮新建（`platform-agent.node.ts:144-157`）；`runNodeSinks` 只是进程内反查表（`workflow-clients.ts:60-107`，finally 注销），resume 重挂不同会话。persona 无冻结：`createAgentFetcher` 每次实时读库（`workflow-clients.ts:920-951`）——run 执行中改人格立即影响后续节点。模型解析不落库且会静默换引擎：`override.model || params.model || provider.default_model`（`workflow-clients.ts:874-877`）；HTTP 瞬时故障/熔断期间**降级本地 CLI**（`:499-547`，2026-10-04 稳定性专项特意设计）——与「绝不静默换模型」直接冲突，产品边界需裁决。

### 现状锚点

- `ExecuteOptions.sessionId` 只作模板变量不参与会话铸造（`executor.ts:206`）。
- runs 无 model 列；`usage_events.model` 只有 chat 路径填；span tokens jsonb 键是模型名——模型信息散落非 run 级快照。
- 降级总闸 `DAGENTS_DISABLE_LLM_FALLBACK`（`workflow-clients.ts:494-497`，e2e 用）——pin 语义可复用其形态产品化。
- dispatch 域已有会话延续概念先例（`AgentDaemonCall.sessionId` + `ExecOptions.resumeSessionId`，`run.entity.ts:48-49`）。
- UI 插话寻址现状按 (runId, nodeId)：`canvas-kit-page.tsx:524-550`（POST message body `{nodeId, text}`）；stdin 行按 nodeId 列活跃节点（`canvas-results-panel.tsx:538-544`）。

### 需求描述

1. **确定性会话铸造**：run 内 agent 会话 id 由 `(runId, nodeId[, ordinal])` 确定性派生（公式可单测预测；与 R1 实例键同键）；resume 重挂得同一会话 id；跨 run 不串。CLI 侧会话延续依赖适配器（claude `--resume` 类），v1 只对 claude 档承诺进程级延续，其余 kind 诚实降级为逻辑会话（同 R5 边界）。
2. **persona 创建期冻结**：run 创建时快照 instructions/model/skills 进 run 级载荷（载体随 OQ-1/OQ-6 定）；run 内修改人格不影响本 run（不回写库，与 agent-library drift 语义划界：冻结的是 run 视角）。
3. **resolved model 落库**：span 记请求值之外补 resolved 值（HTTP = 实际请求 model；CLI = `cli:<kind>` 形态）；runs 行可查本 run 模型快照；`usage_events` 每节点实际模型可查。
4. **模型 pin 与降级冲突裁决（定稿，吸收开放问题建议）**：**显式声明过模型的节点/Agent = pin**（判定信号：flow 节点 `data.model` 非空字符串，或 agent 行 `model` 非空）。pin 的调用**禁熔断降级**——provider 故障节点响亮失败，过程流明示「因 pin 拒绝降级」，错误含期望/实际模型；**未声明（空串）维持现状基线**——零配置 CLI/provider 默认档 + 降级保可用（CLI 第一性不被破坏）。等价于把 `DAGENTS_DISABLE_LLM_FALLBACK` 的语义按调用粒度产品化。
5. **插话寻址（定稿）**：`POST /runs/:runId/message` body 增可选 `ordinal`；缺省 = 该 nodeId 唯一活跃实例直接寻址；多实例并存（并发 iteration）时缺省返回 409 + 活跃实例清单（客户端列供选择）；console stdin 行显示 `nodeId[ordinal]` 区分同节点多会话。

### 验收标准

- **AC-R8-1（单测）**：会话 id 铸造公式确定性——同键同 id、异 run 异 id、resume 后同节点同 id。
- **AC-R8-2（e2e 对照）**：run 进行中修改 agent 人格 → 本 run 后续节点仍用创建期快照（对照 run 可见差异）。
- **AC-R8-3（单测/e2e）**：显式 pin 的模型不可用（provider 故障/模型下线）→ 节点响亮失败、错误含期望/实际模型、过程流有「因 pin 拒绝降级」活动行；未声明模型 → 走基线（降级可用）且 span 记 resolved model。
- **AC-R8-4（可查性）**：runs/spans/usage_events 三处任一可查每个节点实际使用的模型（对账单测）。
- **AC-R8-5（e2e）**：并发 iteration 场景插话带 ordinal 送达正确实例、回执 user_input 帧落正确段；缺省多实例返回 409 清单。
- **AC-R8-6（UI）**：resume 重挂的 run 终端提示行显示同一模型名（`commandOf` 单源自动受益）；pin 失败节点标红 + 错误含「冻结模型 X 不可用」而非泛化失败。

### 涉及面

`apps/gateway/src/routes/workflow-clients.ts`（铸造函数 + agentFetcher 冻结版 + pin 判定插桩）、`packages/workflow/src/engine/executor.ts`（会话 id 注入链）、`packages/db`（run 级快照载荷，随 OQ-1/OQ-6）、`packages/agent-adapters`（claude resume）、`execution-message.ts`（ordinal 寻址）、console：`run-terminal-format.ts`（commandOf）/`canvas-results-panel.tsx`（stdin 行 ordinal）。

### 风险

- pin 与降级的产品冲突已按「显式 pin 禁降级」裁决（本 PRD 定稿），实现层不得再自行放宽/收紧；「显式」判定信号若后续加新声明位（如 flow 级 model），须回本 PRD 更新。
- 会话延续依赖适配器域（claude only v1）——降级路径的确定性承诺要诚实标注，不得暗示全适配器支持。
- 并发 iteration 的会话并存对 runNodeSinks 键结构 (runId:nodeId) 是破坏性扩展（需带 ordinal），与 R1 实例键同批。

### 负责方向

可恢复性

---

## R9 工程决策包（范围确认：三件全部采纳）

### 背景

R9 种子自述「以 PRD 摸底后细化范围为准」。三路摸底给出充分锚点，本 PRD 确认**三件全部采纳**，并补齐 UI 语义初稿（原「console 侧三者 UI 语义均未定义」）。

### 现状锚点

- **9a 挂起双轨制**：chat 流式路径纯内存 `pendingByChat`（`apps/gateway/src/routes/human-input.ts:1-18` 头注释已论证 in-memory 取舍：单进程网关 + 重启即死 + 超时收敛）；画布/answer 路径 checkpoint `awaiting_input` 持久 resolver「不持有任何内存 Promise（重启安全）」（`resume-execution.ts:137-145`）；红线论证素材 `execution-registry.ts:10-16`（「DB 是状态真相源，registry 只是控制通道」）。
- **9b 通知现状**：run 完成通知机制不存在（WS 仅 chat 域五事件 `ws-hub.ts:29-35`）；console 桌面通知/声音只认 `chat:done`/`chat:error`（`use-task-notification.ts:210-259`）；画布 run 纯轮询无推送——「claim」与「superseded 抑制」都没有承载面。claim 范式先例：`claimCheckpointRun`（`resume-execution.ts:185-198`，曾实弹逮出并发双 200）。
- **9c 诊断现状**：两级（errors=不可执行 / warnings=可疑）+ 节点定位 + 全量收集原则（`validate-topology.ts:12-13,171`「Warnings are collected even when errors are present」）；保存不阻断（`canvas-kit-page.tsx:746-749`）。第三档不存在。
- **9d 上限词汇散落**（req-runtime.md R9 表）：run 并发闸满载 429 拒绝（`run-gate.ts:60-77`）、CLI spawn 闸 FIFO 排队（`cli-spawn-gate.ts`）、迭代项上限 100 节点失败→run failed（`executor.ts:806-815`）、platformAgent maxIterations 软截断尾注（`platform-agent.node.ts:205-212`）、tokenBudget 独立终态 budget_exceeded（`executor.ts:562-568`）、子流程深度 throw 节点失败（`workflow-engine-service.ts:144-149`）、节点重试耗尽波次失败（`executor.ts:462-478`）。

### 需求描述

**9a 挂起/escalation registry 纯内存注释固化**
1. 将 `human-input.ts` 头注释与 `execution-registry.ts` 红线注释合并为单一权威论证段（「持久表只会说谎」：挂起态真相在进程里，表只能记意图；重启后承诺无法兑现，诚实失败优于假承诺），两处注释互引；「两机制并存」的边界判据（chat SSE 内存 promise vs 画布 checkpoint awaiting，何时用哪个）成文；ADR 落档 `docs/superpowers/specs/`（或 `docs/workflow-engine.md` 现状与限制一节）。

**9b run 完成通知去重 claim**
2. 前置：通知载体选型（WS hub 事件型 vs notification 表）列 OQ-2，本 PRD 定需求不定实现。需求：同 run 终态在多入口（画布旁观 + 聊天执行卡 + 多标签页）**至多一次**用户可见通知（toast/桌面/声音任一）；claim 语义 = 首 claim 者发、其余静默；`superseded` run 零通知（衔接 R3）。

**9c validateFlowTopology 诊断 withhold 分级**
3. 三级定稿：`error`（不可执行）/ `warning`（可疑）/ **`repairable`（可修复——带修复指引，不遮蔽其余诊断）**；分级进 `TopologyError`（severity 字段）；全量收集原则保持。**UI 语义初稿**：repairable = 节点标红 + 指引文案（不吓人性）+ 不阻断保存（现状原则）+ 运行前确认面提示；error = 现状。

**9d 上限失败语义两档 + 闸门词汇对齐**
4. 统一两档词汇：**节点拒绝**（该节点可重试、run 不整体翻红——行级黄警）vs **run 失败**（现有红态）。归类原则：资源型排队（CLI spawn 闸）等待不失败；声明型超限（迭代项上限、子流程深度、节点重试耗尽）= 节点拒绝档；预算型（tokenBudget）= run 级 budget_exceeded 终态；准入型（run 并发闸）= 429 拒新 run 不变。对照表（上限→档位→runs 终态→UI 呈现四列）落档 `docs/workflow-engine.md`；R4 白名单拒绝、R5 裁决失败按此表对齐词汇。

### 验收标准

- **AC-R9-1（文档）**：9a 权威论证段存在，`human-input.ts` 与 `resume-execution.ts` 注释互引，ADR 落档可被 code review 引用。
- **AC-R9-2（文档）**：9d 上限语义对照表落 `docs/workflow-engine.md`，覆盖现状全部七类上限。
- **AC-R9-3（并发单测，载体落地后）**：两入口看同一 run 终态仅一次通知；superseded run 零通知。
- **AC-R9-4（单测/UI）**：repairable 错误不遮蔽结构诊断（一次校验全量返回）；保存不阻断；节点级上限拒绝呈现为该节点可重试黄警、run 不整体翻红。
- **AC-R9-5（一致性）**：新词汇（节点拒绝/run 失败）在 R4 拒绝错误、R5 裁决失败、迭代超限三处实际输出的错误/状态一致可归类（对照表抽查断言）。

### 涉及面

`apps/gateway/src/routes/human-input.ts` + `execution-registry.ts`（注释）、通知载体（OQ-2 待选型）+ `use-task-notification.ts`、`packages/workflow/src/utils/validate-topology.ts`（severity）、console 标红/toast 分支、`docs/workflow-engine.md`。

### 风险

- 9b 完整验收依赖载体选型（OQ-2）——载体迟迟不落会拖 R3 superseded 抑制的终验；建议载体决策与 R3 同窗口。
- 9c/9d UI 语义是本 PRD 初稿，设计评审需确认点色/文案/阻断性细节。

### 负责方向

工程决策与试运行（R9 R10）

---

## R10 画布试运行

### 背景

Mock LLM Provider 是 e2e 专属独立进程（`apps/console/tests/e2e/fixtures/mock-llm-server/server.mjs`，零依赖 node:http，OpenAI 兼容面 + `/__control/*` 规则编排面，:4010 由 playwright webServer 拉起）；接入方式是 seed 直插 `llm_providers` 并**暂时禁用其他 active provider**（`apps/console/tests/e2e/helpers/seed.ts:344-378`，注释自认「直接改共享 dev 库」）——不可产品化。引擎无子图/单节点执行公有入口（`runWaves` scope 是私有参数 `executor.ts:506-519`，`planIterationBody` 子 DAG 提取算法已有但私有 `executor.ts:1066`）；runs 无试运行隔离标记（`RunExecutionInput.source` 是从不使用的死字段，`resume-execution.ts:168-170`）；画布只有单选（`flow-editor.tsx:108` selectedId 单值、`:396-398` onSelection 只取单选，`FlowEditorHandle :51-59` 无 selection 出口）。

### 现状锚点

- 指定 provider 执行通道已存在：`createLlmClient({ providerId, model })` override（`workflow-clients.ts:663-665`）——试运行可直连不动全局配置。
- `assembleWorkflowEngine` 单源装配（`workflow-engine-service.ts:108`）——试运行走同一引擎复用全部执行语义（含 R4/R5 新能力）。
- 拓扑校验客户端可调（保存干跑 `canvas-kit-page.tsx:749`）——试运行前置校验零成本。
- 两路摸底同向倾向 gateway 内置 fake llmClient（req-flowlang.md 跨领域问题 5「零部署、零计费污染」；req-runtime.md R10 缺口 1 列三选项）。

### 需求描述

1. **部署形态（定稿，吸收开放问题）**：**gateway 内置 fake llmClient**（代码级 mock 执行通道，`assembleWorkflowEngine` llmClient 注入位）——零部署、零计费污染（不写 usage_events）、不动 `llm_providers` 全局配置、桌面形态天然免端口编排耦合；规则脚本引擎沿用 e2e mock server 内核（谓词 systemContains/userContains/toolResultContains/modelIs、toolLoop、delay、流调速）。e2e 栈继续用独立进程 mock server（不迁移，避免 e2e 基建风险）。
2. **范围（定稿，P0/P1 分层）**：P0 = **单节点试运行**（复用现有单选 selectedId）+ **全图试运行**；**子图多选/框选 = P1**（`FlowEditorHandle` 需加 selection 出口，结构改造另批）。
3. **引擎入口**：子 DAG 提取复用 `planIterationBody` 闭包思想（引擎 scope 参数化公有入口）或 gateway 侧临时图裁剪（选中集包成临时 FlowData）——实现二选一，设计期裁决；试运行走同一引擎同栈呈现（节点徽章/结果面板三视图/旁观）。
4. **产物隔离与写入口径（定稿）**：复活 `RunExecutionInput.source` 死字段（或等价 runs 标记列）标 `'trial'`。**隔离面 = 展示与账单**（`listRunsHistory` where 过滤 `runs.repo.ts:146-181` 现成、FlowRunsPanel 不出现、用量账单不计、**不写 `usage_events`**）。**写入口径**：试运行**写 spans + journal**（同栈三视图/回放能力保留——试运行面板与旁观复用同一数据链，与 R7「有 journal 的 run」语义不割裂）、**不写 checkpoint**（无 resume 语义）；**retention 不豁免**试运行行（照常 90 天清理——「隔离」若意为不清理会导致高频试运行无限积累；更短 trial TTL 属后续优化不进 P0）。
5. **mock 规则可配 + 证据面板**：试运行面板配置节点级/全局脚本规则；试运行后可查每节点收到的 prompt（对齐 mockLlmCalls 证据价值——prompt 验证是核心场景）。
6. **customFunction 真实执行**（超时/异常如实呈现）；**http 节点试运行默认跳过**并标注「试运行不执行真实请求」（显式勾选才真发，真发时 SSRF/R4 守卫照常）。
7. **前置校验**：拓扑非法（选中子图含回边）拒并定位（复用 detectCycle）；prompt 模板解析错误（未解析占位符）在试运行即暴露。

### 验收标准

- **AC-R10-1（e2e）**：选中单 LLM 节点试运行 → mock 规则命中、面板见 scripted 输出与该节点收到的 prompt；真 provider 调用数 0、CLI spawn 计数 0（/metrics 或调用记录断言）。
- **AC-R10-2（e2e）**：customFunction 试运行真实执行（超时/异常如实呈现，不被 mock 短路）。
- **AC-R10-3（隔离断言，含写入口径）**：试运行不出现在 FlowRunsPanel 历史行、用量账单、`usage_events` 表（三处为零断言）；spans/journal **存在**该 runId 行且带 trial 标记（回放/三视图可用），并验证正式历史读面（`listRunsHistory`）可按标记过滤之；无 checkpoint 行产生。
- **AC-R10-4（e2e）**：试运行后正式 run 仍走原 active provider（全局配置零影响）。
- **AC-R10-5（e2e）**：http 节点默认跳过并标注；显式真发时 SSRF/R4 白名单守卫照常生效。
- **AC-R10-6（单测/e2e）**：选中子图/节点含回边或拓扑非法 → 拒绝并带定位（与保存校验同体验）。
- **AC-R10-7（e2e）**：prompt 模板未解析占位符在试运行面板即暴露（可计数、可定位）。

### 涉及面

`apps/gateway`：fake llmClient（注入位 `workflow-engine-service.ts:108`）+ 试运行路由（`runBodySchema` 扩展）+ runs 标记过滤；`packages/workflow`：子 DAG 入口或裁剪器；console：试运行入口（画布工具条/右键）+ 规则配置面板 + prompt 证据面板 + i18n；`FlowRunsPanel`/账单过滤。P1：`flow-editor.tsx` 多选。

### 风险

- 「内置 fake llmClient」放弃了 llm_providers CRUD 承接（用户不可见可配 provider 行）——若产品后续要「用户自配 mock provider 预设」，属 LLM Provider 域新需求（本 PRD 已裁边界）。
- 子 DAG 提取的入口边解析（选中集外部入边的输入来源）是正确性关键——P0 单节点场景同样要处理「上游输入从哪来」（建议：取最近一次 run 的对应节点输出或用户手填，实现期定稿并写入设计文档）。
- 单选试运行的输入种子若取最近 run 输出，与 R2 暖缓存的 (nodeId, inputHash) 查找可复用——两需求实现应对齐，避免两套前驱查找。

### 负责方向

工程决策与试运行

---

## 全局非功能要求

### NFR-1 存量兼容与迁移安全

- 所有 DB 迁移带 down 路径；存量行策略显式（ordinal 默认 0、无 hash 跳过校验、cancelled 行不迁移、无 seq/at 旧数据 sequence 投影降级保留——`canvas-trace-view.tsx:140-143` 现状降级不回归）。
- **词表收紧类迁移强制预检**：任何 CHECK/枚举收紧必须先对存量值做存在性预检（`SELECT DISTINCT` 对照目标词表）或采用 `NOT VALID` + 分批 `VALIDATE`——PostgreSQL `ADD CONSTRAINT ... CHECK` 默认 VALID 模式扫全表，目标词表若不含存量值、迁移直接失败。本 PRD 唯一词表变更（R3）已按双词表保留（新 CHECK 显式含 `cancelled`）处理。
- gateway 单测库 `dagents_gw_test` 迁移链自动建库保持通过（vitest globalSetup 纪律）；runs 大表 ALTER 避免长锁事务。
- 老数据渲染不回归是每个改词/改形状需求的显式 AC（见 AC-R1-5 / AC-R3-5）。

### NFR-2 不破坏现有 e2e

- 既有 e2e 全绿是每批交付前提；破坏性改名（cancelled→stopped）PR 必须同批更新 e2e 断言与 Mock Provider 脚本（AGENTS.md「e2e 残留清扫」教训）。
- 多项验收以 mock 调用记录为仪器：R10 产品化 mock 与 e2e mock 共用脚本引擎内核，排期 R10 基建先行（req-runtime.md 跨领域问题 8）。
- e2e 栈换网关端口必须同步 `GATEWAY_URL`（BFF 只认它）；dev gateway/console 在跑期间禁 `pnpm build` 与并发全仓 build/test（tsx watch 重启杀 run 的已知问题，见 AGENTS.md）。

### NFR-3 零新依赖优先

- 校验继续用 `json-schema-lite` 自研子集（R5 扩 expected/got 不引 ajv）；seq 分配用**进程内单写者计数器 + `(run_id, seq)` 唯一索引兜底**（R7 需求 1 定稿，非 DB 同事务取号——与 NFR-7 同口径），不引新组件；表单复用 form-engine 现有五类控件（R4/R5 编辑面零新组件）。
- 确需新依赖必须单列决策记录说明不可替代性（本 PRD 范围内预计零新依赖）。

### NFR-4 i18n 双语

- 全部新界面文案（stopped/已中断/cached/暖缓存/白名单确认/试运行/裁决轮次等）中文自然键 `t('中文')` + `apps/console/src/i18n/en/` 对应模块（flows.ts 等）补英文词条；`STATUS_LABEL` 等词表新词同步入词典——缺译回退中文是欠账不是豁免。
- 新 UI 一律 React 组件 + t()，不走原生 confirm（原生弹窗双语特例是历史模式，不复制）。

### NFR-5 UI 动刀窗口合并

- R2 cached 徽章、R3 stopped 标签、R6 渐进结果区三项 UI 变更同落 `canvas-results-panel.tsx` 与运行历史——**合并一批排期交付**，避免结果面板反复动刀；组件 CSS 就近 import，遵守孤儿 CSS 护栏（`apps/console/scripts/check-orphan-css.mjs` 挂 lint）。

### NFR-6 可观测与诚实原则（贯穿）

- 每个新机制在 `/metrics` 或过程流有可观测锚点：journal 命中/miss 计数、暖缓存命中数、pin 拒绝降级、会话重建降级、试运行调用数。
- 降级、miss、跳过、截断一律留痕不静默（与 2026-10-04 稳定性专项哲学一致；`DAGENTS_HTTP_ALLOW_PRIVATE` 式逃生门必须显式配置生效）。

### NFR-7 性能与资源约束

- journal/seq 写入不阻塞节点执行热路径：delta 帧走 span-writer 式异步串行链（`span-writer.ts:49-55`），调度不等落库；**例外**：低频结构帧（nodeStart/nodeEnd/runEnd）write-through 同步落库（R7 一致性模型的代价，频率与节点数同阶）。seq 正确性由 emit 单点分配 + `(run_id, seq)` 唯一索引兜底（非 DB 同事务取号，见 R7 需求 1）。
- events 全量落库后的存储增长依赖 retention 兜底，实现期必须给出单 run 保护性上限与拒收留痕语义（不得静默丢）。

---

## 开放问题

> 以下为摸底提出但无法在本 PRD 内合理定稿的事项——或属实现/设计域裁决，或需产品/域负责人终裁。已吸收进条目的（状态词表联动、pin 边界、NUDGE 预算、cached 契约、mock 形态、插话寻址、合并排期等）不再列此。

1. **OQ-1 journal 表结构选址（DB 迁移域）**：扩 `run_node_spans`（加 ordinal/input_hash/seq，唯一索引从 `(run_id, node_id)` 重建为 `(run_id, node_id, ordinal)`）vs 新表 `run_node_journal`。影响：迁移链与 gateway 单测库、retention 级联（`apps/gateway/src/retention.ts` 现按 runs→spans/checkpoints 级联）、console 消费键（一行多段 vs 多行——DB 路轨迹恒单段的现状 `run-trace-model.ts:47-48`，多行则摘要/终端合并/latestSpans 全链按复合键重键）。原则已定：R1 决策记录与 R7 事件流同一真相源、同事务原子；schema 边界与 R8 persona 冻结载体（OQ-6）一并由 DB 域设计裁决。
2. **OQ-2 run 终态通知载体选型（执行编排域）**：WS hub 事件型（`ws-hub.ts` 现仅 chat 域五事件）vs notification 表 vs 混合。R3 superseded 抑制终验与 R9b claim 完整验收都依赖它；需求已定（多入口至多一次、superseded 零通知），建议与 R3 同窗口决策。
3. **OQ-3 platformAgent CLI Bash 工具授权面**：R4 v1 已裁只覆盖 customFunction 受控通道与 http 域名清单；platformAgent `bypassPermissions` 之下的 Bash 工具授权（`--allowedTools` 旗标映射 agent-adapters 层）是否纳入后续迭代或另立需求——需权限域与适配器域共同裁决。
4. **OQ-4 R4 存量 http flow 放行策略终裁**：本 PRD 建议「模板中心与生成器产物全量补声明 + 用户存量过渡期警告放行（未声明 = 确认面黄警 + 放行），过渡期后 enforcement 默认开启」；过渡期长度与默认值（版本线 or 时间窗）需产品终裁——不裁则 fail-closed 会让存量全部被拒。
5. **OQ-5 chat 触发的工作流 run 是否纳入 R1 可恢复范围**：`@flow`（`chat-execute.ts:496-506`）与 chat 流式（`chats.ts:733-737`）均未接 onCheckpoint，永远不可 resume；chat 已有自己的挂起回流（`answerAwaitingRunForChat`）。纳入需两路径接 checkpoint 管线（成本另计）；本 PRD P0 不纳入，是否列入后续版本需范围终裁。
6. **OQ-6 R8 persona 冻结载体**：run 行快照列 vs checkpoint 载荷 vs journal 附表——随 OQ-1 schema 一并定。
7. **OQ-7 状态词表 `errored` 与 `failed` 并轨确认**：种子五态用 `errored`、末句又用 `failed 是终态`；本 PRD 定稿保留 `failed`（避免 cancelled→stopped 之外的第二处破坏性改名），错误来源分类由 `stop_reason ∈ {model, provider}` 承担。此并轨需种子提出方确认意图一致，若坚持 `errored` 改名则 R3 波及面再扩一档（console/e2e 全量二次同步）。

---

## 附：验收标准条数统计

R1：6 · R2：5 · R3：7 · R4：6 · R5：6 · R6：5 · R7：5 · R8：6 · R9：5 · R10：7 —— **合计 58 条**（全局非功能要求为约束条款，不计入 AC 编号体系）。
