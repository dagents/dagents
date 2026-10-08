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

## 提交裁决 · R5（2026-10-08，cluster: 提交裁决）

对照 `docs/zcode-borrow/design-verdict.md` 全量落地（分步 ①②③④ 一次交付）。

### 本批落地

1. **契约/校验器（workflow 包）**：
   - `json-schema-lite.ts`：`SchemaIssue` 追加可选 `expected/got`，五类分支
     （type/enum/长度/边界/必填缺失）逐分支填充——判定逻辑与 message 语义
     零改动，`llm.node` 既有修复回路零回归；新增 `json-schema-lite.test.ts`
     （7 测）。
   - `types/execution.ts` 三处追加：`IStreamActivityKind` + `'verdict'`
     （注释补与 contracts `RunLiveDelta` 的人肉同步纪律）；llmClient.chat
     params + `resumeSessionId?: string`（取值单源注释：只承载上一轮 chat
     返回的后端真实会话 id，严禁注入宿主自铸 id）；chat 返回 +
     `sessionId?: string`（能力披露协议）。
2. **裁决状态机（platform-agent.node.ts）**：现有工具循环提为私有
   `runToolLoop()`（纯搬运，返回 `{finalText, truncated, usage, sessionId}`，
   truncated=原尾注分支条件）；声明 outputSchema 时外包三值裁决循环——
   accept（输出带 `json`，`{{id.json}}` 可引用）/ violations（回喂
   path/期望/实际 修复，至多一次）/ no-deliverable（NUDGE 追问，至多一次，
   同型耗尽退用另一型），预算 `VERDICT_MAX_INTERACTIONS=3` 硬编码导出、
   无 env；截断优先于文本内容；schema 契约块编进 system 头（resume 轮 CLI
   会话自持不重复注入）；修复/NUDGE 轮不传 tools；裁决轮次活动
   kind:'verdict' 经 onNodeDelta → span events/run-live（不新开 span 段），
   首轮直收零活动；未声明 outputSchema 走原路径逐字节不变（尾注/空守卫）。
   单测扩展 8 例（accept 直收/修复回喂三元组/NUDGE/截断优先/两轮耗尽/
   预算钉死 3 与 2/会话延续两档对照/非法 schema），含既有 3 回归共 11 绿。
3. **gateway 接线（workflow-clients.ts 四小处）**：`CliChatParams` +
   `resumeSessionId`（只透传不换算）；`startSession` 透传进 `ExecOptions`
   （claude `--resume` 生效，其余适配器忽略）；chat 返回 +
   `result.sessionId`；`createDefaultLlmClient`/降级路径签名同步放宽
   （params 整体转交天然透传）。HTTP `createLlmClient` 返回不带 sessionId
   （无状态后端诚实缺席）。新增 `workflow-clients-resume.test.ts`（2 测，
   mock backend 断 execute 参数与回传）。
4. **console 白名单 + 样式**：`run-terminal-format.ts`（TerminalLineKind/
   LINE_KINDS）、`run-trace-model.ts`（TRACE_LINE_KINDS）、
   `canvas-results-panel.tsx`（ActivityKind/ACTIVITY_KINDS + activityIcon
   verdict→'check'）、`run-terminal.tsx`（lineIcon case + LineView verdict
   折叠行，`rtl-verdline` 用 `--success-text` 与 status 行分流；图标用
   `.ic-12` 工具类过内联样式棘轮）+ `run-terminal.css` 就近类。零新 t()
   词条（设计 §4 定稿：无新界面文案面）。
5. **e2e**：新增 `25-agent-verdict.spec.ts`——AC-R5-1（修复回喂含
   path/期望/实际 + 上游零重调 + 修复轮禁工具）、AC-R5-4 e2e 面（回放档
   「会话重建」活动行 + verdict 行落 span events + output.json）、
   AC-R5-6 e2e 面（恒违规恰 3 次调用、span error 含 path）、AC-R5-5
   （inspector outputSchema json 控件 + 失败摘要 `canvas-result-err-inline`）。
   **未跑**（需 gateway/console dev server，本批约束禁启）——集成期跑。

### 明确不做 / 边界

- `agent-adapters`/`@dagents/contracts` 零改动（F3 红利：`--resume` 与
  `AgentResult.sessionId` 已就位）。
- 不进 `validateFlowTopology`、不教 flow-generator 产 outputSchema
  （设计 §3.3 定稿）。
- AC-R5-2（claude 档 --resume 同会话）单测层已钉（两档对照里 A 档），
  真机 smoke 扩展未做（设计 §6.2 标可选，`scripts/real-cli-smoke.sh`
  属可恢复性/适配器域既有脚本）。
- LLM 节点的一轮修复预算（`llm.node.ts` attempt<2）零改动（回归基线）。

### 已知取舍 / 给集成工程师

- **回喂选择细化**（对设计 §3.1 伪码的一处落地修正）：violations 二次
  发生且 repair 已用时**退用 NUDGE**（而非立即失败）——设计 §6.1 测试
  计划钉死「恒违规恰 3 次（原始+修复+NUDGE）」与「恒空文本恰 2 次」，
  严格按伪码 else-throw 会得 2/2，与测试计划矛盾；已按测试计划实现，
  两计数单测均钉。
- **共享文件当前 diff 状态**：`workflow-clients.ts` / `execution.ts` /
  `node-registry-canvas.ts` / console 四白名单文件多方向同文件追加，本批
  改动均为追加式（IStreamActivityKind 词表行、白名单数组、platformAgent
  注册段）；合并时按行级对账即可。
- **本批运行时观察**（共享工作区，非本方向造成）：批初 workflow 包有
  4 个测试文件挂（`executor.ts` 重构缺 `this.` + R4 权限方向的
  `validate-topology.ts`↔`flow-permissions.ts`↔`nodes/index` 循环引用）、
  gateway 有 9 个 in-flight 文件类型错误——**批末复核均已被并行方向自愈**
  （executor typecheck 归零、循环引用解除、gateway 仅剩 journal-writer/
  trial 等他方向文件报错）。终态：workflow 套件 31/32 文件绿，唯一失败
  `custom-function.node.test.ts:77`「静态元数据 inputs 数 2≠3」是 R4 方向
  给 custom-function 加了权限入参未同步测试，与本方向无关；本方向 30 项
  目标单测 + console 全套（42 文件 447 测）+ 孤儿 CSS 检查全绿。
- `IStreamActivityKind` 若 R4/R10 同批加词，同一 PR 合并为宜（设计 §7-6）。

### 测试补齐批（2026-10-08，cluster: 提交裁决）

在集成收口（74758e6）之后的缺口上补 vitest——集成批已覆盖 console 白名单
（run-terminal-format/run-trace-model 的 verdict describe）与 span-writer
mock 层钉子，本批补三块：

1. **引擎边角 4 例**（`platform-agent.node.test.ts`，现 15 测全绿）：对象
   形态 outputSchema（画布 json 控件合法提交即对象）同样激活裁决循环；
   非 JSON 纯文本 → adjudicate catch 分支合成 `$：期望 JSON 对象` issue
   （got 前 80 字）；围栏 ```json 直收（extractJsonFromText 容忍在裁决
   路径生效）；**resume 失守回落回放**（中间轮不回 sessionId → 后续轮
   全量重放 + 会话重建留痕——lastSessionId 严格赋值语义的钉子，已做
   mutation 验证：改回「仅有值时覆盖」恰好只红这一测）。
2. **gateway 真库 1 例**（新 `span-writer-verdict-db.test.ts`，走
   dagents_gw_test globalSetup）：verdict 活动经 span-writer 终态合并落
   `run_node_spans.output` JSONB——events 全量 + activity 环（status 噪音
   不进环）+ 产出 json 字段共存一行；fire-and-forget 写入链用 expect.poll
   等终态。⚠️ 必须在 `apps/gateway` 目录内跑（根目录跑不加载 globalSetup，
   assertTestDatabase 会如实拒绝——护栏已实测生效）。
3. **run-live 透传 1 例**（`run-live.test.ts` 追加 describe，现 18 测全
   绿）：activity kind:'verdict' 原样入缓冲/回放（宽松 string 契约 F9 的
   「零变更」钉子；label/detail 保真 + at 打点同款）。
   注：该文件存在**先于本批**的 prettier 偏差（288/302 行既有代码），本批
   只追加不重排，未批量格式化。

本批定向自证：workflow 2 文件 22 测 + gateway 4 文件 34 测 + console 2
文件 45 测全绿；workflow 包 tsc 零错误；改动文件 eslint/prettier 干净。

---

## 渐进产物 · R6 全量交付（2026-10-08，cluster: 渐进产物）

对照 `docs/zcode-borrow/design-artifacts.md` §⑧ 步骤 1-5 全部落
（词表扩展与 AC-R6-3 的前置均已由可恢复性地基批次满足，本批直接取
`DELIVERABLE_STATUSES = ['done','cached']`）。

### 本批落地

1. **契约**（§②）：`packages/contracts/src/run-deliverables.ts` 新建——
   `DeliverableItem` 九字段 / `DELIVERABLE_STATUSES` 词表单源 /
   `extractDeliverableText`（自 console `extractOutputText` 原样上移，
   语义逐字不变）；barrel `index.ts` 追加一行（与 sharp 的 trial-run 同
   文件共存）。console `run-terminal-format.ts` 改 re-export 旧名，
   既有 import 面（canvas-results-panel / spanToTerminalSection 内部）
   零改动。
2. **读路径单点**（§③-2）：`apps/gateway/src/repositories/run-deliverables.repo.ts`
   新建——journal 主路（decision 行 payload 自足，label/type LEFT JOIN
   spans 借观测投影元数据；**零 journal decision 行才回退 spans**，有
   decision 行即 journal 权威，全 failed 的 run 诚实空清单不回退造数）；
   `projectDeliverableRows` / `buildRunDeliverables` 纯函数；无任何跨 run
   谱系遍历（v1.1 撤回口径——继承标注只透传 payload.lineage）。
3. **交付面**（§③-3/③-4/③-5）：node-spans 端点信封加 `deliverables`
   （读失败字段缺席→console 聚合区不渲染的诚实降级）；终态六分支
   （awaiting/completed/partial_success/budget_exceeded/cancelled/fail
   detail）全部携带；metrics `dagents_run_deliverables_items_total{source=
   journal|spans|response}`（按 metrics.ts:9 反向依赖纪律声明在 repo 文件
   而非 metrics.ts——先例 workflow-engine-service.ts:36-50，§③-5 文字与
   metrics.ts 自身架构冲突时从架构）。
4. **console 聚合区**（§④）：摘要视图顶部「产出清单」折叠卡（默认展开；
   三视图框架不动）；拓扑序重排（服务端按实例键序）；迭代多 ordinal 聚
   一行 + 「第 k/n 项」；继承 chip（inheritedFromRunId 短码）/ 子流程 chip
   （subflowName）；未完成显式标注（未执行/执行中/等待输入——**失败节点
   不进灰行**，它执行过了，失败态在下方节点行）；复制（clipboard）/
   下载（deliverables-{runId 短码}.md）；行内「终端」→ switchResultView +
   双 rAF 滚到 `[data-terminal-section]`（run-terminal.tsx SectionView 新
   data 属性，纯属性 chat 面无感）。`node-spans.ts` envelope/result 加
   `deliverables`（null=旧网关）。CSS 追加 canvas-results.css；i18n 词条
   入 en/flows.ts（「等待输入」「终端」复用既有键未重加）。
5. **测试**：contracts 12 用例（搬家回归钉子）；gateway 15 用例（纯函数 +
   真库 dagents_gw_test：journal 主路/权威空清单/兜底切换/子流程 text cast
   join/cached lineage 透传 + 端点接线 + customFunction 确定性失败的
   AC-R6-1 形态钉子）；console lib 追加（transcript + AC-R6-4 同一函数
   对象钉子）；e2e `26-run-deliverables.spec.ts` 4 用例。

### 实测状态（2026-10-08，共享 dev 栈）

- 单测三件套全绿：contracts 20/20（`pnpm --filter @dagents/contracts test`）、
  gateway 15/15（`apps/gateway` vitest run run-deliverables）、console
  20/20（run-terminal-format + i18n-keys）。
- **e2e 26 号 4/4 全绿**（DL-01 失败抢救投影+runs.output 无产出 / DL-02
  同步响应体 / DL-03 中途取消聚合区 / DL-04 子流程 chip+终端锚点）。
- **`24-run-resume.spec.ts` 当前红**（RM-01/02/03）——归因**不在本方向**：
  resume 链路正被可恢复性第 2 批在途重写（journal-writer.ts /
  run-node-journal.repo.ts / execution-resume.ts 落树未稳）+ 共享 dev
  gateway 因多方向持续编辑每 20-60s 重启。本方向 diff 与 resume/
  checkpoint/seed 代码零交集（只读投影 + 追加响应字段 + console UI）。
  **集成工程师请在其第 2 批稳定后重跑 24 号确认回绿**；22-run-terminal-view
  已同步实测绿。
- `runs.output` 断言语义修正：落库形态是 `JSON.stringify(null)` 即 jsonb
  null 标量而非 SQL NULL——AC-R6-1 的「无产出」断言写成了
  `(output IS NULL OR output = 'null'::jsonb)`（e2e 与 gateway 测试同口径）。

### 给集成工程师的注意事项

- **共享文件多方向同批动刀**：`node-spans.ts` 的 result 同时含 R10 的
  `runSource` 与本方向 `deliverables`（合并无冲突，已实测共存）；
  `run-terminal-format.ts` 同时含 R5 的 verdict 行（本方向只加了 re-export
  import 与 buildDeliverablesTranscript）。`canvas-results-panel.tsx` 的
  NFR-5 合并批（R2 cached 徽章 / R3 stopped 标签）尚未进场——本方向的
  聚合卡是独立 `<details>` 子树，行级状态改动与其正交。
- **journal 主路对 journal-writer 的依赖**：可恢复性第 2 批的 journal-writer
  落地前，所有 run 自动走 spans 兜底路（行为可用，迭代体仅末次）；
  journal-writer 合入后自动切主路，`/metrics` 的
  `{source="spans"}` 计数应趋零——这是切换是否生效的观测锚点。
- 本批曾因重建 contracts/workflow/db 的 dist 触发共享 dev gateway 的
  tsx watch 重启（AGENTS.md 已知问题；动手前已核实零在途 run）。期间
  发现 dev 库缺 `1720000106000-add-runs-source`（R10 迁移在 src 不在
  dist），已按 `pnpm --filter @dagents/db migrate` 正规通道补齐 dev 库
  ——请 R10 方向知悉（restart-gateway.sh 本会自动做同样的事）。


---

## 权限闭环 · R4 批次（2026-10-08，cluster: 权限闭环）

对照 `docs/zcode-borrow/design-permission.md` §8 五步全量落地（第 0-4 步 +
翻转步的前置机制；OQ-4 翻转本身不做，默认仍 `warn`）。

### 本批落地

1. **权限单源**（§2.3）：`packages/workflow/src/utils/flow-permissions.ts`——
   读/验/判/投影唯一实现（readNodePermission 语义阶梯：absent / declared
   （含 `[]` declared-empty）/ invalid；条目格式；域名守卫判定表 + 策略
   `DAGENTS_HTTP_DOMAIN_POLICY`；`extractFlowPermissions` 全图投影 +
   `validatePermissionDeclarations`）。barrel 全量导出；`@dagents/contracts`
   flow.ts 追加 `NodePermissionDeclarations`（纯类型）。
2. **http 域名守卫**（§3.1）：首跳 + 重定向逐跳（协议 → SSRF → 域名 →
   fetch 定序，为 design-sharp 的 trialMode skip 留位——skip 落地时须在
   域名守卫**之后**短路）；warn 缺席放行发 `onNodeDelta` log 活动行留痕。
3. **受控命令通道**（§3.2）：`user-code-exec.ts` 异步契约扩展（Promise.resolve
   包装）+ `$exec` worker RPC（白名单持有方 = 父侧节点 data，绝不信任
   worker 消息；settle 时 abort 全部在途 exec）；`custom-function.node.ts`
   接线（invalid 全拒 + `$exec is not a function` 翻译成结构化指引 +
   tool/tool_result 活动行）；gateway `lib/controlled-exec.ts`（白名单二次
   复核 → CLI spawn 闸 → resolveCliExecutable → viaShell 拒 → no-shell
   spawn → 超时两段强杀 → 32KB 截断）；`workflow-engine-service.ts`
   baseOptions 一处注入 execRunner。
4. **路由门**（§3.3）：保存门（POST/PUT 422 只拒声明非法，草稿自由不扩大）；
   运行门（invalid 422 / enforce+缺席 400 / warn 计数）；闭合集非空 run 落
   `workflow.run` 审计行。指标 `dagents_custom_exec_total{result=…}` 与
   `dagents_permission_undeclared_http_runs_total` 在 metrics.ts 统一声明。
5. **生成器**（§3.4）：prompt 两条规则 + `scanGeneratedFlowRisks` 三类新
   warning（未声明域名 / 静态 URL ∉ 清单——**模板变量 URL 显式跳过**，实测
   `new URL('https://{{host}}/x')` 能解析成字面 hostname，不能靠解析失败
   兜底 / `$exec` 未声明）。修复循环经 `validateFlowTopology` 自动生效。
6. **console 确认面**（§4）：`run-permission-summary.tsx` + 就近 css（孤儿
   护栏合规），挂运行输入面板 HumanInput 预答区之后；数据源与执行层同一
   `extractFlowPermissions`（AC-R4-4）；无权限面时组件自渲染 null。i18n
   词条 10 条进 `en/flows.ts`（对 settings/chat/common 查重零同字面）。
7. **模板仪器**（§6.3）：`builtin-templates.test.ts` 追加 gate 断言（现状
   10 内置模板零 http/customFunction 节点，断言空转通过）；
   `scripts/scan-template-permissions.mjs`（内置 JSON + flow_templates 表
   扫描，缺席仅报告不阻断，exit 1 仅当扫描本身失败——已实跑 exit=0）。
8. **e2e**：`apps/console/tests/e2e/28-permission-guard.spec.ts`（PG-01
   declared-but-violated 零网络确定性 / PG-02 $exec 放行+拒绝两路径（真
   spawn `node -e`）/ PG-03 确认面选择器断言）——3 用例本机实跑全过。

### 与设计的实现偏差（均已在代码注释注明）

- **executor.ts 追加两处**（设计 §7 文件清单未列 executor）：`ExecuteOptions`
  +`execRunner` 字段、`buildNodeContext` 透传——设计假设节点能从 options
  读到 execRunner，但 executor 是显式字段表构造（`historyRetriever`/
  `flowExecutor` 同款接缝清单），不补线则节点恒 undefined（e2e PG-02 实测
  逮出）。**R5/R8 同文件动作者注意**：buildNodeContext 的接缝清单新增了
  execRunner 一行。
- **treeKill 未从 `@dagents/agent-adapters` barrel 导出**（exports 只有 "."，
  本方向无权动该 barrel）：controlled-exec.ts 内镜像实现 `taskkillTree`
  （win32 taskkill /T /F，POSIX 无操作，语义同 win-spawn.ts:98-114）。
- **`extractFlowPermissions` 投影多两字段**（additive）：`hasSubflow`（§3.7
  「子流程声明以子流程画布为准」的确认面标注依据）与 domainNodes[].url
  （§4.1 静态 URL 比对的 UI 数据源）。
- **确认面数据源 keyed `runPanelOpen`**（设计建议 flowDataVersion dep——
  页面无此状态）：面板打开瞬间读 `editorRef.current?.getDocument()`（活文档），
  与 humanSpecs 的 initialFlow 先例同取舍（运行执行已保存文档，未保存改动
  按面板所见提示）。
- **同源钉子测试**（§6.1）用与 executor `mergedNodeInputs` 相同规则构造
  merge 后对照 `parsePermissionValue`——非直接 import 私有函数（未导出）。

### 给集成工程师的注意事项

- **[与 R9d 的词汇冲突，需裁决]**：`docs/workflow-engine.md` 的 R9d 对照表
  写了「R4 白名单拒绝……错误文案首词统一『节点被拒绝：』+ span status
  `'rejected'`」；本方向按 design-permission.md §1.3/§9 落的是**节点抛错 →
  span `'failed'` + 零新 status 值**（该设计明确「R9d 对照表落档时按节点
  拒绝档归类、不预写 R9 的表」）。二选一：若采 R9d 词汇，改
  `http.node.ts`/`custom-function.node.ts` 错误文案前缀 + span 状态映射
  （属 R9d 管道的 NodeRejectedError/isolateFailure 语义，非本方向实现）；
  若维持 R4 现状，更新 R9d 表中 R4 行为「span failed」。**不要双写**。
- **`$exec` 长命令与 worker 超时的已知交互**：在途 exec 受
  `CUSTOM_FN_TIMEOUT_MS`（默认 5s）级联 abort——接近 60s 上限的长 exec 会被
  worker 超时先杀，需同步调大该 env。设计未裁决此交互，v1 如实保留。
- **e2e/真跑前提**：gateway 需已加载新 `@dagents/workflow` dist（tsx watch
  会因 dist 重建自动重启；本方向两次重建 dist 期间 dev stack 无在途 run，
  已核对 `dagents_cli_spawn_active 0` 才动手）。
- **gateway 单测**：`workflow-permissions.test.ts` 走 `app.request()` 真库
  （globalSetup 钉 `dagents_gw_test`）；`controlled-exec.test.ts` 真 spawn
  `node -e`（亚秒级）且 vi.mock `@dagents/agent-adapters` 驱动 viaShell
  分支——同文件图内其他 agent-adapters 消费者若后续加入会共享该 mock。
- **audit**：新 action `workflow.run`（闭合集非空才记——低频不淹日志）；
  `audit_log.target_id` 是 text 列不是 uuid（测试里踩过 `$1::uuid` 类型错）。
- **http.node.ts 定序**：本方向域名守卫已按「协议 → SSRF → 域名 →
  （trialMode skip 落位处）→ fetch」铺好；design-sharp 落 skip 分支时放
  域名守卫之后即可，同缝互认已在两设计文档头注释写死。
- 小项：i18n 缺译扫描当前红的唯一缺项是 R10 新组件
  `trial-run-panel.tsx` 的「启动失败」（components/canvas/，不在本方向
  文件清单内未代改）——R10 方向补 `en/flows.ts` 词条即可回绿。

---

## 工程决策与试运行 · 首批全量（2026-10-07/08，cluster: 工程决策开发）

对照 `docs/zcode-borrow/design-sharp.md` §8 九步实施，R9（9a/9b/9c/9d）+
R10（引擎件/gateway/console/e2e）**全部落地**。

### 本批落地

1. **【地基 A 契约】**：`run-live.ts` nodeEnd.status + `'rejected'`；
   `run-node-span.entity.ts` NodeSpanStatus + `'rejected'`（词表已被
   地基批的 1720000106200 迁移承载，直接可用）；`ws.ts` run-updated
   激活（扩 flowId/stopReason，头注释更新为「已激活」）；新
   `packages/contracts/src/trial-run.ts`（TrialMockRule/Script/ScriptSet/
   TrialRunRequest/Response/TrialMockCall）+ barrel 挂载。
2. **【地基 B 迁移】**：新 `1720000106000-add-runs-source.ts`（nullable
   text 列 + 存量 chat_id 派生回填 + trial 部分索引，down 完整）；
   run.entity 加 `source` 列声明；写侧四路径实写——画布直跑
   persist/initAsync `'canvas'`、resume/answer 闭包 `req.source ?? 'resume'`
   （execution-resume 两调用点显式传 'resume'/'answer'，answerAwaiting
   回流也传 'answer'）、upsertChatWorkflowRunRow 缺省 'chat'、试运行
   `'trial'`（COALESCE 保已存值）；读侧 `listRunsHistory` 缺省
   `IS DISTINCT FROM 'trial'` + `?source=` 正向查询；runs.ts source 改
   COALESCE 派生兜底；node-spans 响应与 fetchRunNodeSpans 信封新增
   `runSource`（结果面板试运行标记条数据源）。
3. **【R9a】**：ADR
   `docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md`
   （持久表只会说谎论证 / 双轨边界判据表 / 红线适用范围含 trial-registry
   与 run-notify claim / 补偿机制 / 修订记录位）；human-input.ts /
   execution-registry.ts / resume-execution.ts 三处注释互引；
   workflow-engine.md 挂 ADR 链接。
4. **【R9c】**：validate-topology `TopologyError` 加 `severity?/
   repair?`；TopologyResult ok:true 分支也带 `errors`（仅 repairable 条
   目）——ok 判决只看 error 档；platformAgent 无 agentId 从 warning 升
   repairable（repair='在右侧 Inspector 为该节点选择一个 Agent'）；新规则
   「模板占位符引用未知名」（深扫 node.data 全字符串，已知根键白名单
   start/flow/iteration 四键/humanInputs，$ 前缀剥除）；gateway 透传自动
   成立（字段随对象序列化，flow-generator 无需改）；console 保存校验
   fatal/repairable 分流呈现（红 toast+红标 vs 不吓人 toast+黄警 waiting
   标记），`en/flows.ts` 补词条。
5. **【R9d】**：`NodeRejectedError`（errors.ts，AC-R9-5 首词「节点被
   拒绝：」）；三来源改抛——iteration.node 主抛点 + executor 兜底（带
   rejected 标记走 isolatedFailures）、子流程深度守卫、retries≥1 耗尽
   包装（cause 挂原始错误；**retries=0 直抛不变**）；runWaves catch 按
   错误类型分类（isolated 恒真 + span 'rejected'）；span 状态映射四处
   改齐（spanEndStatus / toNodeSpanStatus / workflows 批量补写 /
   run-live nodeEnd 帧）；上限对照表落 workflow-engine.md；console
   rejected 行态（黄点 + 左边框 + 「已拒绝（可重试）」meta）+
   SPAN_STATUS_MAP rejected→waiting。
6. **【R10 引擎件】**：ExecuteOptions/IExecutionContext 加 `trialMode`
   （buildNodeContext 透传）；http.node skip 分支（**全部静态校验后、
   fetch 前**——R4 域名守卫已落，skip 紧随其后，定序与两设计一致）；
   `trial-subgraph.ts` 纯函数裁剪器（虚拟 start `__trial_start` 合成 /
   externalUpstreams 推导 / buildTrialSeedRuntime 双形态种子）。
7. **【R10 gateway】**：`trial-mock-llm.ts`（server.mjs 内核源码级移植
   ——matches/resolveResponse 谓词逐字段对齐 + byNode/default 脚本选择 +
   chatStream 切片 + 进程内调用记录 registry + TTL 10min + metrics
   `dagents_trial_runs_total`/`dagents_trial_mock_calls_total`）；
   `workflow-trial.ts` 路由（POST /:id/trial：裁剪→validate（422 带定位）
   →run-gate 429→llmClientOverride 换装→registry 可取消；写 runs
   source='trial'+spans+live+journal，**不写** checkpoint/usage_events/
   Langfuse；GET /runs/:runId/trial-calls 404 诚实回退）；app.ts 挂载
   两行（trialCallsRoutes 挂 /api/v1/runs 满足契约路径）；
   assembleWorkflowEngine 加 `llmClientOverride` 注入位（baseOptions.
   llmClient 类型放宽为引擎接口形状）。
8. **【R10 console】**：FlowEditorHandle.getSelectedNodeId（P0 单选出口）；
   `use-trial-run.ts`（面板状态/种子两级回退预填——/api/runs + node-spans
   反查最近 3 次正式 run 同 nodeId 输出/启动/422 拒绝呈现）；`trial-run-
   panel.tsx`+就近 css（mock 规则编辑/种子区/http 勾选黄警/预供答案/证据
   区——matchedRule + prompt + 未解析占位符计数，404 回退标注）；入口
   「⚡ 试运行」按钮（选中节点时文案切换）；启动后接管既有 watchLoop/
   结果面板（零新执行编排）；`runSource='trial'` 常驻标记条；两个 BFF
   薄代理（gatewayProxy 形制）；en/flows.ts 词条（含独立键
   「已拒绝（可重试）」规避 settings.ts:288「已拒绝」）。
9. **【R9b】**：`run-notify.ts` 单点发射（进程内 Set 幂等 claim +
   superseded 零发射 + awaiting_input 非完成）；ws-hub 扩 runId 订阅维度
   （?run= query + subscribe/unsubscribe 帧 + broadcastRun 定向）；三触点
   接线（workflows 直跑 / resume-execution / workflow-trial 各一行，
   chat @flow 走既有 chat:done 不接）；console ws-client subscribeRun/
   unsubscribeRun（refcount 对称）+ 新 `use-ws-run.ts`（对称 useWsChat 的
   run 维度订阅 hook）在 canvas-kit-page 接线——旁观中的 run 帧直达
   use-task-notification 的 notifyOnRunUpdated（终态词表判定 + superseded
   过滤 + 跨标签页 BroadcastChannel claim——`run-notify-claim.ts`）。
10. **【e2e】**：`26-canvas-trial-run.spec.ts`（AC-R10-1/3/4/5/6/7 的
    服务端可测半：scripted 输出 + prompt/占位符证据 + 隔离三面 + http
    跳过标注 + 草稿回边 422 带定位 + ?source=trial 正向查询）。

### 已跑验证（本会话）

- `pnpm --filter @dagents/workflow exec vitest run`：358/359 绿——唯一
  失败 `custom-function.node.test.ts`「inputs 长度 2→3」是 **R4 方向**
  加 allowedCommands 输入未同步的断言，不在本方向文件清单，未代改。
- 新单测全绿：validate-topology（severity/repairable/占位符规则）、
  trial-subgraph（裁剪 8 例 + seedRuntime 形状）、executor-semantics
  扩展（迭代超限→partial_success+rejected span、retries 两档、http skip
  两例）、gateway `trial-run.test.ts` 12 例（内核行为等价钉子 + claim
  幂等 + 占位符扫描）。
- packages/{contracts,db,workflow} `tsc --noEmit` 干净；gateway/console
  经「@dagents/* paths 指向 src」的临时 tsconfig 只读 typecheck——**本
  方向全部文件零错误**（stock tsconfig 报的 NodeSpanStatus/'rejected'
  等错是 dist 陈旧，见下）。
- console 孤儿 CSS 护栏绿（49 css 全 import）；新文件 prettier/eslint
  干净；i18n 词典 npx tsx 解析 329 词条。
- e2e spec 未跑（dev server 在跑 + dist 未重建，见下）。

### 明确不做 / 交给集成批

- **dist 未重建**：gateway(8080)/console(3000) dev server 正在跑，
  AGENTS.md 已知问题禁止重建 packages/*/dist（tsx watch 会杀在途 run）。
  后果：gateway/console 的 stock typecheck 看不到新类型词（我与其他
  方向同样报错）；gateway 路由级 DB 断言测试与 e2e 26 spec 需重建后由
  统一脚本跑。**已用临时 tsconfig paths（@dagents/* → src）做只读
  typecheck 验证源码正确性**。
- **跨方向代改两处**（当时阻断本包编译，均为机械修复、语义零变化）：
  `user-code-exec.ts` import 路径 `../types/execution.js`→
  `../../types/execution.js`（R4 笔误）；validate-topology 的
  KNOWN_NODE_TYPES 顶层求值改惰性缓存（R4 的 flow-permissions 三方环
  `nodes/index→http.node→flow-permissions→validate-topology→nodes/index`
  在某些 import 序下 allNodes 未初始化，executor.test 实弹红）。
- canvas 节点徽章的 rejected 映射到 waiting（黄系非红）——独立徽章词
  表随 R2/R3 console 批次的 NodeRunStatus 扩词一并定稿（NFR-5）。
- R9b 完整 AC-R9-3（双入口单通知）依赖 R3 stopReason 落库实弹；最小
  阶段 = 过滤逻辑就位（notifyOnRunUpdated superseded 分支 + run-notify
  服务端抑制），组件测/e2e 待 R3 同批。
- 试运行 awaiting 的 HumanInput：未预供答案即挂起（boot sweep 收敛），
  面板已提示「试运行不支持挂起应答」——未做特殊分支（设计如此）。

---

## 可恢复性 · routes/console/端点与 UI 批次（2026-10-07，cluster: 可恢复性）

对照 `docs/zcode-borrow/design-recover.md` 第 ⑧ 节第 1-5 批（地基之外的
全部剩余面：gateway 路由/编排 + console UI + R8 会话/pin）。与地基批次
（上方第一段）同方向续作。

### 本批落地

1. **R3 状态机写新翻转（§3.3，第 1 批）**：
   - `toRunStatus` cancelled→`stopped(stop_reason=user/superseded)` 翻转
     （`workflow-engine-service.ts`，去 eslint-disable）；新增
     `classifyAbortReason`（signal.reason 含 'superseded' 判定——registry
     :80 的 abort 串）与 `classifyFailureReason`（providerFailure→provider，
     默认 model）单源 helper。
   - `resume-execution.ts` 手写三元链收敛到 toRunStatus（AC-R3-3 三入口
     一致：直跑 workflows.ts / resume / answer）；落库点带 stopReason
     （`persistWorkflowRunRow`/`upsertChatWorkflowRunRow` INSERT+UPDATE 列）。
   - chats.ts（chat 流式）/ chat-execute.ts（@flow）cancelled 分支翻
     stopped；`persistCancelled`（internal-runs-helpers）+ ws 契约
     chat:cancelled 帧带 stopReason（superseded 客户端过滤数据面）。
   - `live.finish(status, stopReason?)` 签名扩展（run-live-registry）——
     runEnd 帧带 stopReason（R3.5 最小实现）。
   - **budget resume 双路径（§3.3(d)）**：resumeBodySchema + `tokenBudget`
     （覆盖）/缺省 `originalTokenBudget`（runs.input 的
     `{input,tokenBudget}` 载荷——直跑带预算时写入，不带预算形状不变）；
     新 run 从零起算（引擎现状保证）+ 谱系链黄警（live delta 帧「预算
     重新起算（谱系链累计已耗 X tokens）」，RUN_MARKER_NODE_ID='__run__'）。
   - retention 终态清单扩 `partial_success/budget_exceeded/stopped`（顺带
     修既有漏清）+ run_node_journal 级联删除（orphan 同款）。
2. **R1 journal 化 resume（§3.5/§3.4，第 2 批）**：
   - 新文件 `journal-writer.ts`（写侧单点）：结构帧 write-through（emit
     里 captureStructural resolve 后才 deliver——「先落库后发帧」）、
     delta 帧 write-behind（64 条/200ms 微批）、decision 行幂等 upsert
     （ON CONFLICT (run_id,node_id,ordinal) WHERE kind='decision'——迭代
     控制器 onNodeEnd 二次触发安全）、seq 与 emit 同一计数器
     （allocRunLiveSeq）、单 run 上限（DAGENTS_JOURNAL_MAX_ROWS_PER_RUN
     默认 100k）+ journal_overflow 留痕行 + 指标
     （dagents_journal_rows_written_total/delta_lag_rows/overflow_total/
     seq_conflict_total）。
   - `run-live-registry.ts`：emit() 补 seq（与 at 同位，truncated 不打）、
     journal sink 挂点（第四参）；`workflow-engine-service` 组合点创建
     writer 并注入 baseOptions.journal（引擎 JournalFacade 接缝接通）+
     执行路径 settle 时 `journal.close()` flush。
   - 新文件 `lineage.ts`（runLineageChain 深度 16 + lineageTokensSpent）；
     新文件 `run-node-journal.repo.ts`（读侧单点：findDecisions/
     findDecision/findLatestDecisionByNodeAndHash/listEventFrames/
     hasJournalRows）。
   - `buildResumeSeed` 切 journal（done/cached decision 组种子 + seedHashes
     + itemNodeOutputs per-ordinal 迭代种子）；checkpoint snapshot 兜底
     （无 journal 行的老 run 行为不劣于今天，AC-R1-5）；resume/answer
     透传 seedHashes/seedSource。GET checkpoint 端点带 hasJournal 位。
3. **R7 统一回放（§3.4(c)，第 3 批）**：`execution-live.ts` 404 → journal
   回放（listEventFrames 按 seq 重建 hello.replay；ended/finalStatus 由
   runs 行终态判定；DAGENTS_JOURNAL_REPLAY_MAX 默认 20k 头部截断标记；
   「无 live 条目且无 journal 行」才真 404）。console run-trace-model
   DB 路 nodeEnd 条件加 cached；跨源一致性测试（AC-R7-4）。
4. **R2 暖缓存（§3.7，第 4 批）**：
   - 引擎纯函数导出（executor.ts：shouldExecuteEdge/mergeInputs 从 private
     方法提取为模块级导出 + mergedNodeInputs/previewResolved 加 export——
     class 内委托同源，barrel 导出）；新文件 `warm-cache.ts`
     （planWarmCacheSeeds 纯函数内核：拓扑序预演 + 一致世界线 + hash 精确
     匹配 + 保守断链；buildWarmCacheSeed 编排：谱系链最近优先/诚实 miss）。
   - runBodySchema + `warmFromRunId`；直跑组装 warmResumeOptions 注入
     execute resume 字段；**谱系书写**：暖缓存 run 落 resumed_from_run_id
     = warmFromRunId（全新重跑不写）。
   - cached 契约全链已在（地基 span/live 帧 + 本批 SPAN_STATUS_MAP
     cached→'cached' ⚡ 徽章 + NodeRunStatus/NodeView/badge CSS + 结果面板
     行级「⚡ 来自缓存」+ trace view cached 泳道标注）。
   - 单测：warm-cache.test.ts 6 例（全链命中/改第 3 节点 prompt→1-2 命中
     3-4 全 miss 传递闭包专项/改输入全 miss/lookup 抛错不炸/诚实 miss）。
5. **R8 会话身份与 pin（§3.6，第 5 批）**：
   - `deriveSessionId(runId,nodeId,ordinal)`（SHA-1 前 16 hex，寻址键——
     绝不进 resumeSessionId）；runNodeSinks 键扩 `runId:nodeId:ordinal`；
     进程内会话延续表（chat 收尾采集 result.sessionId → 同键重入查表
     透传 --resume，claude 档）+ `collectRunSessions`（执行路径终态落
     runs.frozen_agents.sessions，resume 跨进程注入 initialSessions）。
     与 R5 的 resumeSessionId 透传协议同一取值单源（本批在其上叠加查表）。
   - persona 冻结：`snapshotFlowAgents`（run 创建期读 agents 行）→
     assembleWorkflowEngine 闭包 fetcher（frozenAgents 注入，resume 路由
     读 runs.frozen_agents 传入——AC-R8-2 跨进程）；终态落
     frozen_agents（快照+sessions）与 runs.models。
   - resolved model：prepareRequest 返回 model 终值（HTTP chat 附返回值；
     CLI = cli:kind，流式随 usage chunk）；execution.ts llmClient 契约
     params +ordinal/modelPinned、返回 +model、IChatStreamChunk +model、
     IExecutedNode +resolvedModel；llm.node/platform-agent.node 透传
     output.resolvedModel；executor 组装 + journal decision 载荷；
     `rollupPrimaryModel`（用量最大节点）填 usage_events.model。
   - pin 禁降级（R8.4）：fallbackOrRethrow/熔断分支/stream 首 chunk 前
     分支首查 params.modelPinned——拒绝降级 + providerFailure 错误对象
     （failed(stop_reason='provider') 唯一归属）+「因 pin 拒绝降级」活动行
     + llm_http pin_rejected 指标；llm.node（inputs.model 非空）与
     platform-agent（frozen agent.model）置位。
   - 插话 ordinal 寻址（R8.5）：execution-message body +ordinal，多实例
     409+活跃清单；sendToRunNode/ExecutionHandle.sendToNode 签名扩 ordinal；
     stdin 行 `nodeId[ordinal]`（console activeNodes 编码 + sendMessage
     解析 `#ordinal` 后缀）。
6. **console 四消费点（§4.1/4.4，第 1 批）**：新文件 `lib/run-status.ts`
   （TERMINAL_RUN_STATUSES/isTerminalRunStatus/STATUS_LABEL/stoppedStatusLabel
   单源）；workflow-run-card 轮询起停换 isTerminalRunStatus（**修轮询泄漏**
   ：partial_success/budget_exceeded 终态 clearInterval，AC-R3-4）；
   canvas-kit-page watchTick/旁观终态判词表全集 + stopped 分支
   （interrupted→refreshCheckpointState→「已中断（可恢复）」亮入口/无
   checkpoint 只显示「已中断」；user→「已停止」中性）；summarizeWatch
   cancelled 不再折 failed（AC-R3-7）；flow-runs-panel STATUS_LABEL 换单源
   + ⚡暖缓存 lineage chip（source 区分 resume/answer 谱系）；
   use-task-notification superseded 早退；CanvasRunState/TraceRunState 加
   'stopped'；i18n 词条（flows.ts 净新增 16 条）。

### 定向自测（本批实跑命令）

- `pnpm --filter` 之外的逐包直跑：`npx tsc --noEmit`——workflow/contracts/
  db/gateway/console 五包全绿。
- `npx vitest run`——gateway 521 passed|1 todo（含新增 warm-cache 6 例、
  recover-status 12 例、run-live seq/stopReason 2 例）；console 449
  passed|5 skipped（含 run-trace-model 跨源一致性 2 例）。
- `node scripts/check-orphan-css.mjs` 49 css 全 import ✓；定向 eslint
  0 errors（canvas-kit-page 余 2 条存量 warnings：markDirty 未用/
  renderHeader deps——非本批引入）。
- workflow 包 `npx vitest run`：358 passed，**1 failed 是
  custom-function.node.test.ts「inputs 长度 2→3」——R4 权限方向的并行改动
  （allowedCommands 输入）未同步其元数据测试，非本方向引入**。

### 明确不做 / 诚实边界

- **cached 行「继承自 {runId 短码}」与 token 双口径继承值未全链**：lineage
  载荷在 journal decision（有），但 span 行/node-spans 端点未透出——
  console 摘要行只显示「⚡ 来自缓存」（无短码）。补法：gateway 在 cached
  span 落库时并入 lineage（需引擎 cached 钩子把 seedSource 带进
  IExecutedNode 或 span-writer 读 journal）——跨引擎/gateway 边界，留集成期。
- **e2e 未新增 26-run-recovery.spec.ts**：设计 §⑥ 的 RM 系 e2e（kill
  gateway/暖缓存 5 节点链/迭代断点）依赖 mock provider 栈 + 服务编排，
  任务约束「不启动常驻服务」——e2e 留给统一把关（既有 e2e 断言已双读
  cancelled|stopped 兼容，NFR-2 无需改）。
- 全仓 pnpm test/typecheck/build 未跑（dev server 在跑，AGENTS.md 明令
  dev 期间避免全仓 build；逐包直跑等价覆盖）。
- journal 表的 down 迁移未实测（地基批次同款边界）。

### 给集成工程师的注意事项（跨方向）

- **并行合并**：本批与 design-sharp（R10 source 列/run-notify/ rejected）、
  R4（custom-function 权限）、R5（platform-agent 三值裁决）、R6
  （deliverables）在同一工作区并行交付——workflow-clients.ts/
  workflows.ts/executor.ts/canvas-kit-page.tsx/canvas-results-panel.tsx/
  node-spans.ts/run-terminal-format.ts/run-trace-model.ts/flows.ts(en)
  均为多方向叠加，集成时按方向拆分 commit 需对照各方向 dev-notes 段落。
- R5 的 `resumeSessionId` 协议与本方向会话延续表叠加在
  createCliLlmClient（resolveResumeSessionId 单点：显式传入优先→进程内
  延续表→frozen_agents.sessions）——合并时保持该优先序。
- `lib/flows.ts` 的本地 NodeRunStatus 与 flow-canvas kit 的 NodeRunStatus
  是两个同名类型（历史双轨），本批都加了 'cached'——后续收敛为一处。
- runs.input 形状：**带 tokenBudget 的直跑 run** inputJson 为
  `{input, tokenBudget}`（不带预算形状逐字不变）——消费 input 的读面
  （previewText/originalDirectoryId）实测兼容，但新增读面请走 .input 键。
- workflow-engine-service 的 assembleWorkflowEngine 返回值新增
  journal/frozenAgents 字段（执行路径需 close()；旧解构不取即无感）。

---

## 集成收口批次（2026-10-08，cluster: 集成）

五方向并行叠加后的整体自洽：冲突裁决、漏接线、修复红、全量验证。

### 裁决与修复

1. **【R9d/R4 词汇冲突裁决：采 R9d 词汇】**（R4 方向 dev-notes 交代的
   二选一，任务词表一致性条重申）：R4 白名单拒绝与 R5 裁决失败统一按
   workflow-engine.md「上限与失败语义对照表」的「节点拒绝」档落地——
   `NodeRejectedError` + 错误首词「节点被拒绝：」→ executor 既有管道
   落 span `'rejected'` + isolateFailure → run `partial_success`。
   改动面（未双写）：
   - `flow-permissions.ts` `assertAllowedHttpDomain` 三处拒绝（invalid /
     declared-but-violated / enforce 缺席）；
   - `custom-function.node.ts` invalid 拒绝 + `$exec is not a function`
     翻译 + **worker 回传错误的类型恢复**（worker 侧错误回传是
     `err.stack` 再裹「custom function threw: 」——按「节点被拒绝：」
     包含匹配恢复 NodeRejectedError，误判面仅影响 span 档词无权限语义）；
   - `user-code-exec.ts` 三处 `__execResult` 拒绝文案 + gateway
     `controlled-exec.ts` 白名单二次复核文案加同前缀；
   - `platform-agent.node.ts` 裁决预算耗尽两处（outputSchema 契约不符
     = 可调整后重试的声明型失败，不整体翻红）。
   测试同步：http.node.test 加类型钉子（NodeRejectedError + 首词）；
   e2e 25（恒违规：500→200+partial_success、span failed→rejected）；
   e2e 28（PG-01/PG-02②：run failed→partial_success、span rejected）。
   对照表已补 R4/R5 三行（workflow-engine.md）。
2. **【R10 trial mockScript union 吞 ScriptSet——产品 bug】**（e2e 26
   首跑逮出，dev-notes 预告的「路由级待集成批补跑」空档）：
   `trialRunBodySchema.mockScript` 的 zod union 原把单脚本分支排在前面，
   其宽形状（全 optional + `rules.default([])`）把 `{default:{…}}` strip
   成 `{rules:[]}`——fallback 静默丢失 → mock 全部回落 `mock:unmatched`。
   修：ScriptSet 分支前置 + refine 显式要求 byNode/default 键（refine
   拒绝后 union 继续尝试单脚本分支，空对象行为不变）。回归钉子进
   trial-run.test.ts（两形态各一例），schema 已 export。
3. **【resume/answer 缺省 input 未沿用前驱——RM-01/RM-03 真根因】**
   （dev-notes 预告「第 2 批稳定后重跑」的红项，重跑后实锤）：
   `execution-resume.ts` 两路径 `input: parsed.input ?? ''` / 硬编码
   `''`——journal 主路种子哈希对账（AC-R1-3）把 start 节点 `''≠原输入`
   判为世界线漂移，run 3ms 内 failed（零 span、runs.output 不可观测）。
   修：新增 `originalStartInput`（runs.input 双形状读 `.input` 键，老行
   回退空串——checkpoint 老种子无 seedHashes 校验跳过不受影响）；
   resume/answer 两路径缺省沿用前驱输入。实测带原输入的 resume 完美
   （start/a/b cached + c/d done + completed）。
4. **【checkpoint 空快照覆盖守护】**（修复 3 的复现中顺带逮出）：
   resume 的 checkpointRunId 指向原 run 的 checkpoint 行，引擎顶层失败时
   本 run 零 onCheckpoint 快照，`terminalize` 用空 lastSnapshot upsert 会
   把原 run 进度快照（completed 清单 + failedAt）冲掉。修：空快照时只翻
   status（updateCheckpointStatus），不覆盖 snapshot。
5. **【R4 漏同步修复】**：`custom-function.node.test.ts` 静态元数据断言
   inputs 2→3（R4 加 allowedCommands 输入未同步）——改为按名字断言
   三输入。
6. **【db dist 缺 1720000106000 迁移】**：src 有、dist 无（某次 dist
   重建时序问题）——globalSetup 建的 dagents_gw_test 缺 runs.source 列，
   trial 的 runs INSERT 被 catch 吞成 warn（gateway 既有 521 例全绿是
   因为没测试碰该列）。重建 @dagents/db dist 后 globalSetup 增量补列。
   新增路由级隔离测试 `trial-isolation.test.ts`（app.request 全链路：
   spans/journal 有行、checkpoint/usage_events 零行、source='trial'）
   ——dev-notes 交代集成批补跑的「trial 路由 DB 隔离断言」落此。

### e2e spec 修复（三处，均已首跑验证）

- `25-agent-verdict.spec.ts`：inspector 打开手势 = **双击**节点（单击只
  选中，onNodeDoubleClick 才开面板——页面快照实证 ✎ 按钮出现但面板 absent）。
- `26-canvas-trial-run.spec.ts` AC-R10-6：`fail()` 信封把 extra 顶层展开
  （lib/http.ts）——`json.detail?.errors` 改读 `json.errors`。

### 实测记录（2026-10-08，本批全量）

- 单测：workflow 359/359 · gateway 524 passed+1 todo（含新增 3 例）·
  console 449 passed+5 skipped · contracts 20/20 · db 5/5；五包
  `npx tsc --noEmit` 零错误（dev-notes 所记 gateway 3 错 / console R3
  扩词错误均已被并行批次自愈 + dist 就绪）；孤儿 CSS 49 全 import；
  i18n 缺译扫描绿（「启动失败」词条 R10 批末已自补 en/flows.ts:390）。
- e2e：25-agent-verdict 2/2 · 26-canvas-trial-run 3/3 · 26-run-deliverables
  4/4 · 28-permission-guard 3/3 · **24-run-resume 3/3 回绿**（RM-01/02/03，
  修复 3 生效；此前 20s 超时 → 修复后 1.2-1.5s）。
- dist：workflow + db 均已重建并实测（node 直跑 dist 验证
  assertAllowedHttpDomain 抛 NodeRejectedError）；gateway tsx watch 两轮
  重启均确认 /health ok 且动手前 `dagents_runs_active 0`。

### 维持不做的边界（沿各方向记录）

- `DAGENTS_HTTP_DOMAIN_POLICY` 默认仍 `warn`（OQ-4 产品终裁后独立 PR 翻转）。
- 26-run-recovery e2e 未新增（kill gateway/暖缓存链/迭代断点依赖服务编排）。
- AC-R5-2 真机 `--resume` smoke 扩展未做（设计标可选；单测 A 档已钉）。
- cached 行「继承自 {短码}」与 token 双口径继承值未全链（span 行未透出
  lineage——跨引擎/gateway 边界，仍留后续）。
- console `lib/flows.ts` 与 flow-canvas kit 的 NodeRunStatus 同名双轨维持
  （两处均已加 'cached'）。

### 测试补齐批（2026-10-08 晚，cluster: 提交裁决）

在开发批（单测 30 项）之上按设计 §6.1 补齐**消费侧贯通**测试 11 项——
开发批钉了「产出方」（节点状态机/校验器/CLI 客户端），本批钉「消费方」
（span-writer 落库 → console 终端/轨迹投影），全部按邻近测试既有风格追加：

1. **gateway `span-writer.test.ts`**（+2）：verdict 活动进 events 全量日志
   且进 activity 环（非 status/log 噪音——摘要面板可见裁决轮次）；onNodeEnd
   终态合并保留 verdict 轮次（output.json 与 events 同存）。
   ⚠️ 坑：文件级 `triggerEventsFlush` 辅助锚定 2026-09-06 时间基——自定义
   beforeEach 换日期会让 fake clock 倒退、节流门控永不放行（首跑即栽，已修）。
2. **gateway `workflow-clients-resume.test.ts`**（+3）：resume 轮增量回喂
   消息经 buildCliMessages 折叠 → systemPrompt=undefined（不重复注入 system
   头/schema 契约块，设计 §3.2 定稿钉）；修复轮无 tools + claude 档 →
   extraArgs 带 `--disallowedTools`（文本档自动收紧）；工具循环轮（带 tools）
   不收紧——对照组。
3. **console `run-terminal-format.test.ts`**（+4）：events 通道 verdict 行
   全文保真映射；activity 环降级路同放行；直播路 verdict 帧保持专有 kind
   （不降级 log，at 取服务端时间戳）；sectionTranscript 复制实录含裁决行。
4. **console `run-trace-model.test.ts`**（+2）：DB 路 span events 的 verdict
   行 → 台账专有 kind 记录（台账全局序 nodeStart→verdict→nodeEnd）；直播路
   verdict 帧与未知 kind 降级 log 形成对照（F8 兜底边界双向钉）。

自证：`pnpm vitest run`（workflow 2 文件 + gateway 3 文件 = 35 测）与
console 包内 3 文件（55 测）全绿；eslint 4 个改动测试文件零告警；prettier
仅校验本批追加块（共享测试文件既有段落存在先于本批的 prettier 偏差，未
整文件重排）；console typecheck 唯一错误在 R6 的
`canvas-deliverables-card.test.tsx`（缺地基批新增的必填 `ordinal`——该
方向待修，非本批文件）。e2e 仍属集成期跑（dev server 禁启约束不变）。

### 测试补齐批次（2026-10-08 第二问，cluster: 渐进产物）

对照 §⑥ 测试计划把 UI 层逻辑从「仅 e2e 兜底」补到 vitest：

- `apps/console/src/components/__tests__/canvas-deliverables-card.test.tsx`
  （新，12 用例）：`groupDeliverables` 纯逻辑（实例键序→拓扑序重排、未知
  节点垫底、迭代多 ordinal 聚组内升序、label 回退）、`sumTokensBadge`
  求和/无量 null、`DeliverablesCard` 渲染（text 单行预览/继承 chip/子流程
  chip/迭代「第 k/n 项」/未完成标注三分支——**failed span 不进「未执行」
  灰行**/零产出禁用复制下载/空输入整卡不渲染/终端锚点回调/clipboard 桩
  复制回执）。为此把 `groupDeliverables`/`sumTokensBadge`/`DeliverablesCard`
  从 canvas-results-panel.tsx 追加导出（纯追加，生产行为零变化）。
- `apps/console/src/lib/node-spans.test.ts`（追加 describe，+5 用例）：
  `fetchRunNodeSpans` 的 deliverables 透传契约——在场透传 / 缺席 null
  （旧网关）/ 空数组 []（诚实空态）/ 坏损防御归 null / 非 2xx 与网络异常
  归 null。决策 F 的 null≠[] 语义在 fetch 层钉死。
- `apps/console/src/components/__tests__/run-terminal-anchor.test.tsx`
  （新，2 用例）：`data-terminal-section={nodeId}` 锚点属性——spans 快照
  路与 live builder 路两数据源同键（AC-R6-5 载体防回归）。
- 踩坑记录：userEvent.setup() 会自装 clipboard stub 覆写测试桩（v14 行为）
  ——复制用例改 fireEvent.click；jsdom navigator.clipboard getter-only，
  需 defineProperty 覆写。另：可恢复性方向已把 `RunNodeSpan.ordinal` 升
  必填（§⑦ 共享表所述），测试桩需带 ordinal: 0。
- 本批实测：console 四文件 46/46（`pnpm vitest run` 定向）、contracts
  20/20、gateway 15/15、console lint 0 error（新文件零 finding）、
  typecheck 相关文件干净。

---

## 可恢复性 · 测试补齐批次（2026-10-07，cluster: 可恢复性）

对照 `docs/zcode-borrow/design-recover.md` 第 ⑥ 节测试计划补 vitest（地基与
routes/console 两批已带的测试之外，逐条盘点缺口后补齐；先读邻近测试学风格：
workflow-clients-resume.test.ts 的 scripted-backend mock / run-deliverables.test.ts
与 boot-sweep.test.ts 的 dagents_gw_test 真库 fixture / db migrations-guard 的
纯 node 测试）。

### 本批新增测试（定向实跑全绿）

1. **`apps/gateway/src/__tests__/journal-writer.test.ts`（8 例，真库）**——
   AC-R7-2 的 writer 面 + §3.4(b)：decision 行全量读回（status/inputHash/
   output/tokens/lineage/resolvedModel）、迭代控制器二次触发的
   (nodeId, ordinal) 幂等 upsert（AC-R1-2 写侧）、per-ordinal 多档并存、
   JournalFacade.lookup 两态、结构帧 write-through（nodeEnd 带 ordinal、
   runEnd node_id='__run__'、payload 原样含 seq、seq 升序）、delta 微批 +
   close() flush、单 run 上限拒收 + journal_overflow 留痕行。
2. **`apps/gateway/src/__tests__/run-node-journal-repo.test.ts`（6 例，真库）**
   ——读侧单点：findDecisions 的 statuses 过滤（failed 不进种子）、ordinal
   寻址、findLatestDecisionByNodeAndHash 精确匹配 + **candidates 序即最近
   优先（PRD R2.1）** + failed/空候选诚实 miss、listEventFrames 的 seq 升序
   与回放上限截断标记（truncatedHead）、hasJournalRows。
3. **`apps/gateway/src/__tests__/lineage.test.ts`（6 例，真库）**——谱系链：
   三级链自根向后代、根运行、**断链（retention 清掉的前驱不进候选）**、
   深度上限 16、幽灵 run 空链、lineageTokensSpent 按链 SUM。
4. **`apps/gateway/src/__tests__/workflow-clients-recover.test.ts`（10 例，
   mock）**——AC-R8-3 pin 禁降级：modelPinned + provider 500 → 响亮失败
   （providerFailure/expectedModel/「因 pin 拒绝降级」活动行 + CLI 零调用）；
   未 pin + 全局闸关 = 原样抛（基线对照）；熔断开启同样拒绝（含熔断上下文
   活动行）。AC-R8-1 后半（取值单源）：首次不传 → 收尾采集真实
   backendSessionId → 同键重入查表透传 --resume、显式传入优先、非 claude
   档不透传（collectRunSessions 只回 claude）、initialSessions 跨进程注入、
   ordinal 维度隔离（并发迭代多会话不串）、跨 run 不串。
5. **`apps/gateway/src/__tests__/usage-events.test.ts` 追加（5 例）**——
   rollupPrimaryModel（用量最大节点的 resolvedModel，双 token 命名、零用量
   退位、诚实缺席 null）+ AC-R2-3 零重复记账的引擎前提对照。
6. **`packages/db/src/__tests__/run-status-vocab.test.ts`（3 例，纯 node 捕获
   型 QueryRunner）**——AC-R3-3 的迁移腿：runs_status_chk 九值 = RunStatus
   联合、runs_stop_reason_chk 五值 = RunStopReason（down 路径八值无
   stopped 有 cancelled）、快照列齐备（frozen_agents/models/ordinal）。
7. **`apps/console/src/lib/__tests__/use-task-notification.test.tsx` 追加
   （4 例，renderHook + 真 ToastProvider）**——AC-R3-6 的 chat 帧半（sharp
   方向已在同文件钉 run-updated 半）：chat:done/chat:error 携带
   stopReason='superseded' → 通知链零触发；无 stopReason / user 来源不误伤。

### 本批逮到并修复的生产缺陷（3 处——测试先行的直接收益）

1. `journal-writer.ts` 批量 INSERT **漏写 event_type 列**（调用方传入的
   eventType 被忽略，event 行该列恒 NULL——回放按 event_type 分流的消费面
   会整体失明；journal-writer.test 的 write-through 三例逮到）。
2. `run-node-journal.repo.ts` 的 findLatestDecisionByNodeAndHash **ORDER BY
   拼接 bug**（单引号字符串里的 `${runIds.length}` 未插值 → SQL 含字面
   `${...}` → syntax error at or near "$"；repo.test 两例逮到）。修复改用
   `array_position($3::uuid[], run_id)` 数组占位符（candidates 序即优先级，
   一次传整表，不再逐 id 拼占位符）。
3. `lineage.ts` 的 runLineageChain **断链 run 仍进链**（先 push 再查行——
   被 retention 清掉的前驱进了候选，违背 R2.6「查不到 = 不进候选」；
   lineage.test 断链例逮到）。修复为行存在才入链（空链 = 整链 miss）。

### 定向自测（本批实跑命令）

- `apps/gateway`：`npx vitest run`——**64 文件 584 passed | 1 todo**（含本批
  新增 4 文件 + 2 处追加）；`npx tsc --noEmit` 绿。
- `packages/db`：`npx vitest run`——3 文件 8 passed；`npx tsc --noEmit` 绿。
- `apps/console`：`npx vitest run src/lib/__tests__/use-task-notification.test.tsx`
  ——10 passed（本批追加 4 + sharp 既有 6）；`npx tsc --noEmit` 绿。
- `packages/workflow`：`npx vitest run`——32 文件 374 passed（本批未动该包
  生产代码，回归确认；上一批失败的 custom-function 元数据测试已被 R4 方向
  同步修复）。
- 全仓 pnpm test/build 未跑（约束 + dev server 在跑）；设计 §⑥ 的 e2e 面
  （26-run-recovery.spec.ts 的 kill gateway/暖缓存 5 节点链）仍留给统一把关
  ——理由见上一段「明确不做」。

### 已有覆盖盘点（本批无需重写的部分）

- AC-R1-3/AC-R1-2 引擎面（种子 hash 校验/per-ordinal 种子/cached 钩子/
  journal decision 接缝/ordinal 分配）：`executor-resume.test.ts`（地基批，
  22 例）；AC-R1-4：`input-hash.test.ts`（地基）。
- AC-R2-1 单测面（暖缓存闭包/改输入全 miss/最近优先/诚实 miss）：
  `warm-cache.test.ts`（routes 批，6 例）。
- AC-R3-3 单源映射/classifyAbortReason/classifyFailureReason/deriveSessionId：
  `recover-status.test.ts`（routes 批，12 例）；AC-R3-1 boot sweep：
  `boot-sweep.test.ts`（地基）。
- AC-R7-2 emit seq 单调 + finish(stopReason)：`run-live.test.ts`（routes 批
  追加 2 例）；AC-R7-4 跨源一致：console `run-trace-model.test.ts`（追加 2 例）。

---

## 工程决策与试运行 · 测试补齐批（2026-10-08，cluster: 工程决策开发）

对照 design-sharp §6 测试计划，首批未覆盖的缺口本批全部补齐（31 例新
vitest）；测试实弹逮出并修复两处源码缺陷。

### 本批落地

1. **run-notify-ws.test.ts**（gateway，5 例）：ws-hub 真服务器全链路——
   run-updated 帧形状、claim 幂等（第二次发射零新帧）、superseded/非终态
   零发射、订阅维度定向（?chat= 客户端不收 run 帧）、控制帧动态订阅。
   首批只钉了「不抛」，本批补齐可观测断言（AC-R9-3 服务端半）。
2. **runs-source-filter.test.ts**（gateway，3 例）：listRunsHistory 缺省
   排除 trial / ?source=trial 正向 / includeTrial 全量 / NULL 存量行不误伤；
   persistWorkflowRunRow 的 source COALESCE 保已存值；canvas 直跑实写。
3. **trial-subflow-depth.test.ts**（gateway，1 例）：5 层 flow 链试运行 →
   第 4 层 executeFlow span 'rejected'（词首「节点被拒绝：」）+ 子引擎
   LLM 输出 = mock 文本 + 零在途 CLI spawn（9d 第三来源的路由级钉子）。
4. **trial-mock-equivalence.test.ts**（gateway，10 例）：真 spawn e2e
   夹具 server.mjs（随机端口）与内核 resolveMockResponse 对共享语料逐例
   比对（label/text/tool_calls/finish_reason/usage/未知谓词/error/malformed）
   ——NFR-2「共用内核」的验收形式。
5. **http.node.test.ts 追加 2 例**（workflow）：trialMode real 不短路
   （fetch 照常调用、错误原样上抛）vs skip 零 fetch + 标注——两模式判别钉子。
6. **run-notify-claim.test.ts**（console，4 例）：BroadcastChannel 缺席 →
   null 单例（单标签页语义）；首 claim/幂等/异 runId；跨标签页异步投递后
   claim 失败；单例复用 + reset。
7. **use-task-notification.test.tsx**（console，6 例）：notifyOnRunUpdated
   的 completed/failed 双路 toast+声音、superseded 零通知（AC-R3-6 最小
   客户端路径）、非终态零通知、claim 幂等、跨标签页静默（真
   BroadcastChannel 互投——本环境 Node 全局透传 jsdom，设计预判「jsdom
   无 BC」已过时，测试头注释如实更正）。

### 测试实弹修复（两处源码缺陷）

- **workflow-engine-service.ts flowExecutor 不透传 llmClientOverride**：
  含 executeFlow 的试运行子引擎会回落 createDefaultLlmClient 打真
  provider/CLI（AC-R10-1「真 provider 调用数 0」对子流程不成立）——
  trial-subflow-depth.test 实弹逮出，已修（递归装配透传 + sub.journal.
  close() 收口对齐根路径）。
- **trial-mock-llm.ts empty 模式投影漂移**：resolveMockResponse 返回原
  text 而 server.mjs completionBody 强制 ''——等价钉子实弹逮出，归一化
  收敛到解析器单点（chat/chatStream 消费端去重）。

### 已跑验证（本会话，均为定向）

- gateway 六文件连跑（含集成者的 trial-isolation 回归）：34/34 绿；
  **gateway 全套 64 文件 584 通过/1 skip**。
- workflow 全包：374/374 绿（含追加 2 例）。
- console 新两件：10/10 绿；两包 tsc --noEmit 零错；新文件 eslint/
  prettier 干净。
- e2e 26-canvas-trial-run.spec.ts 本批仍未跑（Playwright 栈归统一脚本）。

---

## 工程决策与试运行 · 测试补齐轮（2026-10-08，cluster: 工程决策开发）

对照 design-sharp §6 测试计划逐条盘点现有库存（含集成批已补的
trial-isolation / trial-mock-equivalence / trial-subflow-depth /
run-notify-ws / console 两件），确认**唯一名义缺口** = §6.4 第 2 条的
「listRunsHistory 过滤生效」读面半——本批补齐。

### 本批落地

- `apps/gateway/src/__tests__/trial-isolation.test.ts` 追加第二例
  「listRunsHistory：缺省排除 trial 行；source=trial 正向；includeTrial
  免滤；canvas/chat 行不误伤」——SQL 直插 canvas/chat/trial/legacy
  （source IS NULL，迁移前旧行）四行，钉住三个过滤向 + NFR-1 混跑窗口
  旧行不误伤 + RunHistoryRow.source 行形状。踩点：`runs.input` 非空
  约束（种子行用 `'{}'::jsonb`）。

### 已跑验证（本会话，定向）

- gateway 五文件（trial-run / trial-isolation / trial-mock-equivalence /
  trial-subflow-depth / run-notify-ws）：**32/32 绿**。
- workflow 四文件（validate-topology / trial-subgraph /
  executor-semantics / types）：**54/54 绿**。
- console 两件（run-notify-claim / use-task-notification）：**14/14 绿**。
- 合计 R9/R10 测试库存 11 文件 100 例全绿；扩展文件 prettier/eslint 干净。

### 边界

- e2e 26-canvas-trial-run.spec.ts 仍归统一脚本（Playwright 栈 + 测试库）。
- §6.3「深度超深 → run 终态 partial_success」的字面引擎级直测未单独造
  ——路由级 trial-subflow-depth 已实弹覆盖更真实路径（根图 completed、
  被拒 span 'rejected' 并入同 runId，executeFlow 透传语义），不重复钉。

---

## 渐进产物 · 测试补齐批（2026-10-08，cluster: 渐进产物）

对照 design-artifacts.md §⑥ 测试计划盘点存量（实现批 + 集成收口批已落
contracts 12 / gateway 15 / console lib+组件 48 / e2e 4），本批补三块
真实缺口，全部 vitest：

### 本批新增（apps/gateway/src/__tests__/run-deliverables.test.ts，15→22 例）

1. **journal 主路端到端**：journal-writer 已接线后，「journal 落地 → 读面
   自动切主路」（§①-2 裁决）此前只有手插行模拟——本例真跑 directReply
   run，轮询断言 `getRunDeliverables` 的 source 翻 'journal'、条目/label
   （LEFT JOIN spans 借阅）/output 与 spans 投影一致。坑：轮询条件必须
   「主路且目标条目在场」——首条 decision 落库即翻 source，末节点可能
   仍在 writer 异步串行链上（只等 source 会抢跑，已实测踩中一次）。
2. **词表边界**：spans CHECK 宽放（1720000106200）后的新词
   stopped/rejected/paused/unknown 在 projectDeliverableRows 剔除
   （AC-R6-2 stopped 分支读取侧：中断/拒绝不是产出态）；malformed
   payload（status 缺席/非串）与畸形 lineage 剔除且不炸不造标注。
3. **journal 权威判定边界**：kind='event' 行（R7 事件先行、decision 未落
   的窗口）不触发主路、照走 spans 兜底；malformed decision = journal
   权威空清单不回退造数；非 uuid runId 抛错（node-spans 端点据此 omit
   deliverables 字段的契约前提——吞错返空会让聚合区永久静默）。

### 实测

- gateway：`apps/gateway` 下 `pnpm vitest run src/__tests__/run-deliverables.test.ts`
  → **22/22 连续三轮绿**（真库 dagents_gw_test）；prettier/eslint 干净。
- console 侧存量复核：`pnpm vitest run`（node-spans / run-terminal-format /
  canvas-deliverables-card / run-terminal-anchor / i18n-keys）→ **48/48 绿**
  （i18n 扫描随 R10 补词条已回绿）。
- contracts 存量复核：`pnpm --filter @dagents/contracts test` → 20/20。
- e2e 26-run-deliverables.spec.ts（4/4，实现批已实测）本批未重跑——本批
  零产品代码改动（只加测试），归统一脚本把关。

### 边界与说明

- console 组件/透传/锚点测试由集成收口批落（canvas-deliverables-card
  12 例 / run-terminal-anchor 2 例 / node-spans fetch 透传 5 例），本批
  核实已覆盖后不重复造。
- 引擎（packages/workflow）按设计 §③ 零改动，无 R6 引擎纯函数可测——
  「纯函数优先」落在本方向的投影层（gateway projectDeliverableRows /
  buildRunDeliverables + console groupDeliverables / sumTokensBadge /
  buildDeliverablesTranscript），均已各自钉住。


### 测试补齐批次（2026-10-08，cluster: 权限闭环）

对照 design §6 测试计划盘点（含集成收口 74758e6 已铺的面）后补的生成器
半边与清点仪器缺口，全部定向跑绿：

- **本批新增**（`apps/gateway/src/__tests__/flow-generator.test.ts` 追加 4 用例）：
  ① `buildWorkflowGeneratorPrompt` 的 R4 规则钉子（§3.4.1——http 节点
  `data.inputs.allowedDomains` 与重定向同清单约束、customFunction
  `data.inputs.allowedCommands` MUST + `$exec() is unavailable`）；②
  `normalizeToCanonicalFlow` 权限声明保真钉子（§3.4.2「零改动实读核验」
  此前无测试钉住——平铺与嵌套 `data.inputs` 两形态逐字透传，防未来
  normalize 重写静默丢字段让生成产物声明蒸发）；③ 修复循环吃声明错误
  （§3.4.4——首产物 `allowedDomains` 写成非数组 → repair 轮收到
  `allowedDomains 声明非法` 错误 → 修正后 success 且 repairRounds=1，
  「生成侧全量带声明由校验器强制」的端到端证明）。
- **本批新增**（`apps/gateway/src/__tests__/scan-template-permissions.test.ts`）：
  `scripts/scan-template-permissions.mjs` 冒烟（child_process 真跑，env 剥
  POSTGRES_URL 保持无库依赖）——内置 10 模板零缺席 exit 0、零缺席时不
  出报告行（缺席仅报告不阻断的文案契约反向钉）。
- **既有面核对**（非本批产物，跑绿确认）：workflow 包 98 用例
  （flow-permissions 语义阶梯/同源钉子/assertAllowedHttpDomain 判定表 +
  http 守卫与同缝定序 + custom-function 节点层 + user-code-exec RPC +
  validate-topology）、gateway 33+24+2 用例（controlled-exec 真进程 /
  路由门 / 风险扫描 / 内置 gate / 生成器）、console 组件 8 用例
  （run-permission-summary.test.tsx——集成收口已建，组件测试先例是
  @testing-library/react 无 Provider 渲染）。
- e2e `28-permission-guard.spec.ts`（3 用例）本批未改动未复跑（上一批
  全绿，产品代码零变更——本批只加测试文件）。

---

## 可恢复性 · 测试补齐批次（2026-10-08，cluster: 可恢复性）

对照 `docs/zcode-borrow/design-recover.md` §⑥ 测试计划的 vitest 面（本批
与另一并行测试批次在同一工作区互补交付——见下「覆盖清点」）。

### 本批新增（5 文件 22 例，全部实跑通过）

1. `apps/gateway/src/__tests__/recover-seed.test.ts`（真库 dagents_gw_test，
   §3.5(a)）：buildResumeSeed journal 化种子组装——journal 行（done/cached）
   进 seedOutputs+seedHashes 且优先于 snapshot stale 输出、failed 行不进、
   控制器排除；迭代 per-ordinal 行组装 itemNodeOutputs（AC-R1-2，游标
   completed 仍取 checkpoint）；checkpoint 兜底（AC-R1-5：无 journal 行的
   老 run 回落 snapshot、无 seedHashes/seedSource）；无 checkpoint → null。
2. `apps/gateway/src/__tests__/recover-db-check.test.ts`（真库，AC-R3-3 迁移
   半边）：information_schema 读 runs 两条 CHECK——status 九值/stop_reason
   五值与 TS 词表逐字一致（cancelled 显式保留）；词表外值 INSERT/UPDATE
   双路拒收（fail-closed 实证）；九值+五来源全部可写（写新读旧双跑）。
3. `apps/gateway/src/__tests__/execution-live-replay.test.ts`（真库 + SSE
   路由全链路，§3.4(c)/AC-R7-5 单测面）：live 条目 404 → journal 前缀重建
   hello.replay——**乱序插入的行按 seq 纠正交付序**、payload at 原值不重打、
   stopReason 透传、ended/finalStatus 由 runs 行判定；超
   DAGENTS_JOURNAL_REPLAY_MAX 头部 truncated 标记（dropped 计数如实）；
   有 runs 行但无 journal 行 → 仍 404（诚实阶梯终点）。
4. `apps/gateway/src/__tests__/execution-message-ordinal.test.ts`（纯控制
   通道，§3.6(e)/R8.5）：body ordinal 原样透传 sendToNode + 回执带 ordinal；
   ambiguous → 409 + ordinals 清单（extra 顶层展开——lib/http.ts 信封形状；
   清单载荷经 workflow-clients 部分 mock，真实 sink 表生命周期由
   workflow-clients-recover.test.ts 覆盖）；负数/非整数 ordinal 归一为缺省。
5. `apps/console/src/lib/run-status.test.ts`（纯逻辑，§4.1 词汇单点）：
   TERMINAL_RUN_STATUSES 六终态双读（stopped+cancelled）+ 非终态/空值不
   命中；STATUS_LABEL 九态全覆盖；stoppedStatusLabel 三态派生（已中断
   （可恢复）/已中断/已停止）；STOP_REASON_LABEL 五值键集。

### 覆盖清点（§⑥ 单测表逐行——并行批次已交付的不再重写）

- 引擎纯函数（AC-R1-2/3/4 + cached 钩子 + journal 接缝 + ordinal 分配）：
  `packages/workflow/src/__tests__/executor-resume.test.ts`（地基批次）+
  `utils/input-hash.test.ts` ✓。
- journal-writer 写侧（幂等 upsert/write-through/delta 微批/上限留痕/
  lookup）：并行批次 `journal-writer.test.ts` ✓。
- repo 读侧（findDecisions/最近优先/listEventFrames 截断/hasJournalRows）：
  并行批次 `run-node-journal-repo.test.ts` ✓。
- lineage（链序/断链/深度上限/谱系 token）：并行批次 `lineage.test.ts` ✓。
- pin 禁降级 + 会话延续表取值单源 + collectRunSessions：并行批次
  `workflow-clients-recover.test.ts` ✓（与 R5 的
  `workflow-clients-resume.test.ts` 显式透传腿互补不重叠）。
- rollupPrimaryModel（AC-R8-4 对账面）：并行批次补进 `usage-events.test.ts` ✓。
- toRunStatus/classifyAbortReason/classifyFailureReason/deriveSessionId
  （AC-R3-3 TS 半 + AC-R8-1）：本方向上批 `recover-status.test.ts` ✓（本批
  的 db-check.test.ts 补齐「迁移半边」——类型+迁移双钉凑整）。
- run-live seq 单调 + finish(stopReason) + 跨源一致（AC-R7-2/7-4）：上批
  `run-live.test.ts` 追加 + `run-trace-model.test.ts` 追加 ✓。
- boot sweep 三件（AC-R3-1）：地基批次 `boot-sweep.test.ts` ✓。
- 暖缓存闭包（AC-R2-1 单测面）：上批 `warm-cache.test.ts` 6 例 ✓。
- 通知抑制 superseded（AC-R3-6 最小实现）：并行批次
  `apps/console/src/lib/__tests__/use-task-notification.test.tsx`（chat:done/
  error 双路 + user 对照 + run-updated 路径）✓。
- **e2e（§⑥ e2e 表）不在本批范围**：任务限定 vitest；RM 系 e2e（kill
  gateway/暖缓存 5 节点链/迭代断点/并发插话 409）留给统一把关。

### 定向自测（实跑命令与结果）

- `cd apps/gateway && npx vitest run src/__tests__/{recover-seed,recover-db-check,
  execution-live-replay,execution-message-ordinal}.test.ts` → 4 files / 14
  tests passed；全量 `npx vitest run` → **70 files / 614 passed | 1 todo**。
- `cd apps/console && npx vitest run src/lib/run-status.test.ts` → 8 passed；
  全量 `npx vitest run` → **48 files / 504 passed | 5 skipped**。
- `cd packages/workflow && npx vitest run` → **32 files / 378 passed**（上批
  失败的 R4 custom-function 元数据测试已由其方向修复）。
- `npx tsc --noEmit`：gateway / console 双绿。

### 注意事项

- recover-seed / recover-db-check / execution-live-replay 使用 d/e/f 段固定
  UUID（afterAll 清理）；与并行测试批次的 b/c 段不冲突——全量套已验证无
  相互干扰。
- execution-live-replay 的 EventReader 是 run-live.test.ts 同语义最小实现
  （SSE 块解析）——两处独立不抽公共（测试代码不进产品 import 图）。

### 门禁第 1 轮失败修复（2026-10-08 集成批续）

- 唯一 lint error：`execution-live.ts:104` `let attachment` 从未重新赋值
  （R7 journal 回放段引入）→ `const`（prebuffer/push 机制下无需重绑）。
  修复后全仓 `pnpm lint` 9/9 tasks successful（gateway/console 各 20 条
  warning 为存量基线，0 errors 不挡门禁）；第 1 轮日志中 console:lint
  的 ELIFECYCLE failed 是 turbo 对 gateway#lint 失败后的在途任务取消
  语义，独立复跑 console `pnpm lint` exit 0 实证。
- 遗留 warning 清单（不挡门禁，留后续清理批）：gateway
  `workflows.ts:30-35` 的 computeTopoHash/getCheckpoint/
  upsertCheckpoint/updateCheckpointStatus 四个 unused import 是
  checkpoint 落库收敛到 repo 单源（resume-execution makeCheckpointHook）
  后的残留；`resume-flow.test.ts` 7 条 unused 是该测试文件瘦身后的
  骨架残留。均非本批引入。

---

## 可恢复性 · 验收未过项修复批次（2026-10-08，cluster: 可恢复性）

对照验收清单逐条修复（代码 + 断言面），全部定向实跑通过。

### 修复内容

1. **AC-R1-6 第三消费点（chat 执行卡「已中断」）**：workflow-run-card 头部
   新增 run 级终态词 chip（`wf-run-state`，workflow-run-card.css 就近样式）——
   stopped 按 stop_reason 细分（stoppedStatusLabel：interrupted→「已中断」/
   user→「已停止」；chat 路径无 checkpoint 不假承诺恢复）；cancelled 双读；
   partial_success/budget_exceeded 黄系；completed/failed 由既有绿/红样式
   表达不叠冗词。runStopReason 经 node-spans 信封采集（fetchOnce）。
2. **AC-R2-2 分句（终端无假 CLI 提示行）**：run-terminal.tsx SectionView 的
   cached 段提示行改显「⚡ 来自缓存」（.rtl-cmd-cached 黄系）——不再渲染
   `$ llm · model` 假提示行；真实执行段照常。
3. **AC-R2-3 第一分句（双口径 token）——三段落地**：
   - 引擎：ResumeOptions 增 `seedTokens`（前驱 decision 的 payload.tokens）；
     cached 钩子 IExecutedNode.tokens 记继承值 + journal lineage 增
     `inheritedTokens`（executor.ts，PRD R2.3 定稿）。
   - gateway 组装：buildResumeSeed（decision 行 tokens→seedTokens）+
     buildWarmCacheSeed（lookup 返回 tokens）+ execute/answer/resume 三路
     透传；node-spans 端点对有谱系锚的 run 附带 `lineageTokens`（链上前驱
     usage_events SUM——lineage.ts 复用；根运行 null）。
   - console：结果面板新增「谱系继承 M · 本次新增 N · 合计 T」双口径行
     （canvas-results-tokens-dual 样式 + i18n 词条）；新纯函数
     lib/run-tokens.ts（splitTokensBySource 分桶——cached 继承/其余新增；
     dualBasisTokens——继承 = 前驱累计 + 本 run cached 继承值）。
     cached 行的 tokens 徽章自此显示继承值（tokensBadge 读 sp.tokens）。
4. **AC-R3-1（budget resume 双路径断言）**：recover-budget-resume.test.ts
   （真库 + startWorkflowExecution 部分 mock 捕获 req）——覆盖生效（body
   5000）/缺省沿用（runs.input 3000）/老 run 无预算（undefined）/非法值 400
   四态；同文件钉 node-spans 信封 lineageTokens（warm=500 / 根=null）。
5. **AC-R3-4（定时器清除断言）**：workflow-run-card.test.tsx（fake timers +
   fetchRunNodeSpans 模块 mock）——running 起轮询→partial_salary 终态→
   clearInterval（推进 5s 零新增 fetch、onTerminal 恰一次）；词表全集六终态
   逐一钉；顺带钉「已中断/已停止/已取消」渲染与 completed 不叠冗词。
6. **AC-R7-1/3（kill 模型单测）**：journal-replay-superset.test.ts（真库 +
   forRunLive×makeJournalWriter 真实组合）——「kill = 停止发射」模型下：
   订阅者已收每帧 ⊆ journal 行集且按帧内 seq 对齐后 canonical（键排序）
   逐字节相等（jsonb 物理键序重排是唯一差异源，canonical 消除）；无崩溃
   流 74 帧全程（跨微批阈值）+ close → journal 行数 == 发射帧数（零丢失）。
   结构帧接收序 ≠ seq 序（write-through 落库延迟 deliver）如实在断言口径
   中体现。
7. **AC-R8-2（persona 冻结行为断言）**：persona-freeze.test.ts（真库）——
   snapshotFlowAgents 快照内容/空图 null/缺席行跳过；**行为主断言**：冻结
   装配后改 agents 行 → frozen fetcher 仍回创建期快照，对照（实时 fetcher）
   回新值（「对照 run 可见差异」的单测等价）；resume 跨进程注入同款。

### 诚实边界（未在本批关闭的）

- AC-R7-1/3 的**真 e2e**（kill gateway 进程 + 断连重连）仍以单测 kill 模型
  等效覆盖——任务约束禁跑 e2e/禁启常驻服务，与验收报告同口径。
- AC-R3-1 的 RM-01 e2e 回归与「谱系黄警」过程流断言未跑（黄警实现已在上
  批审阅；预算三态取值链已钉）。
- AC-R2-3 账单页（usage-summary）与面板的口径一致性维持既有实现（两侧同
  只计 usage_events 真实调用——cached 不入账由引擎 executedNodes 语义保证）。

### 定向自测（实跑命令与结果）

- `cd apps/gateway && npx vitest run` → **73 files / 626 passed | 1 todo**（含
  新增 recover-budget-resume 6 例、journal-replay-superset 2 例、
  persona-freeze 4 例；warm-cache 6 例随返回形状改动适配后仍绿）。
- `cd apps/console && npx vitest run` → **51 files / 515 passed | 5 skipped**
  （新增 run-tokens 5 例、workflow-run-card.test 5 例、run-terminal-cached
  1 例）；`node scripts/check-orphan-css.mjs` 49 css 全 import ✓。
- `cd packages/workflow && npx vitest run` → **32 files / 380 passed**
  （executor-resume 追加 cached 继承 token 2 例）。
- `npx tsc --noEmit`：gateway / console / workflow 三包全绿。
- 存量 lint warning 一条（run-terminal.tsx TerminalInputBar 的 onRerun 未用）
  经 stash 对照确认为既有非本批引入。

### 门禁复测第 1 轮失败修复（2026-10-08 集成批续二）

复测两个失败点均为上轮验证后**新进场的并行改动**（共享工作区多方向在途：
R2 暖缓存 seedTokens 继承通道 + R8 persona-freeze 测试），上轮修的
execution-live prefer-const 未复发：

1. `warm-cache.ts:195` TS2322：并行给引擎 `ResumeOptions` 加了
   `seedTokens?: Record<string, ITokenUsage | null>`（executor.ts:147，
   token 继承 PRD R2.3），gateway 侧 planWarmCacheSeeds 全程
   `Record<string, unknown>` 喂不进去。修 = 类型流全链对齐
   ITokenUsage（WarmCacheLookup 谓词签名 / planWarmCacheSeeds 返回 /
   局部变量），jsonb 边界形状断言在 buildWarmCacheSeed 的 lookup
   lambda（写方 recordDecision tokens 参数即 ITokenUsage 序列化——
   journal-writer.ts:334 同款先例）。
2. `persona-freeze.test.ts:129` no-unused-expressions：裸属性访问
   `frozen.spanWriter`（防 unused 解构的引用保持）→ `void` 表达式语句。

实测：gateway `npx tsc --noEmit` 0 错；`pnpm lint` 0 errors（20 条存量
warning）；warm-cache + persona-freeze 两测试文件 10/10；门禁同尺度全仓
`pnpm typecheck` 14/14、`pnpm lint` 9/9、`pnpm test` 14/14 tasks
successful（dist 重建前核实 `runs_active 0`，gateway 重启后 /health ok）。
