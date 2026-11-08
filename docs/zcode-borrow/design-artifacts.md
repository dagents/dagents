# design-artifacts.md — R6 渐进产物与失败抢救 · 架构设计

> 文档定位：`docs/zcode-borrow/requirements.md` R6 条目的架构设计（渐进产物方向）。上游输入：requirements.md R6 全文（含 AC-R6-1~5）、`req-runtime.md` R6 节（L175-208）、`req-console.md` R6 节（L173-205）、`req-flowlang.md` R6 节（L182-207）；架构基线 `docs/ARCHITECTURE.md`、`AGENTS.md`。
> 锚点核验说明：本文引用的 `path:line` 锚点均在 2026-10-07 工作区（分支 `feat/zcode-borrow`）逐处读源核验（span-writer、workflows.ts、runs.repo、resume-execution/execution-resume、executor.ts、canvas-results-panel、canvas-kit-page、run-terminal-format、node-spans.ts、run-live.ts、迁移链、retention、i18n、BFF 代理等 30+ 处）。
> 撞车声明：动笔时同目录已有 design-recover / design-permission / design-sharp / design-verdict 四份落稿（`ls` 核验）。本文与其协调点：**AD-R1 终裁对齐**（journal 新表 + spans 不动，见 ①）、**spans CHECK 放宽迁移 `1720000106200` 三方共同前置**（design-sharp §1.2 持有，见 ①-3）、**span-writer 写侧归可恢复性方向**（design-recover §⑦ 共享表，见 ③-1）。文件归属按「独占 = 新建文件、既有文件一律共享追加式」口径声明（⑦）。
> 修订记录：v1.1（2026-10-07 总架构师评审修订）——①按 AD-R1 终裁撤回 span-writer 写侧改造与「唯一索引重建」假设：spans 冲突目标不变、ordinal 只作标注列，deliverables 的 per-ordinal 完整事实改从 `run_node_journal` decision 行读取（spans 投影兜底）；②谱系递归 CTE 整体撤回（R1 cached 钩子回放使新 run journal 自足，继承标注直读 decision payload.lineage）——同时消解与 R2 buildWarmCacheSeed 的谱系遍历重复实现与深度上限不一致；③补 spans status CHECK 事实（`1720000007000:57-58`，此前各方文档有失实断言）与 `1720000106200` 前置依赖；④既有文件从 ownedFiles 独占分类全部改判共享追加式；⑤e2e 编号 25→26（三方占用，让位）；⑥i18n 复用既有键「等待输入」（`flows.ts:201`）；⑦journal 读点「三处」表述修正 + flow_id join 显式 cast。

## 0. 现状结论（设计起点，全部本次核验）

1. **「节点完成即写」在观测层已成立**：span-writer `onNodeEnd` 把节点终态输出整体落 `run_node_spans.output`（`apps/gateway/src/span-writer.ts:187-221`），每节点 promise 链串行保序（`span-writer.ts:49-55`），幂等 upsert `ON CONFLICT (run_id, node_id)`（`span-writer.ts:76-85`）——增量、实时、崩溃前已持久。**journal 化 report 的写侧管线就是它**，R6 的角色是**读面投影与交付**，不改写侧（见 ③-1 分工）。
2. **失败 run 的交付面缺失**：引擎失败路径 `finalOutput: null`（`packages/workflow/src/engine/executor.ts:313-321`），`runs.output` 落 `JSON.stringify(result.finalOutput ?? null)`（`apps/gateway/src/routes/workflows.ts:581`）——失败即 NULL；同步 fail 分支的 detail 只带 `executedNodes`（`workflows.ts:751-754`）；异步路径调用方只能逐节点轮询 spans；运行历史只有 `first_error`（`apps/gateway/src/repositories/runs.repo.ts:170-172`）。
3. **spans 的现状键与词表（含 CHECK 事实）**：唯一索引 `(run_id, node_id)`（迁移 `packages/db/src/migrations/1720000093000-unique-run-node-spans.ts:24-26`）——迭代体节点跑 N 项只剩最后一项的产出（末次覆盖）；且 status 列**建表即带 CHECK** `run_node_spans_status_chk CHECK (status IN ('running','done','failed','paused','unknown'))`（`packages/db/src/migrations/1720000007000-create-run-node-spans.ts:57-58`，本次 sed 核验）——词表扩新词（cached/stopped/rejected）必须先过 CHECK 放宽迁移（design-sharp §1.2 的 `1720000106200`，三方共同前置）。R1 终裁（design-recover AD-R1/AD-R2）：**唯一索引不动、spans 降格观测投影，per-ordinal 完整事实落新表 `run_node_journal`**。
4. **渐进呈现的管道在、聚合区不在**：摘要视图已逐节点渐进（running 行 live 预览 `apps/console/src/components/canvas/canvas-results-panel.tsx:567-604`、自动展开 `:574-578`、滚动跟随 `:229-233`）；watchTick 700ms 轮询 spans（`apps/console/src/components/canvas/canvas-kit-page.tsx:425-429`）；但无跨节点「产出清单」聚合视图。
5. **提取单源已有**：`extractOutputText`（`apps/console/src/lib/run-terminal-format.ts:103-123`，text/content 直出 + DirectReply 字符串化 JSON 二次解包）被摘要行（`canvas-results-panel.tsx:129`）与终端段（`run-terminal-format.ts:182`）共用——聚合区必须复用同一语义（R6 需求 4）。
6. **子流程 spans 并入父 run 同 runId**，但 `flow_id` 写的是子流程 id（`apps/gateway/src/routes/workflow-engine-service.ts:139-177`，递归装配 `flowId` 传子 id）——而读路径 `getRunNodeSpans` 的 SELECT 不带 `flow_id`（`runs.repo.ts:61-64`），归属信息在 DB 有、在 API 缺。R1 终裁的 journal 表带 `flow_id TEXT`（design-recover §1.1 DDL），与 spans 同源可判。
7. **resume 谱系与种子自足性（v1.1 修订）**：resume 新 runId + `resumed_from_run_id` 谱系（`apps/gateway/src/routes/execution-resume.ts:129,149`；COALESCE 保已存值 `runs.repo.ts:241`）；种子节点被跳过执行（`executor.ts:537-551` 只进 `processed` 不触发 `onNodeEnd`，`:261-265` 仅计入 finalOutput 判定）——**但 R1 已裁「cached 钩子回放」**（design-recover §3.1(c)2）：种子节点跳过时回放 `onNodeEnd({ status: 'cached', output: seedOutput, ... })`，由 journal-writer 写 cached decision 行（payload 带 `lineage.inheritedFromRunId`）。因此**新 run 的 journal 对种子节点自产继承行**，deliverables 无需跨 run 回溯（详见 ③-2 谱系遍历撤回论证）。
8. **partial_success 先例文案**：chat 路径「（部分分支失败，以下为完成分支的产出）」（`apps/gateway/src/routes/chat-execute.ts:532`）。

---

## ① 数据模型与迁移

**总裁决（v1.1 按 AD-R1 修订）：R6 自身零新表、零新列、零新迁移、零写侧改动**。产出记录的存储真相源 = R1 终裁的 `run_node_journal` decision 行（design-recover §1.1，迁移 `1720000110000`，可恢复性方向持有）；`run_node_spans` 降格为观测投影，R6 以其为**兜底读源**（journal 落地前的存量 run）。

1. **依赖的 R1 交付物（外部地基，本设计不重复定义，逐项引 design-recover）**：
   - 新表 `run_node_journal`（§1.1 DDL）：列含 `run_id/flow_id(TEXT)/node_id/ordinal/kind/seq/payload`，部分唯一索引 `(run_id, node_id, ordinal) WHERE kind='decision'`——**每实例一档的幂等由索引兜底**；
   - **decision 行载荷**（§1.1）：`payload = { status: 'done'|'failed'|'cached', inputHash, input, output, tokens, resolvedModel, lineage?: { inheritedFromRunId, inheritedTokens } }`——**output 全文与 tokens 在内**，deliverables 直接可读，无需回查；
   - `run_node_spans` 加 `ordinal` 标注列（存量默认 0）但**唯一索引不动**（§1.3）——迭代体 spans 仍是末次覆盖，per-ordinal 完整事实只在 journal；
   - 「cached 钩子回放」（§3.1(c)2）——种子节点在新 run 产生 cached decision 行 + lineage 载荷，是 AC-R6-3 的兑现载体（见 ③-2）。
2. **读源裁决：journal 主、spans 兜底**。`getRunDeliverables` 先查 journal decision 行（`kind='decision' AND payload->>'status' IN ('done','cached')`）；该 runId 无 journal 行（存量老 run / journal 落地前的窗口期）→ 回退 spans 投影（`status IN ('done','cached')`，迭代体只有末次——诚实降级，标注于 ⑤-1）。**读侧列名映射集中在新 repo 单点**（③-2）；journal 的 gateway 读点共三处（本 repo + 可恢复性的 `buildResumeSeed` §3.5(a) 与 `buildWarmCacheSeed` §3.7(b)），表结构由其迁移定稿，本文不自称「唯一触表点」。
3. **spans CHECK 放宽是三方共同前置（对 R6 的边界）**：迁移 `1720000106200-widen-run-node-spans-status-chk.ts`（design-sharp §1.2 持有，词表一次放宽 `+ 'rejected','cached','stopped'`，合入顺序硬约束已在其文档写死）。R6 P0 的投影词表 `'done'` 在现状 CHECK 内**零依赖**；`'cached'` 的读取依赖其写方（R1 cached 钩子回放）先落、而写方又依赖该迁移——故 R6 词表扩 `'cached'` 的批次排在 `1720000106200` 之后（⑧ 步骤 5 标注）。
4. **retention 级联**：design-recover §1.5 已为 journal 增补级联删除与 orphan 回收（对齐 `apps/gateway/src/retention.ts:52-57` 现款）——前驱/本 run 被 90 天清理后清单自然消失，无需 R6 新增清理逻辑。
5. **`runs.output` 语义不变**（R6 需求 2 末句）：失败/中断 run 的 `runs.output` 保持 null（`workflows.ts:581` 照旧），产出清单是 `runs.output` 之外的**第二交付物**，只存在于投影端点与终态响应体，不回写 runs 行——AC-R6-1 的断言点。

---

## ② @dagents/contracts 契约变更

新增 `packages/contracts/src/run-deliverables.ts`（单文件承载类型 + 纯函数；contracts 已有运行时函数先例 `ws.ts:68 isChatFrame`，gateway/console 双端已依赖本包——`apps/gateway/package.json:16`、`apps/console/package.json:16`）：

1. **`DeliverableItem` 类型**（清单条目的跨端单一形状）：
   - `nodeId: string`、`nodeLabel: string | null`、`nodeType: string | null`
   - `ordinal: number`（R1 实例键序号；非迭代节点恒 0）
   - `status: string`（deliverable 词表：当前 `'done'`；`'cached'` 随 R1/R2 落地，依赖 ①-3 前置）
   - `tokens: unknown`（原样引用，徽章由消费端 `formatTokensBadge` 派生——`run-terminal-format.ts:126-133` 已有）
   - `output: Record<string, unknown> | string | null`（**产出原样引用，服务端不提取不截断**——见决策 D）
   - `inheritedFromRunId: string | null`（v1.1 语义修订：**journal decision `payload.lineage.inheritedFromRunId` 的透传**——R1 cached 钩子回放写入、R2 暖缓存命中同字段；非继承产出为 null。此字段是继承标注的**唯一来源**，R6 不再自行沿谱系链推导）
   - `subflowName: string | null`（服务端判定：`journal.flow_id ≠ runs.pipeline_id` 时 join `flows.name`（join 用 `f.id::text = j.flow_id` 显式 cast，先例 `runs.repo.ts:118`）；根图节点为 null——客户端零归属判定逻辑）
2. **`DELIVERABLE_STATUSES`**：`['done']`（R1/R2 落地后追加 `'cached'`）——「已完成节点」的词表单源，横跨 journal decision `payload.status` 与 spans 兜底 `status` 两路过滤，gateway 投影与 console 判定共用，防止两端口径漂移。失败（`failed`）、取消残留（`paused`）、`unknown`、`running` 不入清单。
3. **`extractDeliverableText(payload): string | null`**：**从 `run-terminal-format.ts:103-123` 原样上移**（语义逐字不变：text/content 直出 + DirectReply 字符串化 JSON 二次解包），console 侧 `run-terminal-format.ts` 改为 re-export——现有 import 面（`canvas-results-panel.tsx:24`、`run-terminal-format.ts:182` 内部调用）零改动。这是「聚合区与单节点行同一提取单源」跨端成立的物理载体。
4. barrel `packages/contracts/src/index.ts` 追加 `export * from './run-deliverables.js'`（追加式共享——design-sharp 的 `trial-run.ts` 同文件追加一行，无冲突）。

**决策 D（服务端不提取文本）**：终态响应体与 node-spans 投影的 `deliverables[].output` 携带原样产出，**服务端不做任何文本摘要提取**——摘要（单行预览）由消费端用 `extractDeliverableText` 同一函数派生。理由：一旦服务端写第二套提取（哪怕只是截断），就出现两套口径（R6 需求 4 明令禁止）；AC-R6-1 的「摘要」在 UI 层断言（聚合区渲染的单行预览），响应体断言「节点名 + tokens + output 存在」。

---

## ③ 引擎/路由/gateway 改动

引擎（packages/workflow）**零改动**——R6 不碰 executor；实例键线程化与 cached 钩子回放属 R1。

1. **span-writer 零改动（v1.1 修订，撤回原写侧改造）**：按 AD-R1 终裁，spans 的 `(run_id, node_id)` 冲突目标**不变**、ordinal 只作标注列——ordinal 标注写入、`cached/stopped` 状态映射均由可恢复性方向在其 span-writer 改造中一并交付（design-recover §⑦ 共享表明文：「span-writer 本体我改状态映射 + ordinal 标注、R6 不动写侧」）。R6 对 span-writer 及其测试文件**零触碰**；`workflows.ts:612-646` 批量补写与 `writtenNodes` 过滤语义随 spans 键不变维持现状。R6 的全部增量在**读侧与投影**。
2. **新 repo：`apps/gateway/src/repositories/run-deliverables.repo.ts`**（R6 独占；journal 读侧列名映射的单点封装——journal 表结构由 R1 迁移 `1720000110000` 定稿）：
   - `getRunDeliverables(runId): Promise<DeliverableItem[]>`——主路：`run_node_journal` 的 `kind='decision'` 行按 `DELIVERABLE_STATUSES` 过滤（`payload->>'status'`），输出 `payload.output/tokens/lineage.inheritedFromRunId`；兜底路：该 runId 无 journal 行时回退 `run_node_spans`（同词表过滤、`output/tokens` 直读、`inheritedFromRunId` 恒 null——spans 无 lineage 载荷）。两路都 join `flows`（`f.id::text = <flow_id>` 显式 cast，先例 `runs.repo.ts:118`）判子流程归属名。
   - **谱系遍历撤回（v1.1 修订，替代原递归 CTE 方案）**：~~沿 `resumed_from_run_id` 链递归聚合~~ 整体删除。理由：R1 cached 钩子回放（design-recover §3.1(c)2）使 resume/暖缓存的新 run 对每个种子节点自产一条 cached decision 行（payload.lineage 标注来源 run），且部分唯一索引保证每 `(nodeId, ordinal)` 恰一档——**新 run 的 journal 自足**，前驱 run 的行不再需要。此撤回同时消解总架构师评审指出的「与 R2 buildWarmCacheSeed 谱系遍历重复实现、护栏常数不一致（10 vs 32）」问题：沿链查找从此只剩 R2 一处实现（其内部是否抽 helper 由可恢复性方向自理）。每个 run 的清单 = 该 run 视角的全部产出（含继承标注），语义比跨 run 聚合更贴合「run 的产出清单」。
   - 同文件导出纯函数 `projectDeliverableRows(rows): DeliverableItem[]`——journal 行与 spans 兜底行归一到 `DeliverableItem`（迭代多 ordinal 保留独立条目、lineage 透传、子流程归属名挂接）。纯函数可单测钉死（AC-R6-3 的读取侧载体）。
   - **排序契约**：服务端投影按实例键序返回（`(node_id, ordinal)`，journal 路可用 `seq` 同序佐证）；**拓扑序由 console 侧重排**——面板已有 `topoOrder` props（`canvas-kit-page.tsx:308-312`，摘要行同款排序 `canvas-results-panel.tsx:561-566`）。理由：服务端 node-spans 端点不持有 flow_data，拓扑知识天然在画布侧（需求 3「按拓扑序聚合」的实现分工）。
3. **node-spans 端点挂投影**（`apps/gateway/src/routes/workflows.ts:899-972`，追加式）：响应体新增 `deliverables: DeliverableItem[]`（`getRunDeliverables` 产出），与 `spans/runStatus/runError` 同信封（`workflows.ts:971`）。**不新开端点**——console 已按 700ms 轮询此端点（`canvas-kit-page.tsx:425-429`），渐进聚合需要与 spans 同节拍的数据，新端点即第二轮询；R7 若落 journal 回放端点，与本投影关注点正交（事件回放 vs 产物交付），帧形状互不影响——此为对 requirements.md R6 风险 2「与 R7 回放端点设计对齐」的裁决：**互不依赖，各自独立端点**。BFF 是透传代理（`apps/console/src/app/api/workflows/runs/[runId]/node-spans/route.ts` 的 `gatewayProxy`），新字段自动过，零 BFF 改动。
4. **终态响应体交付**（`workflows.ts:706-754`，追加式）：同步路径全部终态分支加 `deliverables` 字段——`completed`（:714-720）/ `partial_success`（:723-730）/ `budget_exceeded`（:733-741）/ `cancelled`（:742-750）/ fail 500 的 detail（:751-754）与 awaiting 分支（:706-713，挂起也交付已完成部分，R6 需求 3）。纯函数 `buildRunDeliverables(executedNodes): DeliverableItem[]`（与 repo 同文件）：过滤 `status === 'success'` 的节点（引擎词表，区别于投影词表 `DELIVERABLE_STATUSES`）、投影结构与 tokens、`output` 原样引用、`inheritedFromRunId/subflowName` 恒 null（同 run 直跑无继承；executeFlow 子节点在引擎 executedNodes 无 flow 语境，归属标注以读面为准，见 ⑤-6）。异步路径的终态交付由 ③-3 的轮询读面覆盖。
5. **metrics（NFR-6）**：`apps/gateway/src/lib/metrics.ts` 追加 counter `dagents_run_deliverables_items_total{source='journal'|'spans'|'response'}`（declareCounter 先例 `workflow-engine-service.ts:36-50`）——三路产出条目数可观测（含 spans 兜底降级的发生量，NFR-6「降级留痕」）。
6. **chat 路径划界（P0 不动）**：`chat-execute.ts` 的 @flow 失败文案（:540-547）与 `workflow-run-card.tsx` 执行卡**不进本 P0**——数据链已通（执行卡同样轮询 node-spans，未来消费 `deliverables` 字段零后端成本）；部分产出文案先例（`chat-execute.ts:532`）保留不动。此边界与 requirements.md R1 需求 6（chat 触发路径不纳入 P0）同口径。

---

## ④ console 改动

1. **聚合区落位（决策 E）**：`canvas-results-panel.tsx` **摘要视图顶部**插入「产出清单」聚合卡（可折叠，默认展开），非第四 tab——三视图框架（summary/terminal/trace + localStorage 记忆，`canvas-results-panel.tsx:255-268`）已稳定，第四 tab 稀释信息架构；摘要顶部 = 「先看全部产物，再逐节点细读」的阅读序。渐进语义：running/awaiting 态即渲染（随 spans 轮询增量），终态定格（watchTick 收尾再 fetchSpans 一次，`canvas-kit-page.tsx:388-389` 现状已保证终态数据齐全——AC-R6-2 的「不因终态丢失」由数据已在 DB + 投影读面天然成立）。
2. **数据源（决策 F）**：面板 props 新增 `deliverables: DeliverableItem[] | null`（`null` = 旧网关无字段 → 聚合区整体不渲染，诚实降级——同 `inputSupported` 的旧网关容忍模式，`node-spans.ts:119-120` 注释先例）。数据链：`node-spans.ts` 的 `NodeSpansEnvelope.data` 加 `deliverables?: DeliverableItem[]`（import 自 `@dagents/contracts`）、`RunNodeSpansResult` 与 `fetchRunNodeSpans` 透传（`node-spans.ts:42-63,130-153`）；`canvas-kit-page.tsx` 在 `fetchSpans`（:327-354）里 `setDeliverables`，props 下传（:1121-1136 面板装配点）。**聚合区只吃服务端投影**（journal 主路 + 继承标注），不做客户端兜底投影——单一数据源，继承语义只在服务端有。
3. **行结构**：行序按拓扑（`topoOrder` props 重排服务端实例键序输出，同摘要行 `canvas-results-panel.tsx:561-566`；继承行（cached/带 lineage）与真实执行行同规则参与排序——继承的种子节点排在其拓扑位，阅读序与图结构一致）。每条 = 节点名 + 单行预览（`extractDeliverableText` + 面板既有 `oneLine` 派生，`canvas-results-panel.tsx:142-145`）+ tokens 徽章（复用 `tokensBadge` :172-178）+ 归属标注（`subflowName` 非空 → 「子流程 · {name}」chip；`inheritedFromRunId` 非空 → 「继承自 {id 短码}」chip，样式仿 FlowRunsPanel 谱系 chip `flow-runs-panel.tsx:226-231`）+ 全文入口（行点击 → 既有 `ResultViewer` 全屏查看器复用，`:639-710` 三处用法先例）。迭代体节点：同一 `nodeId` 多 `ordinal` 聚合为一行、行内列各项（「第 k/n 项」），展开后逐项预览——机器面条目粒度 = 实例键，人行粒度 = 节点。
4. **未完成节点显式标注（≠失败）**：props 新增 `flowNodes: Array<{ id: string; label: string }>`（`canvas-kit-page.tsx` 从 `initialFlow.nodes` 派生，label 取 `(n.data as { label?: string })?.label ?? n.id`——与 gateway `nodeLabelById` 同语义，`workflow-engine-service.ts:183-188`）。聚合卡尾部：`flowNodes` 中不在 deliverables（任一 ordinal）的节点 → 灰行「未执行」；有 running span → 「执行中」；awaiting 挂起节点 → 「等待输入」（状态取自面板已有 `spans` props，零新数据）。
5. **一键复制/下载**：`run-terminal-format.ts` 新增纯函数 `buildDeliverablesTranscript(deliverables): string`（markdown 形态：节点名标题 + 提取正文/JSON 兜底 + tokens 行；模式仿 `sectionTranscript` `run-terminal-format.ts:209-229`）。复制走 `navigator.clipboard`，下载走 Blob（`text/markdown`，文件名 `deliverables-{runId 短码}.md`）。
6. **跳终端锚点（AC-R6-5）**：`run-terminal.tsx` 的 `SectionView`（:304）根元素追加 `data-terminal-section={section.id}`（section id = nodeId，`run-terminal-format.ts:192`）——纯属性零行为变化，chat 面（`assistant-content.tsx` 也用 RunTerminal）无感。聚合区行内「终端」入口 → `switchResultView('terminal')` + 下一帧 `scrollIntoView` 到 `[data-terminal-section="..."]`。
7. **CSS + i18n**：新样式追加进 `canvas-results.css`（组件已 import，`canvas-results-panel.tsx:31`——孤儿 CSS 护栏天然满足）；文案中文自然键 + `apps/console/src/i18n/en/flows.ts` 补英文词条（先例 :281-282）：产出清单 / 复制产出清单 / 下载产出 / 未执行 / 执行中 / 继承自前次运行 / 子流程 / 第 {k}/{n} 项 / 共 {n} 项产出 等。**「等待输入」复用既有键勿重加**（`flows.ts:201` 已有 `'Awaiting input'`，本次 grep 核验——同文件重复键是 TS 编译错）。

---

## ⑤ 兼容与存量 run 数据策略

1. **存量 spans 兜底可用、journal 前老 run 诚实降级**：journal 落地前的历史 run 无 decision 行 → 投影自动走 spans 兜底路（output/status/tokens 既有列直读、`inheritedFromRunId` 恒 null）——历史 run 的聚合区即刻可用；**迭代体节点只有末次产出**（spans 覆盖语义，AD-R1 终裁保留），聚合区对其显示「仅存末次（历史 run 无 per-ordinal 记录）」诚实标注，不伪装完整。
2. **词表双读**：投影按节点产出态过滤（`done`/`cached`），**不按 run 终态过滤**——存量 `cancelled` run、未来的 `stopped/partial_success/budget_exceeded` run 一视同仁交付已完成部分（R6 需求 2「任意终态」的字面实现；boot sweep 收敛（R1/R3）后中断 run 的产出记录崩溃前已持久，`stopped(interrupted)` 场景零额外工作——AC-R6-2 的 stopped 分支）。
3. **answer 路径（同 runId 原地续跑）**：journal decision 部分唯一索引 `(run_id, node_id, ordinal)` 保证同实例只一档，清单天然无重复。
4. **retention 断链诚实降级**：run 行（含 journal 级联，R1 §1.5 增补）被 90 天 retention 清理后清单随之消失，不报错不告警（与 R2 需求 6 同哲学）。
5. **继承标注单源（v1.1 修订）**：`inheritedFromRunId` 唯一来源 = journal decision `payload.lineage`（R1 cached 钩子回放写入、R2 暖缓存命中同字段）——R6 只透传展示，**无跨 run 合并规则**（原「本 run 优先」合并随谱系遍历一并撤回，无双重呈现问题可解）。暖缓存 run 的 cached 行、resume run 的种子行都由该机制自产；「全新重跑」（R2 需求 5 分叉）不写谱系不产 cached 行 → 清单只含本 run 真实执行，行为正确。
6. **同步响应 vs 读面的差异**：`buildRunDeliverables`（终态响应体，引擎视角）无 flow 语境 → `subflowName` 恒 null；journal/spans 读面可判。两面的 `output/tokens/ordinal` 一致，归属标注以读面为准——诚实呈现能力差异，不伪装。
7. **旧网关/灰度期与 R1 时序窗**：console 对 `deliverables` 字段缺席渲染降级（④-2）；R6 先于 R1 cached 钩子回放合入的窗口期，resume run 的清单只含新 run 真实执行行、不显示种子节点——不假造继承（AC-R6-3 的完整断言在 R1 对应批次落地后生效，依赖顺序见 ⑧）。
8. **已知语义边界**：迭代体多 ordinal 行在**终端视图**仍按 nodeId 合并为一段（`TerminalSection.id = nodeId`，`run-terminal-format.ts:192`；spans 消费键不变是 AD-R1 终裁前提，R8 另给 stdin 行 `nodeId[ordinal]` 后缀）——聚合区跳转落同段，ordinal 级跳转细分不进 P0。

---

## ⑥ 测试计划

| 层 | 位置 | 覆盖 |
|---|---|---|
| contracts 单测 | `packages/contracts/src/__tests__/run-deliverables.test.ts`（新） | `extractDeliverableText` 语义钉子（搬家回归：text/content 直出、DirectReply 二次解包、null 形状）；`DELIVERABLE_STATUSES` 词表 |
| gateway 单测（纯函数） | `apps/gateway/src/__tests__/run-deliverables.test.ts`（新） | `projectDeliverableRows`：journal 行投影（output/tokens/lineage 透传）、spans 兜底行归一（inheritedFromRunId 恒 null）、迭代多 ordinal 保留独立条目、空输入；`buildRunDeliverables`：success 过滤、tokens/output 投影、failed/cancelled 节点剔除 |
| gateway 单测（真库 `dagents_gw_test`） | 同上文件 | `getRunDeliverables`：journal 主路（迭代 3 项产 3 条 done decision）、**兜底切换**（无 journal 行的 runId 回退 spans）、子流程 flow_id join 归属名（text cast）、cached decision 行（lineage 载荷 → inheritedFromRunId 透传，AC-R6-3 读取侧） |
| console lib 单测 | `apps/console/src/lib/run-terminal-format.test.ts`（新，先例 `run-trace-model.test.ts`） | `buildDeliverablesTranscript` 内容；**AC-R6-4 钉子**：同一 span 载荷过 `extractDeliverableText`（聚合路径）与 `spanToDisplay`（单节点行路径，`canvas-results-panel.tsx:129`）产出文本一致 |
| e2e | `apps/console/tests/e2e/26-run-deliverables.spec.ts`（新；编号 26——25 被 design-verdict/design-sharp 两方占用，本方向让位，仓内双 24 重号先例可容它们） | 见下方 AC 对照 |

**AC 对照**：

- **AC-R6-1（e2e）**：mock provider 规则编排 5 节点流程第 4 节点失败 → 断言 ① node-spans 响应 `deliverables.length===3` 且条目含 nodeId/nodeLabel/tokens/output；② 同步 POST 分支（不走 async）响应体含 deliverables；③ 面板聚合区渲染 3 行预览；④ `runs.output` IS NULL（SQL 断言，`workflows.ts:581` 语义不变）。
- **AC-R6-2（e2e）**：慢速流 mock（delay 规则）跑长任务 → 中途取消（现状 `cancelled` 词）→ 面板聚合区完整呈现取消前 done 节点产出；`stopped(interrupted)` 场景依赖 R1/R3 落地后补跑（依赖顺序在 ⑧ 步骤 5 标注，e2e 用例参数化两词）。
- **AC-R6-3（单测 + e2e 叠加，v1.1 载体修订）**：兑现载体 = R1 cached 钩子回放 + journal decision 部分唯一索引（R6 只做读取投影）。单测：`getRunDeliverables`/`projectDeliverableRows` 对 cached decision 行的恰一条断言；e2e 叠加在既有 `24-run-resume.spec.ts` 场景族——失败 run resume 后 node-spans `deliverables` 中种子节点恰一条、带 `inheritedFromRunId`、无重复 `(nodeId, ordinal)`。**依赖 R1 §3.1(c)2 落地后生效**（⑤-7 窗口期边界）。
- **AC-R6-4（单测）**：见 console lib 单测行——同一提取单源的结构性钉子。
- **AC-R6-5（UI/e2e）**：含 executeFlow 子流程的 flow（`workflow-engine-service.ts:139-177` 数据链）→ 聚合区子流程行带「子流程 · {name}」chip；行内终端入口点击后断言视图切到 terminal 且 `[data-terminal-section]` 目标段滚入视口。

**回归红线**：既有 e2e 全绿（NFR-2）；`24-run-resume.spec.ts`（失败→resume 零重跑）必须不回归（R6 不动写侧，风险面已收窄到读路径）；gateway 单测库迁移链自动建库保持通过（NFR-1，含 R1 的 `1720000110000` 与 sharp 的 `1720000106200` 入链后）。

---

## ⑦ 涉及文件清单（ownedFiles）

> v1.1 分类口径修订：**独占 = 仅新建文件**；既有文件一律共享追加式（总架构师评审：独占标签会误导并行实施的文件归属仲裁）。R6 对 `span-writer.ts` 及其测试**零触碰**（写侧归可恢复性方向，design-recover §⑦）。

**R6 独占（全部新建）**：

- `docs/zcode-borrow/design-artifacts.md`（本文档）
- `packages/contracts/src/run-deliverables.ts`
- `packages/contracts/src/__tests__/run-deliverables.test.ts`
- `apps/gateway/src/repositories/run-deliverables.repo.ts`
- `apps/gateway/src/__tests__/run-deliverables.test.ts`
- `apps/console/tests/e2e/26-run-deliverables.spec.ts`

**共享文件（追加式，多方向同批动刀，标注合并批次）**：

- `packages/contracts/src/index.ts`（barrel 追加；design-sharp 的 `trial-run.ts` 同文件追加，两行互不冲突）
- `apps/gateway/src/routes/workflows.ts`（deliverables 两处追加：node-spans 响应 + 终态分支；design-recover 同文件动 run 编排/批量补写——追加区正交）
- `apps/gateway/src/lib/metrics.ts`（counter 追加）
- `apps/console/src/components/canvas/canvas-results-panel.tsx`（R6 聚合区 + R2 cached 徽章 + R3 stopped 标签 + R8 stdin 行 ordinal——**NFR-5 合并一批交付**；R6 改动面 = 摘要视图内新聚合卡 + 新 props，与行级状态改动正交）
- `apps/console/src/components/canvas/canvas-results.css`（R6 聚合卡样式 + R2/R3 状态样式同文件追加）
- `apps/console/src/components/canvas/canvas-kit-page.tsx`（props/state 追加：deliverables、flowNodes；R1/R2/R3 同文件动刀——NFR-5 合并批）
- `apps/console/src/components/run-terminal.tsx`（`SectionView` 追加 data 属性，chat 面共用无感）
- `apps/console/src/lib/run-terminal-format.ts`（`extractOutputText` 改 re-export + `buildDeliverablesTranscript` 追加；R5 轮次行 / R8 `nodeId[ordinal]` 同文件追加——design-recover §⑦ 共享表同列）
- `apps/console/src/lib/node-spans.ts`（R6 加 envelope `deliverables` 字段；design-recover 加 `RunNodeSpan.ordinal`——同文件追加式）
- `apps/console/src/i18n/en/flows.ts`（词条追加；permission/sharp/artifacts 至少三方向同文件加词条——键名先查重，「等待输入」类既有键复用不重加）

---

## ⑧ 分步实施（可恢复性标注）

> 「地基」= 契约 + journal 读路径核心——R6 的可独立先行部分；类比可恢复性方向的地基（契约+迁移+引擎核心）。

- **步骤 0（外部前置，可恢复性方向持有 + 迁移三方共同前置）**：① R1 journal 迁移 `1720000110000`（`run_node_journal` DDL + decision 部分唯一索引）；② `IExecutedNode.ordinal` 引擎线程化 + **cached 钩子回放**（§3.1(c)2——AC-R6-3 的兑现载体，R6 词表扩 `'cached'` 与 AC-R6-3 断言都以其为前提）；③ spans CHECK 放宽迁移 `1720000106200`（design-sharp 持有，三方共同前置——对 R6 仅在②的 cached span 落库时成为硬依赖）。R6 的步骤 1 与其零依赖可并行；步骤 2 的真库测试、迭代多档语义依赖其落地。
- **步骤 1【地基】contracts**：`run-deliverables.ts`（类型 + 词表 + `extractDeliverableText` 上移）+ console re-export + 单测。零依赖，随时可合入（搬家回归钉子护住提取语义）。
- **步骤 2【地基】读路径核心**：`run-deliverables.repo.ts`（journal 主路 + spans 兜底路 + `projectDeliverableRows` 纯函数）+ 纯函数单测先行；spans 兜底路的真库测试零依赖可先行，journal 主路测试在 R1 迁移落地后激活。
- **步骤 3 gateway 交付面**：node-spans 端点挂 `deliverables` + `workflows.ts` 终态响应五分支 + metrics counter。步骤 2 合入即灰度可用（API 消费方先行受益；journal 未落地时自动走 spans 兜底，行为可用）。
- **步骤 4 UI 聚合区（NFR-5 合并批）**：`node-spans.ts` 类型扩展 → `canvas-kit-page` props/state → 面板聚合卡 + 未完成标注 + 归属 chip + 复制/下载 + 终端锚点 + CSS + i18n。**与 R2（cached 徽章）、R3（stopped 标签）同一批动 `canvas-results-panel.tsx`**，避免结果面板反复动刀。
- **步骤 5 e2e + 存量回归 + 词表扩展**：`26-run-deliverables.spec.ts`（AC-R6-1/2/5；AC-R6-3 叠加 24 号场景族，R1 cached 钩子回放落地后生效）+ `DELIVERABLE_STATUSES` 扩 `'cached'`（前置：`1720000106200` 已合 + R1 §3.1(c)2 已落）+ 全量 e2e 回归 + `stopped(interrupted)` 参数化用例在 R1/R3 落地后补跑。

依赖链总结：`R1 journal 迁移 + cached 钩子回放（③②①前置）─→ 步骤 2 journal 主路测试 / 步骤 5 cached 词表与 AC-R6-3 完整断言`；`步骤 1 ─→ 步骤 2（spans 兜底路先行）─→ 步骤 3 ─→ 步骤 4` 为 R6 自有链，步骤 1-2 即地基，span-writer 写侧零改动使 R6 与 R1 的实施耦合面收窄到「读 journal」一点。
