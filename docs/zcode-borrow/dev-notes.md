# dev-notes —— 各方向实现边界与集成须知

> 结构约定：每个方向一节，记录「本批做了什么 / 没做什么（下一阶段的边界）/
> 给集成工程师的注意事项」。并行方向各自追加自己的节，互不改写。

---

## 可恢复性 · 地基批次（2026-10-07，cluster: 可恢复性-地基）

对照 `docs/zcode-borrow/design-recover.md` 第 ⑧ 节「第 0 批【地基】」+ 任务
点名的 boot sweep 三件收敛（第 1 批的核心前置件，design §3.2）。

### 本批落地

1. **契约**（§②，`packages/contracts/src/run-live.ts`）：`RunLiveAt.seq`、
   `nodeEnd.status` 扩 `'cached'`、`runEnd.stopReason`、`nodeStart/nodeEnd.ordinal`
   四个可选字段追加 + 头注释补「journal 是帧流持久层」。帧形状不变，
   console 零改动兼容（`TerminalSection.status` 等均为 string 透传，已核）。
2. **迁移**（§①）：
   - `1720000110000-create-run-node-journal.ts`：`run_node_journal` 表 +
     `(run_id,seq)` / decision 部分唯一 / lookup 三索引，DDL 逐字对齐设计。
   - `1720000111000-runs-stop-reason-and-snapshots.ts`：runs 加
     `stop_reason`（五值 CHECK）+ 九值 status CHECK 重建（cancelled 显式保留）
     + `frozen_agents`/`models` JSONB；spans 加 `ordinal` 标注列（唯一索引不动）。
   - **`1720000106200-widen-run-node-spans-status-chk.ts`（三方共同前置，本批
     一并落地）**：词表一次放宽 `+ 'rejected','cached','stopped'`，内容逐字对齐
     design-sharp §1.2 的定稿范式。⚠️ 该迁移设计上由 design-sharp 方向持有，
     但它是本方向 boot sweep 写 `stopped` / cached 钩子落 span 的**硬前置**
     （「迁移先行、写方随后」），仓库当时不存在该文件——本批按定稿内容创建。
     **若 sharp 方向并行交付同文件，集成时二选一（内容应逐字一致）**。
3. **entity/barrel**：`run-node-journal.entity.ts`（新）、`RunStatus` 九态 +
   `RunStopReason` + `stop_reason/frozen_agents/models` 列声明、
   `NodeSpanStatus` 扩 `cached/stopped` + spans `ordinal` 列、
   `packages/db/src/index.ts` 追加导出。
4. **引擎核心**（§③.1，`packages/workflow`）：
   - `IExecutedNode.ordinal`（必填）+ `IExecutionContext.nodeOrdinal` +
     `ExecutionStatus` 扩 `'cached'`；`RunContext.nodeOrdinals` per-node 计数器
     （AD-R4：节点开始执行/种子占位时 takeOrdinal）。
   - `utils/input-hash.ts`：`canonicalJson`/`computeInputHash`/
     `NON_DETERMINISTIC_KEYS`（初始空台账）+ 单测（AC-R1-4）；barrel 导出。
   - `ResumeOptions` 扩 `seedHashes`/`seedSource`；`IterationProgress` 扩
     `itemNodeOutputs`（gateway 从 journal 组装传入，引擎只消费 + 快照透传）。
   - **种子跳过三改造**：① hash 对账（种子带 hash 时 mergeInputs +
     resolveVariables 预演重算，不一致抛 `SeedHashMismatchError` → run failed，
     AC-R1-3）；② cached 钩子回放（跳过时发 `onNodeEnd(status:'cached')` +
     journal cached decision 带 lineage）；③ 迭代体 per-ordinal 种子
     （`runWaves` 增 `preseeded` 显式参数，串行路径按项预填短路）。
   - **JournalFacade 接缝**（§3.1(e)）：`ExecuteOptions.journal`（宿主注入，
     引擎 DB-free）：done/failed/cached 终态 `recordDecision`（含 inputHash）；
     `lookup(nodeId, ordinal)` 预留给迭代断点项短路（第 2 批 gateway 接线）。
5. **词汇单点**：`toRunStatus` 返回形状扩为 `{ status: RunStatus;
   stopReason?: RunStopReason }`——**本批兼容旧调用**（cancelled 仍翻
   cancelled，写新翻转是第 1 批），三个旧调用点改取 `.status` 行为不变。
6. **boot sweep**（§3.2，任务点名）：从 `index.ts` 内联抽出
   `apps/gateway/src/boot-sweep.ts`（可测化）+ 三件收敛：① runs 在途 →
   `stopped`+`stop_reason='interrupted'`；② 悬空 running span → `stopped`；
   ③ 悬空 running checkpoint → `resumable`。终态行零改写；awaiting 超时收敛
   维持 failed（设计裁决保守不动）。
7. **写侧映射随写方改齐**（§1.3）：`toNodeSpanStatus` + `cached/stopped`
   分支、`span-writer.ts` 的 cached span 终态映射（只改映射行不动 upsert 键）、
   `run-live-registry.ts` nodeEnd cached 帧映射 + nodeStart/nodeEnd ordinal
   帧透传。

### 明确不做（下一阶段边界，routes/console 为主）

- **第 1 批余项**：cancelled→stopped 写新翻转（`classifyAbortReason` +
  落库点 stopReason + `resume-execution.ts:319` 手写映射收敛）、
  `persistWorkflowRunRow` 的 stopReason 参数、budget_exceeded resume 双路径、
  retention 词表/级联扩展、console `run-status.ts` 单源与四消费点、i18n。
- **第 2 批**：journal-writer（写侧单点 `apps/gateway/src/journal-writer.ts`）
  与 live registry emit 取号（seq 落库/回放）、`run-node-journal.repo.ts`
  读侧、`buildResumeSeed` 切 journal、execution-live 404 回放、共享
  `lineage.ts`。**引擎的 JournalFacade 已就位**——journal-writer 落地时实现
  `recordDecision/lookup` 注入 `ExecuteOptions.journal` 即可，注意迭代控制器
  的 onNodeEnd 会**二次触发**（体内完成后重发，见 executor.ts 控制器段），
  writer 需按 `(nodeId, ordinal)` 幂等 upsert（decision 部分唯一索引是兜底）。
- **第 3/4/5 批**：统一回放、暖缓存（`buildWarmCacheSeed`/`warmFromRunId`）、
  R8 会话身份/pin——本批只铺了契约与引擎机制。
- **console**：`SPAN_STATUS_MAP` 未加 `cached/stopped` 映射（cached span 在
  画布上暂不显示独立徽章——`SPAN_STATUS_MAP[s.status]` 返回 undefined，
  徽章保持原态，不报错）；结果面板/轨迹的 cached 标注、stopped 分支 UI、
  「已中断（可恢复）」入口、i18n 词条全部留给 console 批次（第 4 批 + ④）。

### 已知取舍 / 注意事项

- resume 路径（现状 checkpoint 种子，无 seedHashes）在续跑时会为种子节点发
  `onNodeEnd(cached)` → span-writer 落 **cached** span（此前无 span 行）。
  e2e `24-run-resume.spec.ts` 的「已完成节点零重调」断言按 mock 调用计数，
  不受影响；若 e2e 有 span 状态断言需随第 2 批改词时一并核对。
- `frozen_agents.sessions` 会话映射载荷（§1.2 的「实施时择一」）未写入——
  R8 第 5 批落 claude 真实 backendSessionId 采集时择一实现。
- `IExecutedNode.ordinal` 为**必填**（设计口径 `ordinal: number`）——其他
  方向若新增 IExecutedNode 构造点需补该字段（本批已改齐全部既有构造点：
  executor 两处 + gateway span-writer.test 三处字面量）。
