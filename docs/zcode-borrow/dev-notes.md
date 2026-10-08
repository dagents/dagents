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
