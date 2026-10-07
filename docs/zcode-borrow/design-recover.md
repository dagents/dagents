# 设计文档 · 可恢复性方向（R1 / R2 / R3 / R7 / R8）

> 需求来源：`docs/zcode-borrow/requirements.md`（v1.2）。本文是该 PRD「可恢复性」方向的设计定稿，负责 R1（journal 确定性重放与 resume）、R2（修订重跑暖缓存）、R3（结算状态机 cancel ≠ fail）、R7（事件全序与统一回放）、R8（确定性会话身份与模型 pin）。
> 修订记录：v2（2026-10-07 总架构师评审修订）——①spans status CHECK 事实纠错（§1.3：`1720000007000:57-58` 建表即带五值 CHECK，放宽由 design-sharp `1720000106200` 承载并升格三方共同前置）；②R8 `resumeSessionId` 取值单源（§3.6(a)：`deriveSessionId` 降格为寻址键绝不进 ExecOptions，该字段只承载后端真实会话 id，与 R5 透传协议同一语义）；③R6 对 span-writer 写侧按 AD-R1 对齐的终裁固化（§⑦）；④ownedFiles 独占/共享重分类（七个既有文件移共享表，标注合并批次）；⑤journal `flow_id` 改 TEXT 对齐既有 de facto（§1.1）；⑥谱系链抽共享 lineage helper 深度统一 16 + journal 读侧收敛 run-node-journal.repo（§3.7(b)）；⑦i18n 词条与既有键去重、e2e spec 编号说明（§4.3/§⑥）。
> 全文锚点均在 2026-10-07 工作区（分支 `feat/zcode-borrow`）逐读核验；「PRD」指 requirements.md。
> 排期耦合（PRD 需求总览段）：R1/R3/R7/R8 共享同一块地基（节点实例键 + 状态词表 + journal 真相源）——本文第 ⑧ 节的「地基批次」即为此一次定稿；R2/R3 的 UI 变更与 R6（渐进产物方向）同落 `canvas-results-panel`，按 NFR-5 合并一批交付（见 ④ 与 ⑦ 的协调标注）。

---

## 0. 总体裁决速览

| # | 裁决 | 依据/动机 |
|---|---|---|
| AD-R1 | journal 落**新表 `run_node_journal`**（不扩 `run_node_spans`），单表同时承载 R1 决策记录与 R7 事件流（kind 判别）——OQ-1 定稿 | spans 的 `(run_id, node_id)` 唯一索引（`packages/db/src/migrations/1720000093000-unique-run-node-spans.ts:24-26`）是 console 全链消费键（`apps/console/src/lib/run-trace-model.ts:47-48` DB 路恒单段），重建为复合键波及面不可控；新表零破坏迁移 |
| AD-R2 | `run_node_spans` 降格为**观测投影**（读面兼容层），`run_node_journal` 是**唯一真相源**（R1 决策 + R7 事件同表同事务序） | PRD R1.1「单表或同事务写入，禁止双写双真相源」的直接兑现；spans 与 journal 并存是「投影 vs 真相源」关系，不是双真相源 |
| AD-R3 | `input_hash` 口径 = SHA-1(canonical({ nodeType, resolvedConfig, nodeInput }))：`resolvedConfig` 是节点 mergedInputs 经 `resolveVariables` 预演解析（只用于 hash，不改执行输入），`nodeInput` 是引擎 `mergeInputs` 结果原样 | 上游输出变化经 nodeInput 直接进 hash（暖缓存保守传递闭包自动成立）；节点自身 prompt 改动经 resolvedConfig 进 hash（AC-R1-3）；未引用的 runtime 键不进 hash（不误杀） |
| AD-R4 | ordinal = **per-node 执行实例序号**（每 nodeId 从 0 单调递增；非迭代节点恒 0；迭代 body 第 n 次执行 = n，单层下恰等于项索引） | 嵌套迭代下 (nodeId, 项索引) 会撞键（内层控制器每轮重置游标，`packages/workflow/src/engine/executor.ts:823-825`）；per-node 单调序天然唯一，`(run_id, node_id, ordinal)` 唯一索引成立 |
| AD-R5 | R7 seq = registry `emit()` 单点进程内 per-run 计数器；**结构帧（nodeStart/nodeEnd/runEnd）write-through 先落库后发帧，delta 帧 write-behind 异步批量落库**；`run_node_journal` 同时是 live registry 的持久层——live 404 时由 journal 前缀透明重建 hello.replay | PRD R7.1/R7.5 定稿的直接落地；console `use-run-live.ts` 零改动（SSE 流形状不变，`apps/console/src/lib/use-run-live.ts:72-75` 的 404 分支在 gateway 侧被回放接管） |
| AD-R6 | R8 persona 冻结载体 = **`runs.frozen_agents` JSONB 列**（OQ-6 定稿）；`deriveSessionId(runId, nodeId, ordinal)` = SHA-1 前 16 hex 是 **dagents 侧寻址键**（runNodeSinks 键/重挂查表/插话寻址），**绝不进 `ExecOptions.resumeSessionId`**——该字段取值单源为后端真实会话 id（R5 能力披露协议，评审修订） | run 级快照要跨进程存活（resume），journal/checkpoint 都不是「run 创建期」的自然载体；`AgentDaemonCall.sessionId` 先例已证明 runs 行 JSONB 可承载会话语义（`packages/db/src/entities/run.entity.ts:48-49`）；两套 id 空间混用会让 claude 档首跳即炸（§3.6(a)） |
| AD-R7 | cancelled → 写侧 `stopped(stop_reason='user')`，读侧双读，DB CHECK 显式保留 `cancelled`（写新读旧）；`stop_reason` 五值 `user/interrupted/superseded/model/provider` 无死值 | PRD R3.2/R3.3 定稿；NFR-1 双词表兼容（`ADD CONSTRAINT ... CHECK` 默认 VALID 扫全表） |

---

## ① 数据模型与迁移

### 1.1 新表 `run_node_journal`（迁移 `1720000110000-create-run-node-journal.ts`，新文件）

```sql
CREATE TABLE "run_node_journal" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id"     UUID NOT NULL,
  "flow_id"    TEXT NOT NULL,          -- TEXT 对齐既有 de facto：spans.flow_id TEXT（1720000007000:43）、runs.pipeline_id TEXT（1720000002000:38）；与 flows.id（UUID）join 沿用显式 ::text cast（runs.repo.ts:118 先例 `f.id::text = r.pipeline_id::text`），避免实施期 text↔uuid 运算符类型墙
  "node_id"    TEXT NOT NULL,          -- event 行的 runEnd 帧 = '__run__'
  "ordinal"    INTEGER NOT NULL DEFAULT 0,
  "kind"       TEXT NOT NULL,          -- 'decision' | 'event'
  "seq"        BIGINT NOT NULL,        -- per-run 单调全序（emit 单点分配）
  "event_type" TEXT,                   -- event 行：nodeStart/nodeEnd/runEnd/delta；decision 行 NULL
  "payload"    JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT run_node_journal_kind_chk CHECK ("kind" IN ('decision','event'))
);
CREATE UNIQUE INDEX uq_run_node_journal_run_seq
  ON "run_node_journal" ("run_id", "seq");                       -- 乱序兜底（冲突显式报错）
CREATE UNIQUE INDEX uq_run_node_journal_decision
  ON "run_node_journal" ("run_id", "node_id", "ordinal")
  WHERE kind = 'decision';                                       -- 部分唯一索引：AC-R1-2 每 (nodeId, ordinal) 一档
CREATE INDEX idx_run_node_journal_lookup
  ON "run_node_journal" ("run_id", "node_id", "kind");           -- 暖缓存 (nodeId, inputHash) 查找路径
```

- **decision 行**（`onNodeEnd` 终态时写）：`payload = { status: 'done'|'failed'|'cached', inputHash, input, output, tokens, resolvedModel, lineage?: { inheritedFromRunId, inheritedTokens } }`。只在节点终态写（崩溃中的节点没有 decision 行——「无完成记录 = 重跑」，语义上等价 PRD R1.3 的「running 崩溃残留 → 按记录重派」，且不需要在 journal 里维护状态机）。
- **event 行**（R7）：`payload` = `RunLiveFrame` 原样（含 `at`/`seq` 原值）。回放 = `SELECT payload FROM run_node_journal WHERE run_id=$1 AND kind='event' ORDER BY seq`，帧形状契约不变（AC-R7-4 双 builder 零改动）。
- **同事务性**：decision 行与其对应 nodeEnd event 行由同一 journal-writer 串行链相邻写入（见 3.4），`(run_id, seq)` 唯一索引兜底双写者抢号（AD-R5：单写者模型下该索引只是保险丝）。

**entity**：`packages/db/src/entities/run-node-journal.entity.ts`（新文件），`packages/db/src/index.ts` 追加导出（追加式共享 barrel）。

### 1.2 `runs` 表扩展（迁移 `1720000111000-runs-stop-reason-and-snapshots.ts`，新文件）

1. **`stop_reason TEXT NULL`** + `CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('user','interrupted','superseded','model','provider'))`。归属（PRD R3.2 定稿，无死值、无双重归属）：
   - `stopped` 行：`user`（旧 cancelled）/ `interrupted`（boot sweep）/ `superseded`（chat 域 latest-wins，`apps/gateway/src/execution-registry.ts:80` 唯一产生链路；暖缓存不产生该值——R2.1 定稿，前驱必已终态无 abort 语义）；
   - `failed` 行：`model`（引擎/模型错误，默认）/ `provider`（HTTP provider 故障且 pin 拒绝降级）；非 pin 降级不产生终态，全链路无 `stopped(provider)`；
   - 其余状态行恒 NULL。
2. **status CHECK 重建**（词表九值，`cancelled` 显式保留——NFR-1）：`pending / running / awaiting_input / completed / partial_success / budget_exceeded / failed / stopped / cancelled`。先例：`packages/db/src/migrations/1720000103000-widen-runs-status-chk.ts:14-18`。
3. **`frozen_agents JSONB NULL`**（AD-R6）：`{ [agentId]: { instructions, model, kind, skills } }`，run 创建期快照（见 3.6）；可选同批承载 `sessions: { [deriveSessionId]: backendSessionId }` 会话映射（R8 跨进程重挂查表——或改记 journal decision 行的 session 载荷，实施时择一，见 §3.6(a)）。
4. **`models JSONB NULL`**：`{ [nodeId]: resolvedModel }`，run 级模型快照（AC-R8-4 的 runs 侧可查性）。

### 1.3 `run_node_spans` 扩展（同一迁移 `1720000111000`）

- 加列 `ordinal INTEGER NOT NULL DEFAULT 0`（存量行默认 0，行为不劣于今天）。
- **唯一索引不动**：保持 `(run_id, node_id)`（观测投影的「末次覆盖」语义正是 console 现有消费契约）。ordinal 列只做**标注**（终端视图 `nodeId[ordinal]`、R8 stdin 行），不参与键。迭代的 per-ordinal 完整事实在 journal（AD-R1/R2 分工）。
- `NodeSpanStatus` 词表扩 `'stopped'`（boot sweep 收敛）与 `'cached'`（R2）：`packages/db/src/entities/run-node-span.entity.ts:32-39`。
- **CHECK 放宽前置依赖（评审修订，三方共同前置）**：`run_node_spans.status` 并非裸 text——建表即带 `run_node_spans_status_chk CHECK (status IN ('running','done','failed','paused','unknown'))`（`packages/db/src/migrations/1720000007000-create-run-node-spans.ts:57-58`，全迁移目录此后无触碰）。本方向两处写库将被该 CHECK 拒收：boot sweep `UPDATE run_node_spans SET status='stopped'`（③.2②）与 R2 cached span 落库（③.1(c)2）——且 boot sweep 每步独立容错会吞错、spans 永悬 running，正是 `1720000103000-widen-runs-status-chk.ts:4-9` 头注释记载的实弹故障模式（终态 upsert 被 CHECK 拒收、行永远停在 running）。**裁决**：CHECK 放宽迁移由 design-sharp 持有的 `1720000106200` 承载（号段/范式已对齐），词表一次放宽到位 `+ 'rejected','cached','stopped'`（同时覆盖 sharp 9d 的 `rejected`）；该迁移**必须先于本方向第 1 批（boot sweep 写 stopped）、第 4 批（R2 cached span）与 sharp 第 5 步（9d rejected）任一写方合入**——「迁移先行、写方随后」是三方共同前置，不是单方向的内部事务。TS 类型（`NodeSpanStatus`）与 `toNodeSpanStatus`（`apps/gateway/src/repositories/runs.repo.ts:35-56` 增 `cached`/`stopped` 分支）随写方批次改齐。

### 1.4 不迁移的东西（显式声明）

- 存量 `cancelled` 行**不改写**（写新读旧，PRD R3.3）。
- `run_checkpoints` 词表**不扩**（维持 `running/awaiting_input/resumable/terminal` 四值，`packages/db/src/entities/run-checkpoint.entity.ts:14`；PRD R1.5 定稿）。
- 存量 spans 无 ordinal 值均为 0、无 hash——resume/journal 校验对「无 hash 的种子」跳过校验照旧种子化（PRD R1.7）。

### 1.5 retention 级联扩展（`apps/gateway/src/retention.ts`）

- 终态清单扩词表全集：`retention.ts:31-33` 现在只认 `completed/failed/cancelled`——**顺带修一个现状隐患**：`partial_success/budget_exceeded`（2026-10-04 引入）已不在清理清单，R3 再加 `stopped` 必须同批扩为 `('completed','failed','cancelled','partial_success','budget_exceeded','stopped')`，否则终态行永不清。
- 删除级联加 `DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])` 与 orphan 回收（`retention.ts:52-57` 同款）。暖缓存 miss 的诚实边界（R2.6）：前驱被 retention 清掉 = journal 行没了 = 查找 miss = 全量重跑，不报错。
- **单 run 保护性上限**（NFR-7）：`DAGENTS_JOURNAL_MAX_ROWS_PER_RUN`（默认 100_000）。超限时 delta 帧拒收并留痕（journal 写入一条 `journal_overflow` activity 事件 + `/metrics` 计数器 `dagents_journal_overflow_total`，不静默丢）。

---

## ② @dagents/contracts 契约变更（`packages/contracts/src/run-live.ts`，追加式）

1. **`RunLiveFrame` 增可选 `seq?: number`**（与 `at` 同位、由 registry `emit()` 单点补；`truncated` 标记除外——与 `at` 的既有豁免同款，`packages/contracts/src/run-live.ts:47-53`）。具体形状：
   - `RunLiveAt` 接口扩为 `{ at?: string; seq?: number }`（`run-live.ts:51-53`）——所有帧继承，帧形状不变，console 双 builder 兼容（PRD R2.3/R7.2）。
2. **`nodeEnd.status` 扩 `'cached'`**：`run-live.ts:63` `'done' | 'failed'` → `'done' | 'failed' | 'cached'`（R2.3 定稿：帧形状不变、枚举追加）。
3. **`runEnd` 帧增可选 `stopReason?: string`**：`run-live.ts:70`（R3.5 最小实现：客户端兜底过滤 superseded 通知的数据面）。
4. **新增 `nodeStart`/`nodeEnd` 可选 `ordinal?: number`**（默认 0；终端 stdin 行 `nodeId[ordinal]` 与 R8.5 寻址用）。
5. 契约文件头注释补「journal 是本协议帧流的持久层；404 回退由 journal 前缀重建」（可用性阶梯修订，`run-live.ts:32-34`）。

不新增契约文件（零新依赖，NFR-3）；`packages/contracts/src/index.ts` barrel 无需改动。

---

## ③ 引擎 / 路由 / gateway 改动

### 3.1 引擎核心：节点实例键与 journal 接缝（`packages/workflow/src/engine/executor.ts`）

**(a) IExecutedNode / IExecutionContext 增 ordinal**（地基）。
- `IExecutedNode` 增 `ordinal: number`（`packages/workflow/src/types/execution.ts` 的接口；executor 组装处在 `executor.ts:600-610` 与迭代路径 `executor.ts:917/959` 补齐）。根图恒 0；`runIterationBody` 的串行/并行路径按 per-node 执行计数器分配（`RunContext` 增 `nodeOrdinals: Map<string, number>`，节点开始执行时 `+1`——AD-R4）。
- `buildNodeContext`（`executor.ts:393-427`）把 `ordinal` 传入 `IExecutionContext`——下游 llmClient.chat 的 `CliChatParams.ordinal`（R8 会话铸造）与 span-writer 标注共用。

**(b) ResumeOptions 扩种子元数据**（`executor.ts:98-106`）：

```ts
export interface ResumeOptions {
  seedOutputs: Record<string, Record<string, unknown>>
  seedRuntime?: Record<string, unknown>
  iterationProgress?: Record<string, IterationProgress>
  /** 种子携带的 expected input_hash（resume 严格校验用；暖缓存校验在 gateway 侧已完成，不传则跳过） */
  seedHashes?: Record<string, string>
  /** 种子来源标注（cached span/live 帧/谱系书写用） */
  seedSource?: { kind: 'resume' | 'warm-cache'; fromRunId: string }
}
```

**(c) 种子跳过路径的三点改造**（`executor.ts:537-551` 现状「无条件信任」）：
1. **hash 校验**：跳过种子节点前，用当前 runtime 状态对该节点做 `mergeInputs` + `resolveVariables` 预演，算 `computeInputHash` 与 `seedHashes[nodeId]` 对比；不一致 → 抛结构化错误（含 nodeId + expected/got，AC-R1-3），run 终态 `failed`。注意：现状跳过发生在波次装配时（`:541-551`），此时上游种子输出已在 `outputs` 里，mergeInputs 可用既有纯函数（`executor.ts:589-594` 同款路径）。
2. **cached 钩子回放**：种子节点跳过时调用 `opts.onNodeEnd({ nodeId, nodeName, ordinal: 0, status: 'cached', output: seedOutput, ... })`——span-writer 落 `cached` span（徽章/结果面板）、live registry 发 `nodeEnd(cached)` 帧、journal-writer 写 cached decision（lineage 载荷）。AC-R1-6「续跑后已完成节点徽章保持 done」与 R2 cached 徽章由此同一机制兑现（cached 与 done 视觉区分在 console 侧）。
3. **迭代体 per-ordinal 种子**：`IterationProgress` 增可选 `itemNodeOutputs?: Array<Record<string, Record<string, unknown>>>`（每项 body 节点输出映射）；`runIterationBody` 串行路径（`executor.ts:1014` 附近）为第 i 项构造 `iterationOutputs` 克隆时预填该项输出，使 `runWaves` 的种子跳过机制对迭代体生效。预填判据不能复用 `outputs === ctx.rootOutputs`（`executor.ts:539-541` 明言迭代体克隆不判种子）——`runWaves` 增显式参数 `preseeded: Set<string>`（本项预填的节点 id 集合），跳过逻辑据此释放出边。嵌套迭代 v1 不承诺 per-ordinal 短路（内层控制器每轮重置游标，`executor.ts:823-825`）——文档诚实边界，项粒度游标行为不劣于现状。

**(d) `computeInputHash` 单源函数**（新文件 `packages/workflow/src/utils/input-hash.ts`，地基）：

```ts
export function canonicalJson(value: unknown): string   // 递归排序对象键；数组保序；undefined/函数跳过（写法对齐 computeTopoHash 的排序序列化，resume-execution.ts:40-54）
export function computeInputHash(input: { nodeType: string; resolvedConfig: unknown; nodeInput: unknown }): string  // SHA-1
export const NON_DETERMINISTIC_KEYS: ReadonlySet<string> // 初始空；实测发现时间戳/随机类键再补，注释声明这是「发现的台账」不是「穷举的清单」
```

口径（AD-R3）：`resolvedConfig` = 节点 mergedInputs（`executor.ts:448-453`）深拷贝后经 `resolveVariables` 预演解析——**只用于 hash，不改变传给节点的输入**；`nodeInput` = 引擎 merge 结果原样（上游输出直接进 hash → 暖缓存保守传递闭包自动成立）。引擎与 gateway（暖缓存查找、resume 校验）共用此单源，不得出现第二套 hash（PRD R2 风险条款）。

**(e) JournalFacade 接缝**（引擎保持 DB-free，`ExecuteOptions` 增可选 `journal?: { recordDecision(entry): void; lookup(nodeId, ordinal): Promise<JournalDecision | null> }`——宿主注入）。执行前查 journal 短路（PRD R1.3）的落点：**resume/暖缓存的种子组装全部在 gateway 侧完成**（`buildResumeSeed`/`buildWarmCacheSeed` 查 journal），引擎内不做 DB 查询；引擎侧 journal 接缝只用于**写入**（onNodeEnd → decision 行）与**迭代体断点项短路**（3.1(c)3 的种子由 gateway 从 journal 组装传入，引擎仍零 DB）。这样引擎的 DB-free 红线（`docs/ARCHITECTURE.md` §1）不破。

**(f) 取消路径携带 stopReason**：`ExecuteOptions.signal` 不变；superseded 判定不进引擎（gateway 执行路径读 `abort.signal.reason`，见 3.3）。

### 3.2 boot sweep 三件收敛 + 诚实边界（`apps/gateway/src/index.ts:86-122`）

现状 `runs → failed`（`index.ts:86-89`）、`spans → failed`（`:92-99`）改为：

```
① UPDATE runs SET status='stopped', stop_reason='interrupted', finished_at=NOW()
   WHERE status IN ('running','pending')
② UPDATE run_node_spans SET status='stopped',
     error = COALESCE(error, 'gateway 重启中断（boot sweep）'),
     finished_at = COALESCE(finished_at, NOW())
   WHERE status = 'running'
③ UPDATE run_checkpoints SET status='resumable', updated_at=NOW() WHERE status='running'
```

- ③ 是 AC-R1-1 的关键前置：崩溃时进程内 `terminalize('resumable')`（`apps/gateway/src/routes/workflows.ts:546-556`）从未执行，checkpoint 停在 `running` 会被 resume 路由 409（`apps/gateway/src/routes/execution-resume.ts:104-108` 只认 `resumable`）。
- 无 checkpoint 的 run（chat 触发路径不接 onCheckpoint：`apps/gateway/src/routes/chat-execute.ts:492-505`、`apps/gateway/src/routes/chats.ts:725-737` 均未传）同样标 `stopped(interrupted)`（中断事实诚实），但 resume 可用性判据 = checkpoint 存在且 `resumable`（UI 入口联动，见 ④）。
- 真失败（catch 路径）仍 `failed`——sweep 只碰在途行，终态行零改写（AC-R3-1 的「终态不被后台任务改写」由 WHERE 条件保证）。
- 既有 awaiting 超时收敛（`index.ts:106-122`）语义不变，但 runs 行落 `failed` 改为**维持 failed**（应答窗超时是真实失败语义，不改词——PRD 未把它列入 stopped 来源，保守不动）。

### 3.3 R3 状态机：单源映射 + cancelled→stopped 写新读旧

**(a) `toRunStatus` 单源化**（`apps/gateway/src/routes/workflow-engine-service.ts:259-267`）：
- 签名扩为 `toRunStatus(executionStatus: string, ctx?: { superseded?: boolean }): { status: RunStatus; stopReason?: StopReason }`。
- `cancelled` → `{ status: 'stopped', stopReason: ctx?.superseded ? 'superseded' : 'user' }`（引擎语义 cancelled 翻译为 stopped，来源由 abort reason 判定）。
- **收敛手写映射**：`resume-execution.ts:319-328` 的三元链删除，改调 `toRunStatus`（AC-R3-3 三入口一致：直跑 `workflows.ts:560`、resume `resume-execution.ts:319`、answer 同路径）。
- TS `RunStatus` 对齐九态（`packages/db/src/entities/run.entity.ts:23`：加 `awaiting_input/partial_success/budget_exceeded/stopped`）。

**(b) superseded 判定**：`execution-registry.ts:80` 的 `abort('superseded by a new execution in this chat')` 使 `signal.reason = Error('superseded …')`；执行路径在 cancelled 分支读 `signal.reason` 字符串含 `'superseded'` → `stop_reason='superseded'`。写侧 helper `classifyAbortReason(signal): 'user' | 'superseded'`（新函数，放 `resume-execution.ts` 或 `workflow-engine-service.ts`，单测钉住）。

**(c) 落库点带 stopReason**：
- `persistWorkflowRunRow` 增 `stopReason` 参数（`apps/gateway/src/repositories/runs.repo.ts:213-259` 的 INSERT/UPDATE 列各加一处）。
- `chat-execute.ts` cancelled 分支（`chat-execute.ts:498-505` persistCancelled）与 `resume-execution.ts` catch 分支（`:347-350`）同步。

**(d) budget_exceeded resume 双路径**（PRD R3.4）：
- `resumeBodySchema` 增 `tokenBudget: z.number().int().positive().max(100_000_000).optional()`（`execution-resume.ts:37-41`）。
- `RunExecutionInput` 增 `tokenBudget?: number`（`resume-execution.ts:149-170`），透传引擎（`startWorkflowExecutionInner` 的 execute opts，`resume-execution.ts:284-307`）。
- 缺省沿用前驱预算值：从 `runs.input` jsonb 读 `tokenBudget`（run body schema 有此字段，`apps/gateway/src/routes/workflows.ts:353`）。预算从零起算由引擎现状保证（`ctx.tokensSpent` 启动置 0 `executor.ts:258`、种子节点不进 executedNodes 不产生 usage）。
- 黄警披露：resume 启动时沿 `resumed_from_run_id` 链查 `usage_events` SUM（`recordUsageEvent` 已按 runId 记账，`apps/gateway/src/usage-events.ts:84-100`），经 live tap 发一条 activity 帧再 runEnd——「预算重新起算（谱系链累计已耗 X tokens）」（NFR-6 留痕）。

**(e) 通知抑制最小实现**（PRD R3.5/R3.6 分步口径）：runEnd 帧带 `stopReason`（`live.finish(status, stopReason?)` 签名扩展，`run-live-registry.ts:243-250`）；`recordRunFinished` 指标标签自动带新词（`apps/gateway/src/lib/run-gate.ts:80-82` status 字符串透传，无需改声明）。服务端「不产生用户可见终态通知」在 OQ-2 载体落地前以帧标注 + 客户端过滤为界（chat 域现状只推 `chat:done/chat:error` 五事件 `apps/gateway/src/ws-hub.ts:29-35`，`use-task-notification.ts:213` 的过滤分支补 `frame.stopReason === 'superseded'` 早退——见 ④）。

### 3.4 journal-writer 与 live registry 取号（R7，新文件 `apps/gateway/src/journal-writer.ts`）

**(a) emit 单点取号**：`run-live-registry.ts` 的 `RunLiveEntry` 增 `seqCounter: number`；`emit()`（`run-live-registry.ts:134-157`）在补 `at` 的同一位（`:139`）补 `frame.seq = ++entry.seqCounter`。单写者：run 执行的帧发射都在 gateway 进程内串行（引擎钩子同步语义，`executor.ts:53-58`），无跨进程取号（NFR-3/NFR-7 口径）。

**(b) journal-writer 挂同一钩子**（`assembleWorkflowEngine` 组合点 `workflow-engine-service.ts:216-249`，与 spanWriter/live 并列）：
- **结构帧 write-through**：nodeStart/nodeEnd/runEnd——`emit()` 内部分配 seq 后**先 INSERT journal 再 push subscribers**（插入经 per-run promise 链串行保序；「先落库后发帧」= PRD R7.1 定稿顺序，任意 kill 时机下回放 ⊇ 客户端已收前缀、至多多一条在途边界帧）。低频（与节点数同阶），同步成本可控。
- **delta 帧 write-behind**：微批（64 条或 200ms 窗口）异步 INSERT，per-run 串行链（对齐 span-writer nodeQueues 模式 `apps/gateway/src/span-writer.ts:49-55`）。崩溃窗口的未落库尾部允许丢失，回放侧如实呈现（run 终态 `stopped(interrupted)` 本身就是中断标记；不静默缺行——journal 回放的 hello 里 run 无 runEnd event 行时 ended 判定走 runs 行）。
- **decision 行**：onNodeEnd 时与 nodeEnd event 行相邻写入（同一串行链）。
- **指标**（NFR-6）：`dagents_journal_rows_written_total{kind}`、`dagents_journal_delta_lag_rows`（write-behind 积压 gauge）、`dagents_journal_overflow_total`。

**(c) live 404 → journal 回放**（`apps/gateway/src/routes/execution-live.ts:36-46`）：`attachRunLive` 返回 null 时不再直接 404，改经 `run-node-journal.repo` 的 `listEventFrames` 查 journal：有 event 行 → 以 `ORDER BY seq` 构造 `hello.replay` 前缀（`ended`/`finalStatus` 由 runs 行终态判定，`runs.repo.ts:72-81`），SSE 一次性交付后关流。**console `use-run-live.ts` 零改动**（AC-R7-5：刷新页面轨迹/终端与关闭前一致；有 journal 的 run 不再出现 truncated 头部提示——journal 无环形丢弃，`truncated` 标记只在内存缓冲截断时出现，回放侧天然没有）。仅当「无 live 条目且无 journal 行」才 404（真正的未知 run）。
- 回放上限：单次回放 `LIMIT DAGENTS_JOURNAL_REPLAY_MAX`（默认 20_000 行）+ 超限头部聚合标记（诚实截断，与 1.5 的保护性上限同族）。

### 3.5 resume 路由：journal 化种子 + hash 校验（`apps/gateway/src/routes/resume-execution.ts` / `execution-resume.ts`）

**(a) `buildResumeSeed` 数据源切 journal**（`resume-execution.ts:366-402`）：经 `run-node-journal.repo` 的 `findDecisions`（§3.7(b) 共享读侧 repo）取 `kind='decision' AND payload->>'status' IN ('done','cached')` 的行按 `(node_id, ordinal)` 组装：
- `ordinal=0` 行 → `seedOutputs[nodeId] = payload.output`、`seedHashes[nodeId] = payload.inputHash`；
- 迭代控制器游标仍从 checkpoint snapshot 的 `iterationProgress`（completed + itemOutputs，现状 `:396-401`）+ journal 的 per-ordinal 行组装 `itemNodeOutputs`（3.1(c)3）；
- 控制器节点不种子化的既有裁决保留（`:384-396` 注释——控制器重跑 planning）。
- **hash 不一致的结构化失败**：引擎侧跳过校验抛错（3.1(c)1），错误冒泡为 run `failed`，`error` 含 `nodeId + expected/got hash`（AC-R1-3）；resume 路由无需前置校验（模板解析只有引擎能做，见 AD-R3 论证）。
- checkpoint 兜底：无 journal 行的老 run（迁移前失败存量）回落现状 checkpoint snapshot 种子（`seedHashes` 缺省 → 引擎跳过校验，行为不劣于今天，AC-R1-5）。

**(b) resume 可用性判据**：路由闸门维持「checkpoint `resumable`」（`execution-resume.ts:104-108`）——词表不扩（PRD R1.5）。boot sweep ③ 已保证中断 run 的 checkpoint 收敛 resumable，`stopped(interrupted)` run 天然可 resume（AC-R3-2）。`failed/partial_success/budget_exceeded` 及存量 `cancelled` 的可 resume 性不变（现状非 success 终态一律落 resumable，`workflows.ts:546-556`；RM-01 回归钉子 `apps/console/tests/e2e/24-run-resume.spec.ts:34`）。

**(c) GET checkpoint 端点增 `hasJournal` 位**（`execution-resume.ts:74-91`）：UI 判「已中断（可恢复）」vs「已中断」用（resume 可用性 = checkpoint resumable；但中断 run 的 UI 入口联动还需要知道 run 是 interrupted——由 runs 行 `stop_reason` 提供，node-spans 端点透出，见 ④）。

### 3.6 R8：确定性会话 + persona 冻结 + 模型 pin（`apps/gateway/src/routes/workflow-clients.ts`）

**(a) 会话身份：`deriveSessionId` 是寻址键，绝不进 `ExecOptions.resumeSessionId`（评审修订·取值单源）**：

- **两套 id 空间划界**：`deriveSessionId(runId, nodeId, ordinal): string`（SHA-1 hex 前 16 位，单测可预测——AC-R8-1）只是 **dagents 侧寻址键**——用于 `runNodeSinks` 键 `runId:nodeId:ordinal` 的确定性拼写、resume 重挂查表、插话寻址；它**不对应任何 CLI 后端会话**。后端会话 id 是另一空间：由 CLI 后端自生成（claude 从 stream 消息采集 `msg.session_id`，`packages/agent-adapters/src/claude.ts:663`，随 result 返回 `claude.ts:764`），contracts 语义即「Backend session id; pass back via ExecOptions.resumeSessionId to resume」（`packages/contracts/src/agent.ts:133-134`）。若把自铸 id 塞进 `ExecOptions.resumeSessionId`（claude 映射 `--resume <id>`，`claude.ts:114`），claude 对不存在的 resume 目标直接报错——节点首次执行即炸。
- **取值单源（与 R5 能力披露协议对齐）**：线上 `ExecOptions.resumeSessionId` **只承载后端真实会话 id**。取值链：首次 chat **不传**（`undefined`）→ 会话结束后从 `AgentResult.sessionId` 采集进会话延续表 → 同键重入（resume 重挂、platformAgent 工具循环新一轮、R5 修复轮回喂）查表命中且 kind=claude → 透传真实 backendSessionId 实现**跨进程后端会话延续**（`--resume`，每次 chat 仍是新进程——claude -p 一次问答即退，延续靠后端会话而非进程存活）；缺席 = 不传（诚实首跑，绝不伪造 resume 目标）。R5 的「chat 返回 sessionId → 修复轮透传」协议与本条是同一取值语义，字段单源。
- **会话延续表**：`runNodeSinks`（`workflow-clients.ts:60-107`）扩为 `{ runId, nodeId, ordinal, backendSessionId }`——键从 `runId:nodeId` 改 `runId:nodeId:ordinal`（PRD R8 风险条款声明的破坏性扩展），`deriveSessionId` 即键的规范拼写。`CliChatParams` 增 `ordinal?: number`（`workflow-clients.ts:154-166`）。非 claude kind 查表不透传（适配器无对应能力则诚实降级为逻辑会话重放 + 过程流 activity 行「会话重建」，AC-R8-6/R5 同款边界）。
- **跨进程重挂**：resume 重挂时进程内延续表已丢——查 `runs` 行持久化的会话映射（§1.2 的 `frozen_agents` 同批落 `sessions: { [deriveSessionId]: backendSessionId }` 载荷，或复用 journal decision 行的 session 载荷——实施时择一，写入点在 chat 收尾采集），命中得真实 id 照上条透传；未命中 = 逻辑会话重放（诚实降级）。
- `sendToRunNode(runId, nodeId, ordinal?, text)`（`:90-97`）：缺省 ordinal = 该 `runId:nodeId:*` 前缀唯一活跃实例；多实例 → 返回歧义信号，路由层 409 + 活跃实例清单（PRD R8.5 定稿）。

**(b) persona 创建期冻结**（AD-R6）：
- `assembleWorkflowEngine`（`workflow-engine-service.ts:97-251`）扫 `flowData` 的 platformAgent 节点 `agentId` 集合，run 创建期读一次 `agents` 行（复用 `createAgentFetcher` 的查询 `workflow-clients.ts:920-951`）→ 组装 `frozenAgents` 快照：①注入闭包版 `agentFetcher`（进程内冻结——run 执行中改人格不再影响本 run）；②落 `runs.frozen_agents`（首次 persistRunRow 时写入）。
- resume/answer 路径（`startWorkflowExecutionInner`）读 `runs.frozen_agents` 注入闭包 fetcher（跨进程冻结，AC-R8-2）。agent 行已删/改不影响在途与续跑 run；不回写 agents 表（与 agent-library drift 语义划界，PRD R8.2）。

**(c) resolved model 落库**：
- `prepareRequest` 返回值增 `model`（`workflow-clients.ts:874` 已解析处），HTTP 路径 chat/chatStream 把 resolved model 附在返回值；CLI 路径 resolved = `cli:${kind}`。
- `IExecutedNode` 增 `resolvedModel?: string`（节点从 llmClient 返回值带出，platform-agent/llm 节点透传）→ span-writer 落 span/journal decision `payload.resolvedModel`；执行路径终态时聚合 `runs.models`。
- `recordUsageEvent` 的 `model` 字段（`usage-events.ts:35`，现状 workflow 路径不填）填 rollup 主模型（用量最大节点的 resolvedModel）。

**(d) 模型 pin 判定与禁降级**（PRD R8.4 定稿）：
- 判定信号：flow 节点 `data.model` 非空串（llm 节点 inputs.model，`packages/workflow/src/nodes/llm/llm.node.ts:27,81`）或 agent 行 `model` 非空（fetcher 冻结快照携带）。
- 传递：`CliChatParams` 增 `modelPinned?: boolean`——llm.node 在 `inputs.model` 非空时置位；platformAgent 按 frozen agent.model 置位。
- 禁降级落点：`createDefaultLlmClient` 的 `fallbackOrRethrow`（`workflow-clients.ts:502-526`）与熔断分支（`:537-547`、`:564-574`）首查 `params.modelPinned`——pin 时**不降级**：activity 行「因 pin 拒绝降级（期望模型 X）」+ 原样抛错（错误对象挂 `providerFailure: true` 与 expected/actual model）；执行路径落 `failed(stop_reason='provider')`（R3.2 唯一归属）。未声明模型维持基线（降级保可用，CLI 第一性不破坏）。
- 等价性：`DAGENTS_DISABLE_LLM_FALLBACK` 全局闸（`:497`）语义不变，pin 是其调用粒度产品化。

**(e) 插话寻址**（`execution-message.ts:27-56`）：body 增可选 `ordinal`；`ExecutionHandle.sendToNode` 签名扩 ordinal（`execution-registry.ts:45`）；`workflows.ts` 的 execHandle（`:485-492`）与 resume 路径透传。缺省唯一实例直达；多实例 409 + 清单（客户端列供选择）。

### 3.7 R2：暖缓存重跑（run 编排层）

**(a) run body 扩展**（`workflows.ts:346-353` runBodySchema）：增 `warmFromRunId?: z.string().uuid()`（被重跑的 run）——console「暖缓存重跑」入口传当前 runId，「全新重跑」不传（缺省）。
- **谱系书写**（PRD R2.1 定稿）：暖缓存 run 写 `resumed_from_run_id = warmFromRunId`（`persistWorkflowRunRow` 现成 COALESCE 路径，`runs.repo.ts:241`）——谱系列从 resume 专用升格为暖缓存第一等公民；「全新重跑」不写谱系、零缓存。

**(b) `buildWarmCacheSeed`（新函数，`resume-execution.ts` 同文件或新 `warm-cache.ts`）**：
1. 沿 `runs.resumed_from_run_id` 链溯源至根——**经共享 lineage helper**（评审修订：与 R6 的递归 CTE 是同一条链的两处实现，抽单源）：新文件 `apps/gateway/src/lineage.ts` 导出 `runLineageChain(runId): Promise<string[]>`（含 run 自身，自根向后代或自后代向根的稳定序），**深度上限统一 16**（R6 原案 10、本方向原案 32，评审要求一致——定稿 16，两方向共同引用；防环护栏内建）。断链语义统一：链上任一 run 被 retention 清掉 → 该跳之后查不到 → 该前驱不进候选（诚实 miss，不报错，R2.6）。
2. 逐 run 查 journal decision——**经共享读侧 repo**：新文件 `apps/gateway/src/repositories/run-node-journal.repo.ts` 承载 journal 的全部读查询（`findDecisions(runId, opts)` / `findLatestDecisionByNodeAndHash(runIds, nodeId, inputHash)` / `listEventFrames(runId, {fromSeq, limit})`）；本方向 `buildResumeSeed`（③.5(a)）、`buildWarmCacheSeed`（本条）、live 404 回放（③.4(c)）与 R6 的 run-deliverables.repo **全部经此 repo 读 journal**——「journal 单点」的准确表述是**读侧列名映射/payload 形状集中在这一个 repo**（写侧在 journal-writer），不是「全 gateway 只一处触碰表名」（评审修订：R6 原表述失实，实为多读点）。查询形如 `kind='decision' AND node_id=$nodeId AND ordinal=0 AND payload->>'status' IN ('done','cached')`。
3. 对当前 flow 的每个可执行节点：用「链上前驱的输出投影」逐节点解析 resolved 输入（引擎侧跳过时同款预演，3.1(c)1）算 hash，与候选 decision 的 `payload.inputHash` 匹配 → 种子命中（取**链上最近**命中，PRD R2.1）。
   - **保守传递闭包**（R2.2）：hash 口径含上游输出（AD-R3）——上游 miss/重跑后输出变 → 下游 hash 必不匹配 → 强制重跑，无需独立传递闭包算法。传递闭包专项单测钉住（改第 3 节点 prompt → 节点 1-2 命中、3-5 全 miss）。
   - 注：解析预演需按拓扑序逐节点进行（下游的 resolved 输入依赖上游「将被使用」的输出——命中节点用旧输出、miss 节点无输出）。命中即形成一致世界线（旧输入 → 旧输出），miss 即断链（下游全 miss）。实现为拓扑序一次遍历，纯函数可单测。
4. 产出 `ResumeOptions { seedOutputs, seedHashes: {}（暖缓存不做严格校验——hash 已在匹配时用过）, seedSource: { kind:'warm-cache', fromRunId } }` + `seedRuntime` 不导入（暖缓存世界线由种子输出重建，runtime 由引擎种子机制从输出重建，`executor.ts:226-235`）。
5. **诚实 miss**（R2.6）：`runLineageChain` 断链后的前驱查不到 → 不进候选；全链 miss → 零种子全量执行，不报错（与第 1 步断链语义同一口径）。

**(c) token 记账**（PRD R2.4 定稿）：
- cached 节点不进 `executedNodes`（种子跳过路径现状即如此——push 只在真实执行 `executor.ts:611`）→ `aggregateExecutedNodesUsage`（`usage-events.ts:135-162`）天然不含种子 → `usage_events` 只记真实调用 ✓（AC-R2-3 无重复记账）。
- cached span.tokens 记继承值（前驱 decision 行的 tokens）+ journal lineage 载荷 `{ inheritedFromRunId, inheritedTokens }`（3.1(c)2 的 cached 钩子携带）。
- runs 行/结果面板双口径：「lineage 继承累计 + 本次新增」——`usage_events` 按谱系链 SUM（继承侧）+ 本 run 行（新增侧），console 展示见 ④。

**(d) 触发路径**：`POST /workflows/:id/run` 的 `runAndPersist`（`workflows.ts:496-511`）在 execute 前组装 warmCache 种子并入 `resume` 字段；resume/answer 路径不叠加（resume 已有种子）。

---

## ④ console 改动

### 4.1 终态词表单源（新文件 `apps/console/src/lib/run-status.ts`）

```ts
export const TERMINAL_RUN_STATUSES = ['completed','partial_success','budget_exceeded','failed','stopped','cancelled'] as const
export const isTerminalRunStatus = (s: string | null): boolean => ...
export const STATUS_LABEL: Record<string, string>  // 九态中文标签（stopped: '已停止'；cancelled 存量双读: '已取消'）
```

四个消费点同一批改齐（PRD R3.6；均标注**追加式/协调**——R3 是主责）：
1. **`workflow-run-card.tsx:83/87`**：三词清单扩为 `isTerminalRunStatus`——**顺带修现状轮询泄漏 bug**（chat 执行卡看 `partial_success/budget_exceeded` 终态时 700ms 轮询永不 `clearInterval`，AC-R3-4 明令不得只做双读留存泄漏）。
2. **`canvas-kit-page.tsx` watchTick 终态判定（`:388`）与旁观循环（`:702`）**：清单扩词表全集；`stopped` 分支新增——`stop_reason='interrupted'` → 「已中断」（有 checkpoint resumable → 「已中断（可恢复）」+ 沿用现有 resumeInfo 管线亮「从此处继续」，`canvas-kit-page.tsx:591-610` 的入口条件从 `runState==='failed'` 扩到 stopped；无 checkpoint → 只显示「已中断」**不渲染**入口，AC-R1-6）；`stop_reason='user'` → 「已停止」（中性色，非失败红）。
3. **`summarizeWatch`（`canvas-kit-page.tsx:355-369`）**：cancelled 不再折进 failed（`:359-362` 债务清除，AC-R3-7）；stopped/partial_success/budget_exceeded 各自如实标签。
4. **`flow-runs-panel.tsx:43-53` STATUS_LABEL**：`stopped: '已停止'` 入表（cancelled 双读保留）。

### 4.2 cached 徽章与暖缓存入口（R2，`canvas-results-panel.tsx` + `canvas-kit-page.tsx`，与 R6 同窗合并排期——NFR-5，协调标注）

- **SPAN_STATUS_MAP**（`canvas-kit-page.tsx:97`）增 `cached: 'cached'` 映射（NodeRunStatus 增态，画布徽章独立于 done——AC-R2-2）；`stopped` 增映射。
- **结果面板行级标注**：cached 节点摘要行「⚡ 来自缓存 · 继承自 {runId 短码}」（lineage 载荷）；token 徽章双口径（本次新增 N / 谱系继承 M）。
- **重跑分叉**（`canvas-results-panel.tsx:356-367` 现单按钮）：终态「重跑」拆「暖缓存重跑（默认）」与「全新重跑」——暖缓存提交时 run body 带 `warmFromRunId=activeRunId`（提交管线 `canvas-kit-page.tsx:434-518` 的直跑 fetch 分支扩展；终端 stdin 行同款 `handleRerun` `:560-563` 打开同一面板）。
- **终端视图**：cached 节点段标题行「来自缓存」（`run-terminal-format.ts` 的 commandOf `:142` 单源自动带上——cached 段的 command 显示继承前缀；不出现假 CLI 提示行，AC-R2-2）；stdin 活跃节点行显示 `nodeId[ordinal]`（R8.5，`canvas-results-panel.tsx:538-544` activeNodes 映射扩 ordinal 后缀）。
- **历史行 lineage chip**（`flow-runs-panel.tsx:226-233` 续跑 chip 同款样式模式）：「⚡ 暖缓存自 {短码}」。
- **轨迹视图**：cached 段零时长泳道段 + cached 标注（`run-trace-model.ts` 双 builder 对 `nodeEnd.status='cached'` 透传——枚举是 string，builder 现状按帧透传零改动；泳道标注在 `canvas-trace-view.tsx` 渲染层，协调标注）。

### 4.3 i18n（NFR-4，评审修订：与既有键去重）

新文案全部 `t('中文')` 自然键 + `apps/console/src/i18n/en/flows.ts` 补英文词条（现状结构 `en/flows.ts:8-10` 同款）。**既有键复用勿重加**（词典是六模块 spread 全局合并，`en/index.ts:13-19`，settings 在 flows 之后展开——跨文件同名键会被 spread 顺序静默压过；同文件重复键是 TS 编译错）：
- 「等待输入」已有（`flows.ts:201`）——`run-status.ts` 的 STATUS_LABEL 值直接用该自然键，不加词条；
- 「已取消」已有（`common.ts:170` / `chat.ts:118`）——存量 cancelled 双读标签复用；
- 「会话重建」与 R5 的服务端活动 label 同名——R5 判定该 label 是服务端过程数据不走 t()，**词条只由本方向在 flows.ts 加一处**，合并时勿两头都加。

本方向净新增词条：「已停止」「已中断」「已中断（可恢复）」「来自缓存」「暖缓存重跑」「全新重跑」「暖缓存自 {id}」「因 pin 拒绝降级」「会话重建」「预算重新起算（累计已耗 {n} tokens）」（chat.ts 的 `_(已停止)_` 是带语气标记的独立键，不冲突不复用）。

### 4.4 通知过滤（R3.6 最小实现，`use-task-notification.ts:210-259`）

`notifyOnFrame` 增 superseded 早退分支（chat 域帧若有携带）；画布 toast 链：`canvas-kit-page.tsx` 终态 toast 分支对 `stop_reason='superseded'` 静默（画布 run 现状零推送通知，该路径结构性成立；实弹验证面 = chat 通知链 + 画布 toast 链，单测/组件测口径见 ⑥）。

---

## ⑤ 兼容与存量 run 数据策略（NFR-1 对齐）

| 存量对象 | 策略 |
|---|---|
| `runs.status='cancelled'` 行 | **不迁移**（写新读旧）；读侧 `STATUS_LABEL`/`isTerminalRunStatus` 双读；DB CHECK 新词表显式保留 `cancelled`（否则 VALID 扫全表炸库，迁移 `1720000111000` 的 CHECK 直接含九值） |
| 存量 `run_node_spans` | `ordinal` 默认 0；无 inputHash → resume 种子跳过校验照旧种子化（checkpoint snapshot 兜底路径，3.5(a)）；渲染不回归（`toNodeSpanStatus` 新分支只加不改，`runs.repo.ts:35-56`） |
| `run_node_spans` status CHECK | 建表即带五值 CHECK（`1720000007000:57-58`）——放宽由 design-sharp 的 `1720000106200` 承载（词表 `+ 'rejected','cached','stopped'` 一次到位），**先于本方向第 1/4 批与 sharp 9d 任一写方合入**（§1.3 评审修订）；存量五值全部落在新词表内，无存量拒收面 |
| 存量 `run_checkpoints` | 词表零变化；boot sweep ③ 只碰 `status='running'` 的悬空行（正常终态行 terminal 单向门本就不改写，`run-checkpoints.repo.ts:24-31`） |
| 无 journal 的老 run | live 404 回退仍走 node-spans 轮询（journal 查无行 → 真回退，3.4(c) 的最终 404 分支）；轨迹 sequence 投影降级现状保留（`canvas-trace-view.tsx:140-143` 现状降级不回归） |
| 迁移 down 路径 | `1720000110000` down = DROP TABLE + 索引；`1720000111000` down = 删 stop_reason/frozen_agents/models 列 + CHECK 退回八值词表（含 cancelled，对齐 `1720000103000` 现状） |
| gateway 单测库 | `dagents_gw_test` 迁移链自动建库保持通过（vitest globalSetup 纪律，AGENTS.md）；runs 大表 ALTER（加可空列 + DEFAULT 0 列）为短事务元数据操作，长锁风险低 |
| e2e 断言 | cancelled→stopped 破坏性改名同批更新 e2e 断言与 Mock Provider 脚本（NFR-2；RM-01 `24-run-resume.spec.ts:34` 是必绿回归钉子） |
| retention | 终态清单扩全词表 + journal 级联（1.5）——否则新终态永不清（现状已欠 partial_success/budget_exceeded） |

---

## ⑥ 测试计划（对 AC 逐条）

### 单测（vitest）

| 用例 | 锚定 AC | 落点 |
|---|---|---|
| `canonicalJson`/`computeInputHash` 确定性：同输入多次同 hash；对象键序打乱不变；数组序敏感 | AC-R1-4 | `packages/workflow/src/utils/input-hash.test.ts`（新） |
| 种子跳过 hash 校验：expected/got 不一致 → 结构化失败含 nodeId + 双 hash | AC-R1-3 | `packages/workflow/src/engine/executor-semantics.test.ts`（扩展既有套件） |
| 迭代 per-ordinal 种子：3 项第 2 项项内节点短路/整项重跑边界 | AC-R1-2（引擎侧） | 同上 |
| `deriveSessionId` 确定性：同键同 id、异 run 异 id、resume 同节点同 id（寻址键口径，§3.6(a) 评审修订）；`resumeSessionId` 取值单源：首次不传、重入透传表内真实 backendSessionId、自铸 id 永不进入 ExecOptions | AC-R8-1 | `apps/gateway/src/routes/workflow-clients.test.ts`（扩展） |
| pin 禁降级：`modelPinned` 时 fallbackOrRethrow 原样抛错 + activity 行文案；未 pin 走基线 | AC-R8-3 | 同上（mock provider 故障注入） |
| 暖缓存保守闭包：改第 3 节点 prompt → 1-2 命中、3-5 全 miss（传递闭包专项） | R2.2/AC-R2-1（单测面） | `buildWarmCacheSeed` 单测（新） |
| 暖缓存对账：cached 节点零 usage_events、双口径聚合 | AC-R2-3 | `usage-events.test.ts` + warm-cache 单测 |
| `toRunStatus` 三入口一致 + RunStatus/DB CHECK 词表一致（类型测试 + 迁移测试双钉） | AC-R3-3 | `workflow-engine-service.test.ts` + `packages/db` 迁移测试 |
| `classifyAbortReason`：user/superseded 判定 | R3.2 | gateway 单测 |
| boot sweep 三步 SQL：stopped(interrupted)/spans stopped/checkpoint resumable；终态行零改写 | AC-R3-1（终态归类核验） | gateway boot sweep 测试（`index.ts` 抽函数化后可测——现状内联在启动路径，**实现时抽 `sweepDanglingExecutions` 已是函数（`index.ts:47`），补 DB 断言用例即可**） |
| seq 取号：emit 单调、`(run_id,seq)` 冲突显式报错 | AC-R7-2 | `run-live-registry.test.ts` + journal-writer 测试（新） |
| 跨源逐字节一致：帧流 vs journal 行 → 同一 `RunTraceModel`/`TerminalSection[]` | AC-R7-4 | `apps/console/src/lib/run-trace-model.test.ts`（扩展，PRD 指名的测试基建） |
| 通知抑制：注入 `stop_reason='superseded'` 帧断言通知链零触发 | AC-R3-6（最小实现阶段） | `use-task-notification` 组件测 |

### e2e（`apps/console/tests/e2e/`，Mock LLM Provider :4010 仪器）

> spec 编号（评审备注）：本方向新 spec 拟 `26-run-recovery.spec.ts`（journal resume/boot sweep/暖缓存合流一个执行态 spec；25 已被提交裁决与渐进产物两方向拟用——若三方沿用重号惯例（仓库已有双 24 先例：`24-run-resume.spec.ts` 与 `24-run-trace-view.spec.ts` 并存，Playwright 不依赖编号唯一）则编号可让位，文件名唯一即可）。

| 用例 | 锚定 AC |
|---|---|
| RM 系新用例：mock run 进行中 kill gateway（服务端日志断言「节点 N 已完成」后 kill——节点边界静默期）→ 重启 → runs 行 `(stopped, interrupted)` + checkpoint resumable → POST resume → 新 runId → mock 调用记录证明已完成节点零重调 | AC-R1-1 / AC-R3-2 |
| 任意时机 kill 的鲁棒性断言：回放 ⊇ 已收结构帧前缀、至多一条在途边界帧；delta 已落库前缀一致、尾部诚实截断 | AC-R7-1（辅） |
| 迭代 3 项第 2 项失败 → resume 只重跑 2、3 项；SQL 查 journal 每 `(nodeId, ordinal)` 一档 | AC-R1-2 |
| 5 节点链改第 3 节点 prompt 暖缓存重跑：1-2 span cached、零新增 usage tokens、mock 调用数=3 | AC-R2-1 |
| cached 徽章/终端无假 CLI 行/轨迹零时长段 | AC-R2-2 |
| 删前驱 run → 暖缓存全量重跑无 5xx | AC-R2-4 |
| 用户取消 → `(stopped, user)` + 可 resume；budget_exceeded resume 双路径（覆盖生效/缺省从零起算+黄警） | AC-R3-1 |
| stopped/cached/partial_success 终态后 `workflow-run-card` 定时器清除（组件测或 e2e 断言） | AC-R3-4 |
| 存量 cancelled 行渲染不回归；全量 e2e 改词后绿 | AC-R3-5 / NFR-2 |
| 无崩溃慢速流全程跑完：journal 零丢失（对比 live 期累计帧数）；运行结束刷新页面轨迹/终端一致、无 truncated 提示 | AC-R7-3 / AC-R7-5 |
| run 进行中改 agent 人格 → 本 run 后续节点用创建期快照（对照 run 差异） | AC-R8-2 |
| pin 模型 provider 故障 → 节点响亮失败含期望/实际模型；未声明走降级 + span resolvedModel | AC-R8-3 |
| 并发 iteration 插话带 ordinal 送达正确实例、409 清单 | AC-R8-5 |
| stopped(interrupted) 三处收尾：直跑面板/旁观/chat 卡定格；有 checkpoint 亮「从此处继续」、续跑后已完成节点徽章保持、终端无新 nodeStart 段；无 checkpoint 不渲染入口 | AC-R1-6 |

### 迁移/回归

- 迁移 up/down 双向 + `dagents_gw_test` 自动建库通过（AC-R1-5）；老 run（无 journal/hash）resume 行为不劣于现状（checkpoint 兜底路径单测）。
- `pnpm typecheck` / `pnpm lint`（console 孤儿 CSS 护栏随 lint）全绿。

---

## ⑦ 涉及文件清单（ownedFiles）

### 本方向独占

```
docs/zcode-borrow/design-recover.md
packages/db/src/migrations/1720000110000-create-run-node-journal.ts        （新）
packages/db/src/migrations/1720000111000-runs-stop-reason-and-snapshots.ts （新）
packages/db/src/entities/run-node-journal.entity.ts                        （新）
apps/gateway/src/journal-writer.ts                                         （新，写侧单点）
apps/gateway/src/repositories/run-node-journal.repo.ts                     （新，读侧单点——本方向 buildResumeSeed/buildWarmCacheSeed/live 回放与 R6 deliverables 全部经此读 journal）
apps/gateway/src/lineage.ts                                                （新，runLineageChain 共享谱系 helper——与 R6 共用，深度上限统一 16，断链=miss）
packages/workflow/src/utils/input-hash.ts                                  （新）
packages/workflow/src/utils/input-hash.test.ts                             （新）
apps/console/src/lib/run-status.ts                                         （新）
```

### 本方向独占（既有文件修改）

```
apps/gateway/src/index.ts                               （boot sweep 三件收敛）
apps/gateway/src/routes/execution-resume.ts             （resume body/闸门不变/journal 化种子入参）
apps/gateway/src/routes/resume-execution.ts             （buildResumeSeed journal 化 + toRunStatus 收敛 + buildWarmCacheSeed + tokenBudget 谱系黄警）
apps/gateway/src/routes/execution-live.ts               （404 → journal 回放）
apps/gateway/src/routes/execution-message.ts            （ordinal 寻址 + 409 清单）
apps/gateway/src/run-live-registry.ts                   （emit 取号 + finish(stopReason) + 结构帧先落库后发帧）
apps/gateway/src/retention.ts                           （终态清单扩词表 + journal 级联 + 单 run 上限）
apps/gateway/src/execution-registry.ts                  （sendToNode 签名扩 ordinal；superseded 注释锚）
apps/console/src/components/flow-runs-panel.tsx         （STATUS_LABEL 扩词 + 暖缓存 chip）
apps/console/src/components/workflow-run-card.tsx       （终态清单词表全集——修轮询泄漏，R3 主责）
```

### 共享文件（标注协调——其他方向同窗动刀，本方向改动均为**追加式**；评审修订：原列「独占」的以下文件实为多方共享，重新归类）

| 文件 | 本方向改动 | 共享方向/协调点 |
|---|---|---|
| `packages/workflow/src/engine/executor.ts` | 实例键/ordinal/种子校验/cached 钩子/迭代 per-ordinal 种子（buildNodeContext `:393-427` 透传 ordinal） | design-sharp 明列共享（重试包装 `:468-478` / runWaves catch `:633-667` / buildNodeContext trialMode 透传 `:393-427`——**与本方向 ordinal 透传同点追加，须错峰或同 PR 合并**） |
| `packages/workflow/src/types/execution.ts` | IExecutedNode.ordinal/resolvedModel；IExecutionContext.nodeOrdinal | R4（execRunner）、R5（chat 签名+verdict kind）、R10（trialMode）同文件追加——**追加式** |
| `apps/gateway/src/repositories/runs.repo.ts` | stopReason 列/toNodeSpanStatus 新词/listRunsHistory 透传 stop_reason | design-sharp（source 写侧 `:213-282` 与 trial 过滤 `:146-181`——**与本方向 stop_reason 透传同函数邻行**，同 PR 或错峰） |
| `packages/db/src/entities/run.entity.ts` | RunStatus 九态 + stop_reason/frozen_agents/models 列声明 | design-sharp（source 列声明）——**同一 entity 的列声明建议同一 PR 合并** |
| `packages/db/src/entities/run-node-span.entity.ts` | NodeSpanStatus 扩 `cached`/`stopped` | design-sharp 扩 `rejected`——**同一声明行，必须合并同一 PR**（连同 `run-live.ts` 的 nodeEnd.status 扩枚举与 `1720000106200` CHECK 词表，三方一体） |
| `apps/console/src/lib/use-task-notification.ts` | superseded 过滤 | design-sharp 9b（run-updated 分支）——**追加式** |
| `apps/console/src/i18n/en/flows.ts` | 新词条（§4.3，注意与既有键去重） | permission/sharp/artifacts 多方向都加词条——**追加式**；词典是六模块 spread 全局合并（`en/index.ts:13-19`，settings 在 flows 之后展开同名键静默压过）——跨文件同名键须复用勿重加 |
| `packages/contracts/src/run-live.ts` | seq/stopReason/cached/ordinal 四个可选字段追加 | R5（轮次可观测可能加帧字段）——**追加式**，帧形状不变是双方约束；nodeEnd.status 扩枚举与 NodeSpanStatus/CHECK 同批（见上） |
| `apps/gateway/src/routes/workflow-clients.ts` | CliChatParams 扩 ordinal/modelPinned、runNodeSinks 键扩、deriveSessionId（寻址键）、pin 禁降级、frozen fetcher | R5（CLI 会话延续/回放同文件）——**`ExecOptions.resumeSessionId` 取值单源为后端真实会话 id（§3.6(a) 评审修订），R5 透传协议与本方向查表透传是同一语义；CliChatParams 实施前一次扩齐** |
| `apps/gateway/src/routes/workflow-engine-service.ts` | toRunStatus 单源化、assembleWorkflowEngine 挂 journal-writer + persona 冻结 | R10（fake llmClient 注入位 `:108`）、R5——**注入点追加式** |
| `apps/gateway/src/routes/workflows.ts` | runBodySchema 扩 warmFromRunId/tokenBudget、runAndPersist 暖缓存种子 + stopReason 落库 | R10（试运行 run body 扩展同 schema）——**追加式** |
| `apps/gateway/src/span-writer.ts` | onNodeEnd cached/stopped 状态映射 + ordinal 标注 | R6（渐进产物）——**评审终裁：R6 按 AD-R1 对齐——span-writer 冲突目标不变（`(run_id, node_id)`，`span-writer.ts:78` 邻域）、writtenNodes 不升复合键、ordinal 只作标注列；R6 的 per-ordinal 完整事实改从 `run_node_journal` decision 行读取（其 run-deliverables.repo 即封装点），spans 投影兜底；其迭代多 ordinal 用例数据源为 journal**。本方向只改状态映射行，不动 upsert 键 |
| `apps/console/src/components/canvas/canvas-kit-page.tsx` | watchTick/spectateTick/summarizeWatch 词表全集 + stopped 分支 + 暖缓存提交 + SPAN_STATUS_MAP | R6（渐进结果区挂载点）——NFR-5 合并批 |
| `apps/console/src/components/canvas/canvas-results-panel.tsx` | cached 行标注 + 重跑分叉 + 双口径 token | R6（渐进结果聚合区）——**NFR-5 明令合并一批交付** |
| `apps/console/src/lib/run-trace-model.ts` | seq 优先排序 + cached 透传 | R6/R5（事件 kinds 白名单 `:88-96`）——追加式 |
| `apps/console/src/lib/run-terminal-format.ts` | commandOf cached 前缀 + nodeId[ordinal] | R5（轮次行）——追加式 |
| `packages/db/src/index.ts` | 新 entity 导出 | 追加式 barrel |
| `packages/workflow/src/index.ts` | 追加 `export { canonicalJson, computeInputHash } from './utils/input-hash.js'`（barrel 现状 `index.ts:48-54`） | R4（validate-topology 新规则导出同 barrel）——**追加式** |

---

## ⑧ 分步实施（地基先行）

### 第 0 批 ·【地基】契约 + 迁移 + 引擎核心（一次定稿，R1/R3/R7/R8 共享）

1. **契约**（②）：`run-live.ts` 四字段追加。
2. **迁移**（①）：`1720000110000` journal 表 + `1720000111000` runs/spans 扩列（含九值 CHECK、stop_reason CHECK）；entity 与 `packages/db/src/index.ts` 导出。
3. **引擎核心**（③.1）：`IExecutedNode.ordinal`、`RunContext.nodeOrdinals`、`buildNodeContext` 透传、`input-hash.ts` 单源 + 单测、`ResumeOptions` 扩 seedHashes/seedSource/迭代 itemNodeOutputs、种子跳过三改造（hash 校验/cached 钩子/per-ordinal 种子）。
4. **词汇单点**：TS `RunStatus` 九态 + `toRunStatus` 扩签名（单源收敛另批完成，本批先兼容旧调用）。

验收：`pnpm test`/`typecheck` 全绿；`dagents_gw_test` 迁移链通过；AC-R1-4 单测绿。

### 第 1 批 · R3 状态机（boot sweep + 写新读旧，与地基紧邻交付）

> 前置依赖：design-sharp 的 spans CHECK 放宽迁移 `1720000106200`（词表含 `'stopped'`）必须先于本批合入——boot sweep ② 的 `UPDATE run_node_spans SET status='stopped'` 在旧 CHECK 下被拒收且被每步容错吞错（§1.3）。

1. boot sweep 三件收敛（③.2）+ retention 词表/级联（①.5）。
2. cancelled→stopped 写侧 + `classifyAbortReason` + 落库点 stopReason（③.3a-c）。
3. budget_exceeded resume 双路径（③.3d）。
4. console `run-status.ts` 单源 + 四消费点改齐 + 轮询泄漏修复（④.1/4.4）+ i18n + e2e 断言改词。

验收：AC-R3-1/2/3/4/5/7（AC-R3-6 最小实现阶段面）。

### 第 2 批 · R1 journal 化 resume

1. journal-writer（decision 行 + 结构帧/delta 帧落库，③.4b）+ emit 取号（③.4a）。
2. `buildResumeSeed` 切 journal + checkpoint 兜底（③.5a）。
3. stopped(interrupted) 的 UI 入口联动（④.1 第 2 点 + ④.2 相关部分）。

验收：AC-R1-1/2/3/5/6（AC-R1-2 的引擎面在第 0 批单测已钉）。

### 第 3 批 · R7 统一回放

1. live 404 → journal 回放（③.4c）+ 单 run 上限与拒收留痕（①.5）。
2. console 轨迹/终端 seq 排序与 cached 透传（④.2）+ 跨源一致性测试（AC-R7-4）。

验收：AC-R7-1/2/3/4/5。

### 第 4 批 · R2 暖缓存

> 前置依赖：spans CHECK 放宽迁移（`1720000106200`，词表含 `'cached'`）先于本批——cached span 落库在旧 CHECK 下同样被拒收（§1.3）。

1. `buildWarmCacheSeed` + run body `warmFromRunId` + 谱系书写（③.7）。
2. cached 契约全链（span/live/journal）+ token 双口径（③.7c）。
3. console 重跑分叉/cached 徽章/lineage chip（④.2，**与 R6 渐进结果区合并同 PR 交付**——NFR-5）。

验收：AC-R2-1/2/3/4/5。

### 第 5 批 · R8 会话身份与 pin

1. `deriveSessionId`（寻址键）+ runNodeSinks 键扩 + 真实 backendSessionId 采集/查表透传（claude 跨进程 `--resume` 延续）/其余降级（③.6a 评审修订口径）。
2. persona 冻结（frozen_agents）+ resolved model 落库（③.6b-c）。
3. pin 判定与禁降级（③.6d）+ 插话 ordinal 寻址（③.6e）+ console stdin 行（④.2）。

验收：AC-R8-1/2/3/4/5/6。（与 R5 的 workflow-clients 会话延续改造在实施前对齐 CliChatParams 一次扩齐——⑦ 共享表。）

---

## 附：与 PRD 开放问题的对账

| OQ | 本文裁决 |
|---|---|
| OQ-1 journal 表选址 | 新表 `run_node_journal`，R1 决策 + R7 事件同表（AD-R1/R2）；spans 降格观测投影 |
| OQ-6 persona 冻结载体 | `runs.frozen_agents` JSONB（AD-R6） |
| OQ-7 errored/failed 并轨 | 维持 PRD 定稿：保留 `failed`，来源分类由 `stop_reason ∈ {model, provider}` 承担（①.2） |
| OQ-5 chat 路径可恢复 | 维持 P0 不纳入；boot sweep 对无 checkpoint run 诚实标 `stopped(interrupted)` 但 UI 不渲染恢复入口（③.2/④.1） |
| OQ-2 通知载体 | 不在本文范围（R9b）；最小实现 = runEnd 帧 stopReason + 客户端过滤（③.3e/④.4） |
