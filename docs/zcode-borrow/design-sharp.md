# 设计文档 · 工程决策与试运行（R9 + R10）

> 负责需求：`docs/zcode-borrow/requirements.md` R9（工程决策包：9a 注释固化 / 9b 通知 claim / 9c 诊断分级 / 9d 上限两档）+ R10（画布试运行）。
> 锚点核验：本文全部 `path:line` 锚点均在 2026-10-07 工作区（分支 `feat/zcode-borrow`）本会话逐文件读源核验；PRD 转引锚点已抽读复核（`seed.ts:344-378` 等）。
> 撞车检查：`docs/zcode-borrow/` 下尚无其他 `design-*.md`（本方向首发）。与可恢复性方向（R1/R2/R3/R7/R8）的共享文件已在 §7 逐个标注「共享 barrel · 追加式」，并给出合并顺序约定。

---

## 0. 决策速览（一句话版）

| # | 决策 | 锚点 |
|---|---|---|
| D1 | 9a 纯内存红线固化为独立 ADR + 三处源码注释互引，不改任何行为 | §2.1 |
| D2 | 9b 通知载体 = 激活 `ws.ts:49` 预留的 `run-updated` 帧 + ws-hub 扩 runId 订阅维度；gateway 单点发射 claim（进程内 Set），console 跨标签页 BroadcastChannel leader claim | §2.2 |
| D3 | 9c `TopologyError` 加 `severity: 'error' \| 'repairable'`；「platformAgent 无 agentId」从 warning 升 repairable；新增「模板占位符引用未知名」repairable 静态扫描（与 R10 前置校验同源同函数） | §2.3 |
| D4 | 9d 新增 `NodeRejectedError` 错误分类；声明型超限（迭代项上限 / 子流程深度 / 重试耗尽）失败并入既有 isolateFailure 路径 → run 终态 `partial_success`（不整体翻红）；span 状态词表追加 `'rejected'`——契约（TS 词表）+ **`run_node_spans_status_chk` CHECK 放宽迁移**（`1720000007000:55-58` 现为五词 CHECK；一次放宽并入 `'rejected'`+R2 `'cached'`+recover boot sweep `'stopped'` 三词，本方向持有迁移、三方写方的共同前置） | §2.4 |
| D5 | R10 引擎入口 = **gateway 侧临时图裁剪器**（`buildTrialSubgraph` 纯函数，合成 start + `resume.seedRuntime` 预填外部上游输出），**引擎执行核心零改动**（有意避开 R1/R2/R7/R8 大本营 `executor.ts` 的调度区） | §3.3 |
| D6 | R10 mock = **代码级 fake llmClient**（`lib/trial-mock-llm.ts` 移植 e2e `server.mjs` 内核为纯 TS），经 `assembleWorkflowEngine` 新增注入位接入；不动 `llm_providers`、不写 `usage_events` | §3.2/§3.4 |
| D7 | R10 隔离标记 = **runs 加 `source` text 列**（`'canvas'|'chat'|'trial'|'resume'|'answer'`），同时把 `RunExecutionInput.source` 死字段接通为实写；读面 `listRunsHistory` 默认 `source IS DISTINCT FROM 'trial'` | §1.1 |
| D8 | R10 写入口径：写 runs（source='trial'）+ spans + live；**不写** checkpoint / usage_events / Langfuse；retention 不豁免；走 run 并发闸 | §3.5 |
| D9 | R10 单节点上游输入 = 两级回退：面板手填（默认值预填）← 最近一次正式 run 同 nodeId 输出；与 R2 前驱查找对齐（P0 简化版，R2 落地后共享其服务） | §3.3 |

---

## 1. 数据模型与迁移

### 1.1 `runs.source` 列（R10 隔离标记，兼清「来源」派生债）

**新迁移** `packages/db/src/migrations/1720000106000-add-runs-source.ts`（模板对齐 `1720000105000-flow-context-md.ts:10-19` 的 up/down 形制）：

- `up`：
  1. `ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "source" text`（nullable，不加 CHECK——词表无收紧必要，过滤只针对 `'trial'`；加 CHECK 会给未来新增来源制造 NFR-1 式预检负担）；
  2. 存量回填（一次性，幂等）：`UPDATE "runs" SET "source" = CASE WHEN chat_id IS NOT NULL THEN 'chat' ELSE 'canvas' END WHERE "source" IS NULL`——与读面现状派生逻辑 `runs.ts:75`（`r.chat_id ? 'chat' : 'canvas'`）逐字同义，迁移后读面派生退位；
  3. 部分索引：`CREATE INDEX IF NOT EXISTS idx_runs_source_trial ON "runs" ("created_at" DESC) WHERE "source" = 'trial'`——试运行历史显式查询（`?source=trial`）零全扫，正式历史过滤走 NOT 条件（大表上 `IS DISTINCT FROM` 不可索引，但该过滤与既有 `WHERE r.pipeline_id = …` 组合、行数与现状同阶，不新增代价）。
- `down`：`DROP INDEX IF EXISTS idx_runs_source_trial` + `ALTER TABLE "runs" DROP COLUMN IF EXISTS "source"`。

**实体**：`packages/db/src/entities/run.entity.ts` 在活跃列区（`:91-107` 一带）追加 `@Column({ name: 'source', type: 'text', nullable: true }) source!: string | null`——该实体本就落后于 raw SQL 迁移列（`resumed_from_run_id`/`directory_id` 亦未声明，`1720000096000-create-run-checkpoints.ts:40`、`1720000097000`），补声明是收敛不是特例。

**写侧接通**（复活死字段，PRD R10.4 字面要求）：`RunExecutionInput.source`（`apps/gateway/src/routes/resume-execution.ts:168-169`，现从不落库）→ 贯通到：

- `persistWorkflowRunRow` / `initAsyncWorkflowRunRow`（`apps/gateway/src/repositories/runs.repo.ts:213-259/261-282`）加可选 `source?: string` 参数，INSERT 列清单追加（`upsertChatWorkflowRunRow:285-319` 同步加，chat 路径写 `'chat'`）；
- 各执行路径实写：画布直跑（`workflows.ts` runAndPersist 内 `persistWorkflowRunRow` 调用点 `:576-588` 与 async 先行行 `:685-691`）写 `'canvas'`；resume/answer（`resume-execution.ts:259-277` persistRunRow 闭包）写 `req.source ?? 'resume'`；chat @flow（`upsertChatWorkflowRunRow`）写 `'chat'`；试运行（§3.4）写 `'trial'`。

**读侧**：`apps/gateway/src/routes/runs.ts:75` 的 `source` 字段改为 `r.source ?? (r.chat_id ? 'chat' : 'canvas')`（`listRunsHistory` SELECT 列清单 `runs.repo.ts:166-169` 加 `r.source`）；`listRunsHistory`（`runs.repo.ts:146-181`）加可选参数 `source?: string | { exclude: 'trial' }`——默认（不传）追加 `AND (r.source IS DISTINCT FROM 'trial' OR r.source IS NULL)`，显式 `source=trial` 时正向过滤。FlowRunsPanel（`flow-runs-panel.tsx:94` 拉 `/api/runs?flowId=`）**零改动**即不再出现试运行行（AC-R10-3 第一隔离面）。

### 1.2 R9 的唯一迁移：`run_node_spans.status` CHECK 放宽（9d）

9a 是注释/文档；9b 载体是进程内 registry + 既有 ws-hub；9c 是校验器结构字段（内存对象，不落库）——三者零 DDL。**9d 的 `'rejected'` 需要一次词表放宽迁移**：`run_node_spans.status` 建 Migration 即带 CHECK（`1720000007000-create-run-node-spans.ts:55-58`：`CHECK ("status" IN ('running','done','failed','paused','unknown'))`）——不放宽则 rejected span 的 upsert 被 CHECK 拒收、行悬空 running（正是 `1720000103000-widen-runs-status-chk.ts:8-9` 头注释记载过的实弹教训）。

**新迁移 `1720000106200-widen-run-node-spans-status-chk.ts`**（逐字对齐 `1720000103000:11-28` 的 drop + re-add 范式；**本迁移由本方向持有，是三个方向的共同前置——总架构师评审裁决**）：

- `up`：DROP `run_node_spans_status_chk` → re-add 词表 `('running','done','failed','paused','unknown','rejected','cached','stopped')`——**一次放宽到位三方向新词**：本方向 9d 的 `'rejected'`（§2.4）、可恢复性 R2 的 `'cached'`（R2 需求 3）、R1/R3 boot sweep 要写的 `'stopped'`（悬空 running span 收敛，design-recover §3.2②）。后两方向未落地前多出的词无写方、无害；三方向分三次放宽 = 三次全表扫描 + 三轮合并协调，一次到位是唯一正确解。
- `down`：恢复五词窄表（与 `1720000103000` down 同款语义：存量新词行存在时 down 会失败——down 是逃生门不是往返保证，仓库既有范式如此）。
- 词表是**放宽**非收紧（旧值全保留）：`ADD CONSTRAINT` 默认 VALID 模式扫全表必过，无 NFR-1 预检负担。
- **三方合入顺序硬约束（升格为共同前置）**：本迁移必须先于任一写方合入——design-recover 第 1 批（boot sweep 写 `'stopped'`）与第 4 批（R2 cached span 落库）、本设计第 5 步（9d `'rejected'` span 落库）。不满足则写库被 CHECK 拒收且 boot sweep 每步独立容错吞错、spans 永悬 running（`1720000103000:4-9` 头注释记载的实弹故障模式）。

### 1.3 与可恢复性方向迁移的合并顺序

R1 的实例键迁移（OQ-1，大概率重建 `run_node_spans` 唯一索引为 `(run_id, node_id, ordinal)`）与本设计的 `runs.source` 列、status CHECK 放宽互不相交；迁移号段错开（本设计占用 `1720000106000`（runs.source）与 `1720000106200`（spans CHECK 放宽），R1 从 `1720000107000+` 顺延即可）。R10 试运行写 spans 走既有 `span-writer`（`apps/gateway/src/span-writer.ts:189-221`），R1 改表后自动继承新键结构，零耦合。

---

## 2. R9 工程决策包设计

### 2.1 9a 挂起/escalation registry 纯内存注释固化（纯文档，行为零改动）

**新 ADR**：`docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md`（目录先例：`docs/superpowers/specs/` 已有 7 篇 ADR，ARCHITECTURE.md:124 指认该目录为架构决策记录位）。内容四段：

1. **「持久表只会说谎」论证**——合并两处现有素材：`apps/gateway/src/routes/human-input.ts:1-18` 头注释（「pending state is deliberately in-memory (single-process gateway, local mode): a gateway restart … fails the node with a clear error instead of hanging」）与 `apps/gateway/src/execution-registry.ts:10-16` 红线段（「In-memory Map, no Redis / pub-sub … DB stays the source of truth for STATE; this registry is only the CONTROL channel」）。核心命题：挂起态的真相是**进程内的 Promise/AbortController**；若把「挂起中」写进持久表，重启后表说「可继续」而兑现承诺的执行上下文已死——诚实失败优于假承诺。补偿机制（历史不说谎）：`markOrphanedHumanInputs`（`human-input.ts:71-86`）+ boot sweep（`apps/gateway/src/index.ts:142-146` 调用点）。
2. **两机制并存的边界判据表**（何时用哪个）：

   | 判据 | chat SSE 内存 promise（`pendingByChat`，`human-input.ts:44`） | 画布/answer 持久 checkpoint（`resume-execution.ts:102-113` awaiting + deadline） |
   |---|---|---|
   | 挂起的兑现者 | 用户下一条 chat 消息（同 SSE 连接续流） | `POST /runs/:id/resume` 或 chat 应答回流（新执行、新进程亦可） |
   | 重启语义 | 即死 + 会话补中断说明（`human-input.ts:71-86`） | checkpoint 落 `awaiting_input`，重启后仍可续（deadline 由 boot sweep 收敛，`index.ts:106-122`） |
   | 持有物 | 内存 Promise（**不持有任何持久化承诺**） | 「不持有任何内存 Promise（重启安全）」（`resume-execution.ts:137-145` makePersistentHumanInputResolver 注释） |
   | 选择规则 | 挂起与兑现都绑定**这条连接/这个会话进程**时 | 挂起需要**跨进程/跨时段**兑现时 |

3. **红线适用范围**：execution-registry（控制通道）、pendingByChat（挂起 promise）、run-live-registry（帧缓冲，重启即丢、404 诚实回退，`packages/contracts/src/run-live.ts:32-34`）同属此模型；任何「把可兑现承诺写进表」的提案须先驳倒本 ADR。
4. **修订记录位**：R1 落地后 boot sweep 语义变化（interrupted → stopped + checkpoint 收敛 resumable），ADR 追加一段而非改写结论。

**源码注释互引（AC-R9-1）**：三处改注释、零改代码——`human-input.ts:1-18` 头注释收编为精简论证 + 「完整论证见 docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md」；`execution-registry.ts:10-16` 红线段加同款互引；`resume-execution.ts:130-145`（持久 resolver 区块头）加「与 chat 内存挂起的边界判据见 ADR」。`docs/workflow-engine.md:105`（「HumanInput 的挂起状态在 gateway 内存里」条目）追加 ADR 链接。

### 2.2 9b run 完成通知去重 claim

**载体裁决（OQ-2 的本方向建议案，供执行编排域终裁）**：**WS hub 事件型**——激活 `packages/contracts/src/ws.ts:49` 预留的 `{ type: 'run-updated'; runId: string; status: string }` 变体（该文件 `:10-15` 明注「no producer exists yet … forward-compat」——契约形状已定稿三年内无人用，激活它比新造 notification 表便宜一个数量级：零新表、零清理生命周期、console 已有 `ws-client.ts` 单例与重连基建）。**若终裁改为 notification 表，本节 console 侧过滤与 claim 语义原样保留，仅 gateway 发射源换**（设计按 WS 展开并在 PR 里显式标注 OQ-2 状态）。

**契约变更（`packages/contracts/src/ws.ts`，共享 barrel · 追加式——R3 方向同文件加 stopReason 域）**：

- `run-updated` 变体扩为 `{ type: 'run-updated'; runId: string; flowId?: string; status: string; stopReason?: string }`——`stopReason` 字段与 R3 的 runEnd 帧 stopReason（R3 需求 5）同词表（`user/interrupted/superseded/model/provider`），R3 未落地时本方向只保证不发射 undefined 以外的值。
- 终态子事件约定：`status ∈ 终态词表` 即「run 完成」信号（复用 R3 定稿词表；R3 未落地前按现状终态 `completed/failed/cancelled/partial_success/budget_exceeded/awaiting_input`——`awaiting_input` 不算完成，不触发通知）。

**gateway 侧（新文件 `apps/gateway/src/lib/run-notify.ts`）**：

1. **发射单点** `notifyRunFinished(params: { runId, flowId?, status, stopReason? })`——内部进程内 `Set<runId>` 幂等（首发射即 claim，重复调用静默；run 重开同一 runId 不可能再终态，Set 无需清理——条目随进程生命周期，量级 = 每 run 一条，与 execution-registry 同款单进程取舍，互引 §2.1 ADR）。**superseded 抑制（衔接 R3）**：`stopReason === 'superseded'` 时直接 return，零发射（AC-R9-3 后半）。
2. **ws-hub 扩订阅维度**（`apps/gateway/src/ws-hub.ts`）：`ClientConn`（`:60-64`）加 `subscribedRuns: Set<string>`；握手 query 加 `?run=<id>`（`:118` 一带）；`subscribe`/`unsubscribe` 控制帧加 `runId` 分支（`:129-147`）；新增 `broadcastRun(runId, frame)`（对称 `broadcastChat:162-184`，按 `subscribedRuns` 定向）。Origin/token 防线（`:89-108`）不动。
3. **发射触点（三执行路径终态收口，各一行调用）**：画布直跑 `workflows.ts` runAndPersist 的 `live.finish(runStatus)` 之后（`:560-562`）；resume/answer `resume-execution.ts:331`；chat @flow 走既有 `chat:done`（`internal-runs-helpers.ts:71-82`）**不重复接**——chat 域通知已存在，run-updated 的发射范围 = 画布/直跑/resume 路径（chat 执行卡消费 chat:* 不变，避免双通知）。每触点传 `status` 与（R3 落地后）`stopReason`。
4. **claim 语义边界（诚实）**：进程内 Set = 单进程 claim；gateway 重启后 Set 清零，但重启意味着无新终态产生（run 已被 boot sweep 收敛、此后无二次发射请求），重启窗口不构成双通知面。

**console 侧（AC-R9-3 并发单测的另一半）**：

1. `apps/console/src/lib/ws-client.ts` 加 `subscribeRun(runId)` / `unsubscribeRun(runId)`——复制 `subscribeChat/unsubscribeChat` 的 refcount 模式（`:188-212`），重连 re-arm 循环（`:147-149`）同步覆盖 runs 集合。
2. `apps/console/src/lib/use-task-notification.ts`（`:210-262` notifyOnFrame 只认 `chat:done/chat:error`）扩 `run-updated`：终态 status 触发「工作流运行完成/失败」通知链；**superseded 过滤**（帧带 `stopReason==='superseded'` 直接 return——AC-R3-6 最小实现的双路径之一）。
3. **跨标签页 claim（至多一次的最后一公里）**：新 `apps/console/src/lib/run-notify-claim.ts`——`BroadcastChannel('dagents:run-notify')` 上 per-runId 首个 claim 者发通知、其余标签页静默（claim 消息竞态的兜底：Notification `tag`（`use-task-notification.ts:238` 已用 `'dagents-task-done'`）保证 OS 层同 run 至多一条可见）。刷新/单标签页场景 BroadcastChannel 无对手，claim 恒成功——行为与现状单发一致。

**分步与 R3 对齐**：本设计 9b 完整验收（AC-R9-3）依赖 R3 的 stopReason 落库；**最小阶段**（帧 stopReason 未落库前）= run-updated 激活 + console 过滤逻辑就位但 superseded 分支实际不触发（R3 AC-R3-6 最小阶段的组件测先钉过滤函数）。

### 2.3 9c validateFlowTopology 诊断 withhold 分级

**结构变更**（`packages/workflow/src/utils/validate-topology.ts`，共享 barrel · 追加式——R4 方向将同文件加白名单声明规则）：

- `TopologyError`（`:19-25`）加可选字段 `severity?: 'error' | 'repairable'`（缺省 = `'error'`，存量消费方零破坏）；新增 `repair` 字段：`repair?: string`（修复指引一句话，repairable 必带）。
- `TopologyResult` ok 分支不变；error 分支的 errors 数组可含 severity 混合——**error 档存在时 `ok:false` 不变**（不可执行判决只看 error 档），repairable 不改变 ok 性（这就是「不阻断保存」的类型层表达）。
- **全量收集原则保持**（`:171-172` 头注释「Warnings are collected even when errors are present」）：repairable 与 error 同数组返回，绝不互斥遮蔽（AC-R9-4 前半）。

**规则落位（v1 两条 repairable，其余档位不动）**：

1. 「platformAgent 无 agentId」从 warning **升 repairable**（`:239-248` 现为 warning「will fail when executed」）：运行必失败但可一键修复——`repair: '在右侧 Inspector 为该节点选择一个 Agent'`。升级理由：warning（可疑）低估了「必失败」，error（不可执行）又会阻断草稿保存——repairable 正好。
2. **新规则「模板占位符引用未知名」**（repairable）：扫描全部节点 prompt/systemPrompt 类字符串字段中 `{{…}}` 引用，引用键（剥 `{{id.field}}` 的 id 段）∉ `{节点 id 集} ∪ {'start','$start','flow','iterationItem','iterationIndex','iterationCount','iteration' 等引擎已知键}` → repairable + 定位 node + `repair: '变量 {x} 不指向任何节点——检查拼写或补上游节点'`。**已知误报面诚实标注**：正文字面量 `{{…}}` 会误报（引擎运行时同款启发式，`llm.node.ts:316-319` 只计数不判失败）——静态扫描同样只报 repairable 不报 error，两层（静态提示 + R10 试运行动态实证，§3.6）口径一致。

**消费方**：gateway 保存/生成入口（`workflows.ts` 保存校验、`flow-generator.ts` validate 收口）透传新字段（响应体加 `severity/repair` 原样透传，不改判定逻辑）；console `canvas-kit-page.tsx:744-767` 保存校验分支——repairable 节点走既有 `applyRunStates` 标红管线（`:758-767`）同款定位体验，错误条文案换「不吓人」话术（t('可修复：{repair}')），保存不阻断（现状 `:746-749` 已不阻断，零逻辑改动）；运行输入面板（`:951-1057`）顶部若有 repairable 残留则黄警行提示（运行前确认面，PRD 9c UI 初稿）。

### 2.4 9d 上限失败语义两档 + 闸门词汇对齐

**核心机制：错误分类标记，复用失败分支隔离管道。**

1. **新错误类型 `NodeRejectedError`**（`packages/workflow/src/engine/errors.ts` 新文件，或挂 executor.ts 顶部导出）：`class NodeRejectedError extends Error { readonly nodeRejected = true }`。语义 = **节点在开始实质执行前被声明/配置层拒绝**（该节点可调整后重试，不属于执行崩溃）。
2. **三个既有上限点改抛 NodeRejectedError**（消息文案不变，只换类型）：
   - 迭代项上限：`executor.ts:807-815`（`MAX_ITERATION_ITEMS = 100` 拒绝分支）；
   - 子流程深度：`workflow-engine-service.ts:144-149`（`子流程嵌套超过 3 层上限` throw）——gateway 侧 throw 的错误穿越 `flowExecutor` 到引擎 catch，分类标记随错误对象走，无需引擎感知 gateway；
   - 节点重试耗尽：`executor.ts:462-478` 重试循环——**仅在声明了 `retries ≥ 1` 且耗尽时**包装为 NodeRejectedError（cause 挂原始错误）；`retries=0`（缺省）保持原错误直抛（**run failed 红态语义原样保留**——未购买自愈预算的失败仍是执行失败，PRD 9d 的「节点重试耗尽归节点拒绝档」按「声明型预算耗尽」实现，缺省零行为变化，RM-01 e2e「失败→resume 零重跑」`24-run-resume.spec.ts:34` 场景不受波及）。
3. **runWaves catch 分类**（`executor.ts:633-667`）：catch 分支先判 `err instanceof NodeRejectedError` → `isolated` 视为 `true`（`return { kind: 'failed', nodeId, error: message, isolated: true, rejected: true }`）——**不读节点 isolateFailure 声明、由错误类型决定**；其后 `:685-697` 的既有管道自动把 rejected 失败并入 `ctx.isolatedFailures` 记账（`:689-693`）→ run 终态走 `partial_success`（`:322-333`）——**「run 不整体翻红」的机制实现：零新终态词、零新结算路径**（R3 词表不动，复用 2026-10-04 失败分支隔离全套）。
4. **span 状态契约**：`IExecutedNode.status` 增 `'rejected'`；span 落库 `apps/gateway/src/routes/workflows.ts:619-628` 的批量补写映射 + `span-writer.ts` onNodeEnd 的 `en.status === 'failed' ? 'failed' : 'done'`（`:217` 一带）加 rejected 分支；`NodeSpanStatus`（`packages/db/src/entities/run-node-span.entity.ts:32-40`）与 run-live `nodeEnd.status`（`packages/contracts/src/run-live.ts:63`）各追加 `'rejected'`——**与 R2 方向追加 `'cached'`、R1/R3 方向追加 `'stopped'` 是同两个文件同一位点，TS 契约三方合并进同一个 PR 一次改齐**；**DB 侧 `run_node_spans_status_chk` CHECK 放宽迁移见 §1.2**（词表一次性并入 `'rejected'` + `'cached'` + `'stopped'` 三词）。`toNodeSpanStatus`（`runs.repo.ts:35-56`）加 `'rejected' → 'rejected'` 映射。
5. **对照表（AC-R9-2，落 `docs/workflow-engine.md`「现状与限制」前新增一节「上限与失败语义对照表」）**——七类上限四列定稿：

   | 上限 | 档位 | runs 终态 | UI 呈现 |
   |---|---|---|---|
   | run 并发闸（`run-gate.ts:60-77`） | 准入型 | —（run 不创建，429） | 启动失败 toast（现状 `canvas-kit-page.tsx:491-496`） |
   | CLI spawn 闸（`cli-spawn-gate.ts:57-76`） | 资源型排队 | —（等待不失败） | 无新增（排队静默 + >5s warn 日志现状） |
   | 迭代项上限 100（`executor.ts:807-815`） | **节点拒绝** | `partial_success` | 节点黄警徽章「已拒绝（可重试）」+ error 带缩小列表指引 |
   | 子流程深度 3（`workflow-engine-service.ts:144-149`） | **节点拒绝** | `partial_success` | 同上（指引 = 减少嵌套） |
   | 节点重试耗尽（`executor.ts:462-478`，声明 retries≥1） | **节点拒绝** | `partial_success` | 同上（指引 = 检查该节点后重跑） |
   | platformAgent maxIterations 软截断（`platform-agent.node.ts:205-212`） | 软截断（第三小类，非失败） | `completed`（现状） | 尾注文本照流（现状） |
   | tokenBudget（`executor.ts:562-568`） | 预算型 | `budget_exceeded`（现状） | 现状红态 + 对账数字 |
6. **console 呈现**：`canvas-kit-page.tsx` 的 SPAN_STATUS_MAP 徽章 + `canvas-results-panel` 行状态加 rejected 态（黄色「已拒绝（可重试）」徽章——i18n 独立键，见 §4.7；+ 可重试提示行）；`flow-runs-panel.tsx` 无新增（partial_success 行已有「部分成功」标签 `:43-53`）。**词汇一致性（AC-R9-5）**：R4 白名单拒绝、R5 裁决失败落地时按本表「节点拒绝」档输出——即 R4/R5 的拒绝错误同样抛/标 NodeRejectedError 语义（三处错误文案首词统一「节点被拒绝：」，对照表抽查断言锚定此前缀）。

---

## 3. R10 画布试运行设计

### 3.1 范围与部署形态（PRD 已定稿，本节落锚点）

- **fake llmClient 代码级注入**（PRD R10.1 定稿）：不做 `llm_providers` 行、不做独立进程——桌面形态零端口编排耦合（req-runtime.md 跨领域问题 5 的裁决）。
- **P0 = 单节点（复用单选 selectedId）+ 全图**；子图多选/框选 = P1（`flow-editor.tsx:108` 单值 selectedId、`FlowEditorHandle :51-59` 无 selection 出口——P0 仅需加一个 getter，见 §4）。
- **e2e 栈不迁移**：`:4010` mock server（`server.mjs`）与产品 fake 是**同一脚本引擎内核的两份宿主**（内核纯函数共享源码级移植，见 §3.4——不共享运行时进程，避免 e2e 基建风险，PRD R10.1 明文）。

### 3.2 契约变更（@dagents/contracts）

**新文件 `packages/contracts/src/trial-run.ts`**（gateway/console 双端单一事实源，先例 `run-live.ts:1-9` 同款立项理由）：

```ts
// 脚本规则（与 e2e server.mjs:20-27 的 Rule/Script 形状逐字段对齐，谓词集不变）
export type TrialMockRule = {
  match?: Record<string, unknown>   // systemContains/userContains/toolResultContains/messagesContain/hasToolResult/assistantContains/modelIs
  label?: string
  respond?: { mode?: 'ok'|'error'|'malformed'|'empty'|'toolLoop'; text?: string; toolCalls?: unknown[]; usage?: unknown; delayMs?: number; streamChunkSize?: number; streamIntervalMs?: number }
}
export type TrialMockScript = { rules: TrialMockRule[]; fallback?: TrialMockRule['respond'] }
// 请求体：POST /api/v1/workflows/:id/trial
export type TrialRunRequest = {
  input?: string
  scope?: { nodeIds: string[] }                  // 缺省 = 全图；P0 单值/全图，P1 多值
  mockScript?: TrialMockScript | { byNode?: Record<string, TrialMockScript>; default?: TrialMockScript }
  httpMode?: 'skip' | 'real'                     // 缺省 skip
  seedInputs?: Record<string, string>            // 外部上游节点输出手填（§3.3 两级回退的用户侧）
  humanInputs?: Record<string, string>           // 试运行预供答案（与直跑 state.humanInputs 同契约）
  directoryId?: string                           // customFunction 的项目语境（可选）
}
// 证据端点响应：GET /api/v1/runs/:runId/trial-calls
export type TrialMockCall = { seq: number; nodeId?: string; model?: string; messages: unknown[]; matchedRule?: string; unresolvedPlaceholders?: string[]; ts: string }
```

**既有契约追加（共享 barrel）**：`run-live.ts:63` nodeEnd.status 增 `'rejected'`（§2.4，与 R2 `'cached'` 同批）；`ws.ts` run-updated（§2.2）；**barrel 挂载**——`packages/contracts/src/index.ts`（`:1-6` 现六行 `export *`）追加 `export * from './trial-run.js'`，console BFF/面板从 `@dagents/contracts` 根导入，不走深路径（与 R6 的 run-deliverables 同文件追加，无冲突）。试运行帧流复用 RunLiveFrame 全形状（`?run=` 旁观零改动——试运行 runId 进 run-live registry 同栈直播/回放）。

### 3.3 引擎入口：gateway 侧临时图裁剪器（设计期裁决 D5）

**裁决：不做引擎 scope 参数公有化，做纯函数裁剪器。** 理由：

1. `runWaves` 的 `scope/entryEdges` 私有参数（`executor.ts:506-519`）承载迭代体特化语义（entry edges 经 seed 伪输出解析、`:578-583`）——公有化需为「任意选中集」重定义入口边语义，等于把迭代体机制泛化成第二套调度入口，正确性面大；
2. `executor.ts` 是 R1/R2/R7/R8 四个需求的大本营（种子前置查询/journal/seq/会话铸造全在此动刀）——本方向再往调度区加公有 API 是撞车放大器；
3. 裁剪器 + `resume.seedRuntime`（`executor.ts:98-106` 已支持 runtime 预填充，`:248-250` 合并进 state）可以**零引擎改动**表达全部试运行语义。

**新纯函数 `packages/workflow/src/utils/trial-subgraph.ts`**：`buildTrialSubgraph(flow: FlowData, scope: { nodeIds: string[] } | null): { flowData: FlowData; externalUpstreams: string[] }`

- 全图（scope=null）：原样返回，`externalUpstreams=[]`。
- 选中集非空：取选中节点 + **两端都在选中集内的边**；选中集不含 `startAgentflow` 节点时**合成虚拟 start**（id `'__trial_start'`，data.name='startAgentflow'，输出 = 试运行 input），从虚拟 start 向选中集内「无入边节点」各连一条边；选中集含 start 时用原 start（其余选中节点若无入边，`runWaves:576` 的 `isStartNode`（入边数为 0 即视为可执行起点）自然放行——**「选中即显式执行意图」语义，文档化**）。
- `externalUpstreams` = 选中节点的入边 source 不在选中集内的去重 source id 列表（→ console 据此渲染种子输入区，§4）。
- **环免检论证**：裁剪图边集 ⊆ 原图边集，原图已过 `validateFlowTopology` 环检测（`validate-topology.ts:118-164` detectCycle）；**但试运行前置仍对裁剪图跑一遍完整 `validateFlowTopology`**（防未保存的草稿图、防手改 JSON 未过保存门的图——AC-R10-6「与保存校验同体验」：错误带 node 定位、console 走同款标红管线）。
- **上游输入两级回退（D9，PRD R10 风险点的实现期定稿）**：执行时 `resume: { seedOutputs: {}, seedRuntime: Object.fromEntries(externalUpstreams.map(id => [id, { content: seed, output: { content: seed } }])) }`——外部上游节点的输出以 `seedRuntime` 顶层键注入（模板 `{{upstreamId.xxx}}` 与 `{{upstreamId.output.xxx}}` 双形态对齐引擎注册约定 `executor.ts:614-619`）。种子值来源：① `TrialRunRequest.seedInputs` 手填（面板预填默认值 = ②）；② 默认值 = 最近一次同 flow 正式 run 的该节点 span output（console 经 `GET /runs/:runId/node-spans` 反查——数据源即 `getRunNodeSpans`，`runs.repo.ts:59-68`）。**与 R2 对齐声明**：这是「按 nodeId 取最近 run」的 P0 简化（试运行是人工验证场景，用户可目检种子值）；R2 的 `(nodeId, inputHash)` 暖缓存查找落地后，本查找替换为复用 R2 前驱查找服务，避免两套谱系查询——在两方向的设计文档间已互认此对齐点。**谱系链遍历单源（评审核验补充）**：R2 暖缓存与 R6 产出清单各自沿 `resumed_from_run_id` 递归溯源（深度护栏 32/10 不一致）——共享 lineage helper 抽出后（统一深度上限与 retention 断链诚实 miss 语义），本方向的「最近同 flow run」查找同样收编进该 helper，不另起第三套链遍历。
- **iteration 语义**：选中集含 iteration 控制器 → `planIterationBody`（`executor.ts:1066-1100`）的闭包提取自动以裁剪图为 scope，body 只含选中集内可达部分；items 上限 100（`:807-815`）与 9d rejected 语义照常生效——试运行同样是上限行为的验证场。

### 3.4 gateway 改动

**① fake llmClient 内核：新文件 `apps/gateway/src/lib/trial-mock-llm.ts`**

- 移植 `server.mjs:36-95` 的 `matches`/`resolveResponse` 为纯 TS 函数（谓词集、未知谓词不命中快速失败、toolLoop 模式逐字保留）；`completionBody`（`:98-121`）形态逻辑并入 client。
- `createTrialLlmClient(script: TrialMockScript | { byNode; default }, recorder)`：返回与 `HttpLlmClient` 同形（`workflow-clients.ts:643-660` 接口）的 `{ chat, chatStream }`——`chat` 按 `params.nodeId` 选 byNode script（无则 default，再无则空规则=恒 fallback），应用 delayMs/错误注入（error/malformed/empty 模式），usage 默认 `{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }`（server.mjs:27 同款——**假 usage 会进 span tokens**，诚实标注：span tokens 反映 mock 值但不入 `usage_events` 账单（§3.5 隔离），面板显示「mock 用量」）；`chatStream` 按 streamChunkSize/intervalMs 切片 yield（`server.mjs:124-164` 逻辑），供末节点流式路径。
- **调用记录 recorder**：进程内 `Map<runId, TrialMockCall[]>`（新文件 `apps/gateway/src/lib/trial-registry.ts` 或并入本文件）：每次 chat 记录 `{ seq, nodeId, model, messages, matchedRule, unresolvedPlaceholders, ts }`——`unresolvedPlaceholders` 在 client 侧对最终 messages 复扫 `{{…}}`（与 `llm.node.ts:316-319` 同启发式）——**AC-R10-7 的动态实证层**。TTL 清理：run 终态后 10 分钟定时清（对齐 shell 孤儿回收的取舍模式）；gateway 重启即丢——诚实边界：持久层是 spans（input/output 已落库 `span-writer.ts:189-221`），trial-calls 端点 404 时证据面板回退 spans 投影（§4）。

**② 装配注入位：`workflow-engine-service.ts`**

- `AssembleWorkflowEngineOptions`（`:52-68`）追加 `llmClientOverride?: AssembledWorkflowEngine['baseOptions']['llmClient']`——`assembleWorkflowEngine` 内 `:108` 改为 `const llmClient = opts.llmClientOverride ?? createDefaultLlmClient('claude', {…})`（`resetProviderCache()` `:104-105` 保留原位，fake 注入时无害空转）。**追加式可选参数，其他三入口零改动**。
- `ExecuteOptions`/`IExecutionContext` 加 `trialMode?: { http: 'skip' | 'real' }`（`packages/workflow/src/types/execution.ts:134-` 接口追加可选字段；`executor.ts:393-427` buildNodeContext 透传一行）。

**③ http 节点试运行跳过：`packages/workflow/src/nodes/http/http.node.ts`**

- **插入定序（与 R4 域名守卫同缝，总架构师评审裁决写死）**：执行顺序 = 协议白名单（`:74-82`）→ SSRF（`:86`）→ **R4 域名声明守卫（R4 落地后插此位）→ trialMode skip 分支** → fetch（`:123`）。即 skip 分支在**全部静态校验之后、fetch 之前**——**skip 路径同样先过声明校验再短路**：试运行是验证场，declared-but-violated 的静态配置错误（URL 协议非法/私网目标/域名未声明）必须在试运行中原样暴露（守卫在 fetch 前抛、零网络副作用），skip 只对通过静态校验的请求生效；被守卫拒绝的错误照常走 9d 节点失败呈现，不被 skip 吞掉。
- skip 分支行为：`options.trialMode?.http === 'skip'` → 不发请求，返回 `{ output: { content: '[试运行] 未执行真实请求（url=…）——勾选「真实发送请求」后重试', trialSkipped: true }`。标记文本流入下游 prompt（LLM mock 能看到——诚实且可断言）；span output 呈现标注（AC-R10-5 前半）。真发路径（`httpMode:'real'`）SSRF/重定向逐跳复检/R4 守卫零变化照常生效（`:74-86`、`:120-144`）。

**④ 试运行路由：新文件 `apps/gateway/src/routes/workflow-trial.ts`**

- `POST /workflows/:id/trial`（async 恒一，`workflows.ts:367-704` 直跑的姊妹编排，但写入口径按 §3.5 裁剪）：zod `trialRunBodySchema`（按 §3.2 TrialRunRequest 形状）→ 读 flow → `buildTrialSubgraph` → `validateFlowTopology`（拒则 422 带 node 定位）→ run-gate 取槽（满载 429 同款——试运行占真执行资源：customFunction 真跑）→ `assembleWorkflowEngine({ llmClientOverride: createTrialLlmClient(...), ... })` → `executionRegistry.register`（可取消，cancel 端点 `execution-cancel.ts` 按 runId 天然覆盖）→ 后台执行：
  - runs 行：`initAsyncWorkflowRunRow` + 终态 `persistWorkflowRunRow`，**`source:'trial'`**，`inputJson = JSON.stringify({ input, trialScope: nodeIds, httpMode })`（`{input}` 内层形状兼容 `extractInputPreview`，`runs.ts:28-35`）；
  - spans/live：`baseOptions` 的 onNodeStart/End/Delta 原样（span-writer + run-live registry 同栈——AC-R10-3「spans 存在且三视图/回放可用」）；
  - **不接 `onCheckpoint`**（不写 checkpoint 行——无 resume 语义，AC-R10-3 末项）；**不调 `recordUsageEvent`**（零 usage_events 行）；**不导 Langfuse**（`isLangfuseConfigured()` 分支跳过——试运行不污染观测 trace，与「不动全局配置」同精神，PRD 未点名、本设计补裁）；
  - `humanInputResolver = makePersistentHumanInputResolver(req.humanInputs ?? {})`——HumanInput 命中预供答案即答，未预供则 awaiting（试运行 awaiting 的诚实呈现 =「试运行不支持挂起，请预供答案」提示，checkpoint 不落、boot sweep 5min 后收敛——与直跑 awaiting 收敛路径 `index.ts:106-122` 一致，无特殊分支）。
- `GET /runs/:runId/trial-calls`：从 trial-registry 读调用记录（404 = 重启丢失/非试运行，诚实回退约定见 ①）。
- 路由挂载：`apps/gateway/src/app.ts` 的 `app.route(...)` 注册区（`:148-300`）追加一行 `app.route('/api/v1/workflows', workflowTrialRoutes)`——对齐 `/api/v1/workflows` 前缀既有五连挂（`:233/234/236/238/248`）；该文件同时承载 Origin 防线中间件（`app.ts:94-98`）与鉴权，新路由天然继承（勘误：初稿误写 `routes/index.ts`，该文件不存在——本次 `ls apps/gateway/src/routes/` + `grep -n "app.route" app.ts` 核验修正）。

**⑤ metrics（NFR-6）**：`declareCounter('dagents_trial_runs_total')` + `dagents_trial_mock_calls_total`（按 matchedRule 是否命中分 label）——试运行量与 mock 命中率可观测。

### 3.5 隔离与写入口径汇总（PRD R10.4 定稿的落地面）

| 面 | 口径 | 实现锚点 |
|---|---|---|
| FlowRunsPanel 历史 | 不出现 | `listRunsHistory` 默认过滤（§1.1）|
| 用量账单 | 不计 | 不写 `usage_events`（usage.ts:24-27 三 source 词表不动，trial 不入）；`usage-summary` 天然零行 |
| spans + journal | **写**（三视图/回放可用） | span-writer 原样；R1 journal 落地后随 runId 自动同栈 |
| checkpoint | **不写** | 路由不传 onCheckpoint |
| retention | 不豁免（90 天同款） | `retention.ts:42-59` 按 runs 级联，零改动 |
| Langfuse | 不导 | 试运行分支跳过 `:655-677` 段 |
| run 并发闸 | 走闸（429 同款） | 路由内 `tryAcquireRunSlot()` |
| 全局 provider 配置 | 零触碰 | llmClientOverride 不经 `llm_providers`、不动 active 行（AC-R10-4：试运行后正式 run 仍走原 active provider——`createDefaultLlmClient` 每次实时读库，天然满足）|

### 3.6 前置校验（AC-R10-6 / AC-R10-7）

1. **拓扑**：客户端（保存同款干跑 `canvas-kit-page.tsx:749` 的 `validateFlowTopology` import）+ 服务端（trial 路由内再跑一遍）双层；错误带 node 定位，console 复用标红管线——「与保存校验同体验」。
2. **占位符**：静态层 = §2.3 新 repairable 规则（保存时提示）；动态层 = fake client 对 messages 复扫的 `unresolvedPlaceholders` 记录（证据面板可计数、可定位到节点与原文）。

---

## 4. console 改动

1. **选中出口（P0 最小）**：`FlowEditorHandle`（`flow-editor.tsx:51-59`）加 `getSelectedNodeId(): string | null`（useImperativeHandle 追加导出 selectedId 态，`:108`）——页面据此把「试运行」按钮文案切换为「试运行此节点」并把 `scope.nodeIds=[id]`。P1 多选再加 `selectionOnChange` 多值出口与 RF `multiSelectionKeyCode/selectionOnDrag` props（现均未设，grep 零命中）。
2. **试运行面板**：新组件 `apps/console/src/components/canvas/trial-run-panel.tsx` + 就近 `trial-run-panel.css`（**样式就近 import，遵守孤儿 CSS 护栏** `apps/console/scripts/check-orphan-css.mjs`）：mock 规则编辑（rules 列表：match 谓词键值 + respond 文本/模式，表单复用 form-engine 现有控件形态，NFR-3 零新组件库）；外部上游种子输入区（行 = `externalUpstreams`，默认值预填最近 run 输出，§3.3）；http 勾选「真实发送请求」（默认跳过，黄警提示）；预供 humanInputs（可选）；启动 = `POST /api/workflows/:id/trial`。
3. **入口**：`canvas-kit-page.tsx` 画布 header 工具区加「⚡ 试运行」按钮（与「▶ 运行」并列，`unsavedMessage` 原生 confirm 特例 `:52-56` 不复制——按钮直接开面板，未保存草稿提示走 React 内联条）。
4. **执行与旁观复用**：试运行启动后 `setWatch({ runId })` 接管既有 watchLoop/结果面板三视图/轨迹——**零新执行编排**；结果面板顶部常驻「⚡ 试运行」标记条（数据源 `runs.source`——node-spans 响应或 run 状态端点透传，`getRunStatusAndDuration` `runs.repo.ts:72-81` 加 source 列）。
5. **证据面板**：结果面板摘要视图内 per-LLM/Agent 节点行展开「收到的 prompt」（主源 = span.input，`span-writer.ts` 已持久——重启不丢）+「mock 命中」（辅源 = `/api/runs/:runId/trial-calls`，404 回退标注「进程内证据已随网关重启丢失，spans 仍可查」）。
6. **BFF**：`apps/console/src/app/api/workflows/[id]/trial/route.ts` + `apps/console/src/app/api/runs/[runId]/trial-calls/route.ts`——薄代理（对齐 `api/runs/route.ts` 形制）。
7. **i18n（NFR-4）**：全部新文案中文自然键 `t('…')` + `apps/console/src/i18n/en/flows.ts` 追加英文词条（试运行/规则/证据/可重试/未执行真实请求等约 20 条）。**既有键冲突规避（评审核验）**：settings.ts:288 已有 `'已拒绝': 'Denied'`（通知权限域），且词典是六模块 spread 全局合并、settings 后于 flows 展开同名键静默压过（`en/index.ts:13-20`）——rejected 徽章文案用**独立键 `'已拒绝（可重试）'`**（英文 `'Rejected (retryable)'`），与权限域「已拒绝」语义不同不共用；同文件重复键是 TS 编译错、跨文件同名键是静默覆盖，新增词条前先 grep 两道词典。

---

## 5. 兼容与存量 run 数据策略

- **`runs.source` 迁移**（§1.1）：nullable + 一次性回填 + 读侧 `COALESCE` 双保险——迁移前后的 gateway/console 混跑窗口内，旧代码不写 source（NULL）→ 读面派生兜底；新代码读过期行 → 回填值。down 路径完整（NFR-1）。
- **span `'rejected'` 词表**：`run_node_spans.status` 有 DB CHECK（`1720000007000:55-58`），§1.2 的放宽迁移与写方同批合入（顺序：迁移先行，写方随后——`1720000103000:8-9` 的实弹教训是不放宽则终态 upsert 被拒收）；旧 console 读到 rejected 走 `SPAN_STATUS_MAP` 未知分支（现有 unknown 兜底）——不炸；新 console 读旧数据零接触（老 span 无该值）。
- **`TopologyError.severity`**：可选字段缺省 error，gateway 响应体透传新字段、旧 console 忽略未知键——前后端可独立发版。
- **ws `run-updated`**：契约文件本就声明该变体（`ws.ts:47-50`），旧客户端「ignore unknown types」是既有纪律（`ws.ts:7-8`、`ws-client.ts:226-227` parseFrame 透传）——激活 producer 零破坏。
- **试运行对存量的零侵入**：不写 checkpoint/usage/Langfuse → 存量查询面（账单/resume 列表）结构不变；`listRunsHistory` 默认过滤 trial 后，**存量用户视角的历史列表内容与今天完全一致**（trial 行是新增行、不混排）。
- **9d 行为变更面诚实清单**：迭代超限/子流程超深/retries≥1 耗尽三类失败 run 终态从 `failed` 变 `partial_success`——既有 e2e 若断言这三类场景的 runs.status=failed 需同批更新（扫描 `apps/console/tests/e2e/` 现无此三类断言场景——10-workflow-engine.spec/24-run-resume.spec 主断言为节点失败与 resume 零重跑，`retries` 缺省 0 不触发改档；实现 PR 须全量跑绿确认，NFR-2）。resume 能力不受影响（`failed`/`partial_success` 均落 `resumable`，R3 需求 4）。
- **e2e 栈零迁移**（NFR-2）：`:4010` mock server 与 seed 直插（`seed.ts:353-378`「直接改共享 dev 库」）保持原样；e2e 断言试运行的「真 provider 调用数 0」用 mock server `/__control/calls` 记录不增 + `/metrics` 的 `dagents_cli_spawn_total` 前后差 0。

---

## 6. 测试计划

**单测（vitest）**：

1. `packages/workflow/src/utils/validate-topology.test.ts`（扩展）：severity 分级——repairable 不改 `ok` 判定、与 error 同批全量返回（AC-R9-4 前半）；占位符静态扫描的命中/误报边界（已知键白名单）。
2. `packages/workflow/src/utils/trial-subgraph.test.ts`（新）：选中集裁剪——内部边保留/外部边剪除/虚拟 start 合成/`externalUpstreams` 推导/选中含 start/选中 iteration 控制器/空选中=全图；seedRuntime 形状（`{id}` 与 `{id}.output` 双键）。
3. `packages/workflow` 引擎语义测试（扩展 `executor-semantics.test.ts` 或新文件）：NodeRejectedError 三来源（迭代超限/深度超深/retries≥1 耗尽）→ run 终态 `partial_success` + 失败 span `status='rejected'`；retries=0 失败仍 `failed`（RM-01 语义钉子）；`trialMode.http='skip'` 的 http 节点输出标注（AC-R10-5 单测半）。
4. `apps/gateway` vitest（`dagents_gw_test` 自动建库纪律）：`trial-mock-llm` 内核与 `server.mjs` 行为对照（谓词命中序/未知谓词不命中/toolLoop/delay/错误注入——两份实现的行为等价钉子，NFR-2 共用内核的验收形式）；trial 路由的隔离写入口径（AC-R10-3 的 DB 断言半：spans 有行 join `runs.source='trial'`、checkpoint/usage_events 零行、`listRunsHistory` 过滤生效）；`run-notify` 的 claim 幂等与 superseded 零发射（AC-R9-3 服务端半）。
5. console 组件测：`use-task-notification` 对 `run-updated` 帧的 superseded 过滤（AC-R3-6 最小阶段与 AC-R9-3 客户端半）；`run-notify-claim` BroadcastChannel 首_claim 单发（jsdom 无 BroadcastChannel 需 stub——测试计划如实标注）。

**e2e（`apps/console/tests/e2e/`，新 spec `26-canvas-trial-run.spec.ts`；编号避让——verdict/artifacts 亦拟占用 25，本方向让位取 26；仓库有双 24 重号先例，编号非硬约束，实施期以不撞名为准）**：

- AC-R10-1：选中单 LLM 节点试运行 → 面板见 scripted 输出 + prompt；mock server calls 不增 + `dagents_cli_spawn_total` 差 0。
- AC-R10-2：customFunction 试运行真实执行（超时/异常如实呈现）。
- AC-R10-3：三隔离断言（FlowRunsPanel 无行 / usage-summary 不变 / `usage_events` 零行）+ spans 存在带 trial 标记 + 无 checkpoint 行。
- AC-R10-4：试运行后正式 run 仍走 active provider。
- AC-R10-5：http 默认跳过标注；显式真发时 SSRF 守卫生效（私网 URL 拒绝——复用 `DAGENTS_HTTP_ALLOW_PRIVATE` 逃生门测试形态）。
- AC-R10-6/7：草稿图回边 → 拒绝带定位；未解析占位符证据面板计数定位。
- AC-R9-4 e2e 半：repairable 诊断保存不阻断 + 运行面板黄警；节点拒绝黄警 + run 非红（partial_success 标签）。
- 既有全量 e2e 回归绿（NFR-2）；R3 落地后补 AC-R9-3 双入口单通知 e2e（与 R3 AC-R3-6 载体阶段同批）。

---

## 7. 涉及文件清单（ownedFiles）

**本方向独占（新增）**：

| 文件 | 内容 |
|---|---|
| `docs/zcode-borrow/design-sharp.md` | 本文档 |
| `docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md` | 9a ADR |
| `packages/contracts/src/trial-run.ts` | 试运行契约（§3.2） |
| `packages/workflow/src/utils/trial-subgraph.ts`（+ `.test.ts`） | 子图裁剪器 |
| `apps/gateway/src/lib/trial-mock-llm.ts` | fake llmClient + recorder 内核 |
| `apps/gateway/src/routes/workflow-trial.ts`（+ 测试） | 试运行路由 |
| `apps/gateway/src/lib/run-notify.ts`（+ 测试） | 9b 发射单点 + claim |
| `packages/db/src/migrations/1720000106000-add-runs-source.ts` | source 列迁移 |
| `packages/db/src/migrations/1720000106200-widen-run-node-spans-status-chk.ts` | span status CHECK 放宽（§1.2，一次并入 `'rejected'`(本方向)/`'cached'`(R2)/`'stopped'`(R1·R3 boot sweep)——**三方写方的共同前置，迁移先行**） |
| `apps/console/src/components/canvas/trial-run-panel.tsx` + `.css` | 试运行面板 |
| `apps/console/src/lib/run-notify-claim.ts` | 跨标签页 claim |
| `apps/console/src/lib/use-trial-run.ts` | 试运行编排 hook |
| `apps/console/src/app/api/workflows/[id]/trial/route.ts` | BFF |
| `apps/console/src/app/api/runs/[runId]/trial-calls/route.ts` | BFF |
| `apps/console/tests/e2e/26-canvas-trial-run.spec.ts` | e2e（编号避让 verdict/artifacts 的 25） |

**共享 barrel · 追加式（与其他方向对账；合并批次约定：同一契约声明行/同一函数邻行的追加合并同一 PR 或显式错峰，禁止独立盲合）**：

| 文件 | 本方向追加 | 撞车方向/约定 |
|---|---|---|
| `packages/contracts/src/run-live.ts` | nodeEnd.status + `'rejected'`（`:63`） | R2 同位加 `'cached'`——**NodeSpanStatus/nodeEnd.status 契约行合并同一 PR 一次改齐** |
| `packages/contracts/src/index.ts` | `export * from './trial-run.js'`（barrel `:1-6` 追加一行） | R6 的 run-deliverables 同文件追加——各自一行，无冲突 |
| `packages/contracts/src/ws.ts` | run-updated 激活 + flowId/stopReason 字段（`:49`） | R3 stopReason 词表同源 |
| `packages/db/src/entities/run-node-span.entity.ts` | NodeSpanStatus + `'rejected'` | R2 `'cached'`、R1/R3 `'stopped'` 同一声明行——**三方合并同一 PR**（DB CHECK 放宽由 §1.2 迁移承载） |
| `packages/db/src/entities/run.entity.ts` | source 列声明 | R3 改 RunStatus 词表同文件不同行 |
| `packages/workflow/src/engine/executor.ts` | runNode 重试耗尽包装（`:468-478`）+ runWaves catch 分类（`:633-667`）+ buildNodeContext trialMode 透传（`:393-427`） | R1/R2/R7/R8 大本营（R1 的 ordinal 透传与 trialMode 同在 buildNodeContext 同点追加）——**同点追加错峰或同 PR，禁止盲合** |
| `packages/workflow/src/types/execution.ts` | IExecutionContext.trialMode 可选字段 | R4 execRunner、R5 chat 签名同文件接口追加——错峰或同 PR |
| `packages/workflow/src/utils/validate-topology.ts` | severity/repair 字段 + 2 条 repairable 规则 | R4 加白名单规则同文件——规则函数各自独立 |
| `packages/workflow/src/nodes/http/http.node.ts` | trialMode skip 分支（全部静态校验后、fetch 前——定序见 §3.4-③） | R4 域名守卫同缝，**顺序已写死：域名/声明校验在前、skip 在后** |
| `apps/gateway/src/app.ts` | trial 路由挂载一行（`app.route` 区 `:248` 邻域） | 全方向共用挂载区（该文件同载 Origin 防线 `:94-98` 与鉴权中间件——追加行零语义触碰） |
| `apps/gateway/src/routes/workflow-engine-service.ts` | llmClientOverride 注入位（`:108`）+ 子流程深度错误改 NodeRejectedError（`:144-149`） | R1/R8 改同文件装配区——追加式 |
| `apps/gateway/src/repositories/runs.repo.ts` | source 参数 + trial 过滤（`:146-181/213-282`） | R2 lineage 查询、R3 stop_reason 透传同函数邻行——错峰或同 PR |
| `apps/gateway/src/routes/runs.ts` | source 读列（`:75`） | R2/R3 标签域同文件 |
| `apps/gateway/src/routes/human-input.ts` / `execution-registry.ts` / `resume-execution.ts` | **仅注释**互引 ADR | R1/R3 动行为、本方向只动注释——零冲突 |
| `apps/gateway/src/ws-hub.ts` | subscribedRuns + broadcastRun | 9b 独占改动（其他方向不涉） |
| `apps/console/src/lib/ws-client.ts` | subscribeRun refcount | 同上 |
| `apps/console/src/lib/use-task-notification.ts` | run-updated 分支 + superseded 过滤 | R3 同位（AC-R3-6 共享验收）——合并同一 PR |
| `apps/console/src/components/flow-canvas/flow-editor.tsx` | getSelectedNodeId（P1 多选另批） | R2 重跑入口同文件 |
| `apps/console/src/components/canvas/canvas-kit-page.tsx` | 试运行按钮 + repairable/rejected 呈现 | R1/R2/R3/R6 大本营——NFR-5 动刀窗口合并 |
| `apps/console/src/i18n/en/flows.ts` | 词条追加（含独立键「已拒绝（可重试）」，规避 settings.ts:288 既有「已拒绝」——spread 顺序见 §4.7） | permission/artifacts 等多方向都加词条——各自追加独立键，合并时 grep 查重 |
| `apps/gateway/src/span-writer.ts` | rejected 状态映射一行 | R2 cached、R1 stopped 同位——合并同一 PR |
| `docs/workflow-engine.md` | 上限对照表 + 9a ADR 引用 | R1/R3 补 resume/journal 节——各加各节 |

---

## 8. 分步实施（每步可独立合入、可恢复中断）

> 「地基」= 契约 + 迁移（本方向的不可回退起点；R1/R3 未合入不阻塞本方向，仅在标注处等待对齐）。

1. **【地基 A · 契约】** `run-live.ts` + `run-node-span.entity.ts` 加 `'rejected'`（与 R2 `'cached'`、R1/R3 `'stopped'` 协商合并同一契约 PR——三方同声明行，禁止各自盲合）；`ws.ts` run-updated 扩字段；新 `trial-run.ts` + barrel 挂载。——纯类型，零行为。
2. **【地基 B · 迁移】** `1720000106000-add-runs-source.ts`（+ 写侧四路径接通 + 读侧 COALESCE，存量行为逐字不变——回填与派生同义）+ `1720000106200-widen-run-node-spans-status-chk.ts`（CHECK 放宽，`'rejected'`+`'cached'`+`'stopped'` 三词一次到位；**本迁移是三方写方共同前置**——须先于 recover 第 1 批（boot sweep 写 stopped）/第 4 批（R2 cached）与本设计第 5 步（rejected）任一合入；纯放宽可独立先行，写方未落地前多出的词无写方）。
3. **【R9a · 纯文档】** ADR + 三处注释互引 + workflow-engine.md 链接。——随时可合，建议最先（零风险）。
4. **【R9c · 校验分级】** validate-topology severity/repair + 2 规则 + 单测；gateway 透传；console 保存/运行面板呈现 + i18n。
5. **【R9d · 上限两档】**（前置：步骤 2 的 CHECK 放宽迁移已合入）NodeRejectedError + 三来源改抛 + runWaves 分类 + span 映射 + 对照表落 docs/workflow-engine.md + console 黄警徽章；既有 e2e 全量回归（§5 行为变更清单核对）。
6. **【R10 引擎件】** trialMode 接口/透传 + http skip 分支 + `trial-subgraph.ts` + 单测。——不接线、无路由，纯函数可测。
7. **【R10 gateway】** trial-mock-llm + trial 路由 + 隔离写入口径 + metrics + gateway 单测（隔离断言/内核对照）。
8. **【R10 console】** getSelectedNodeId + 试运行面板/证据面板/入口 + BFF + i18n；e2e `26-canvas-trial-run.spec.ts`（AC-R10 全七条）。
9. **【R9b · 通知】** 最小阶段：run-notify + ws-hub runId 订阅 + console 过滤逻辑（superseded 分支待 R3 stopReason 落库后实弹）；载体阶段收口 AC-R9-3 双入口单测/e2e（与 R3 AC-R3-6 第二阶段同批交付）。
