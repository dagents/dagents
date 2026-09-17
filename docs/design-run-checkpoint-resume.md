# 设计：执行状态检查点与断点续跑（Run Checkpointing & Resume）

> 状态：**已实施（P0+P1+P2 全量落地）** · 设计 2026-09-18 · 实施 2026-09-18
> 实施记录：引擎 ResumeOptions/迭代游标/awaiting（executor-resume.test 8 例）；run_checkpoints 表+迁移；三端点（checkpoint/resume/answer）+ BFF 透传；checkpoint 写入经串行链（波次/挂起/终态同链保序——迟到的波次快照不再覆盖终态 failedAt 或 awaiting 载荷，e2e 实测竞态修复）；MA-09 契约修订（缺答案 → awaiting 而非报错）；e2e RM-01~03（spec 24）含零重跑证明。与设计偏差：§7 P0 的「读 spans 干跑」未单独落地（spans 反演被否决后失去独立价值，表结构先行）；聊天回流优先走 DB awaiting（进程内 Promise 仅兜底）。
> 关联：PM 优化批次建议 #1（失败节点断点续跑）· 2026-09-17 架构评审遗留（HumanInput 挂起态在内存）· `docs/workflow-engine.md` 执行模型
> 落地节奏：三阶段（见 §7），P0 可独立先行

---

## 1. 背景与问题

产品的核心场景是「多 Agent 长流程」——一次运行 5~9 分钟、串 4~7 个 CLI Agent 是常态。当前架构下，执行状态**只存在于网关进程内存**（`DagExecutor` 的 RunContext + `pendingByChat` 的挂起 Promise），由此产生三类真实损失：

| 损失 | 现状机制 | 代价 |
|---|---|---|
| **失败即全重跑** | 波次调度无恢复入口；任一节点失败 → run 终结，重跑从 Start 重新烧全部 token | 长 CLI 链尾部失败时，前 5 分钟的 LLM/Agent 产出全部作废重付费 |
| **HumanInput 挂起跨重启即死** | `human-input.ts:40` `pendingByChat` 内存 Map + 5min 看门狗；gateway 重启 → Promise 消失，boot 时只补一条「已中断」道歉消息 | 用户等人工确认期间不能重启网关（运维枷锁）；挂起 5 分钟无人应答也死 |
| **中断的静默不对称** | 节点产出其实已落库（`run_node_spans.input/output`），但引擎从不读回 | 数据在、能力缺——「看得见的进度」和「可恢复的状态」之间断了一层 |

PM 视角的用户诉求合并为一句话：**「我跑到第 6 个节点失败了，修好后从第 6 个继续，前面的别重跑。」**

## 2. 目标与非目标

**目标**
- G1 失败/取消的 run 可从**失败节点**续跑，已完成节点的产出原样复用（不重执行）
- G2 迭代节点支持**项级游标**续跑（跑完 37/100 项中断，从第 38 项继续）
- G3 HumanInput 挂起态**落库**：gateway 重启后挂起仍在（超时窗内），应答可恢复执行
- G4 续跑语义对副作用**诚实**：CLI 节点已发生的文件写入/命令执行不可回滚，产品文案明示 at-least-once

**非目标（明确不做）**
- 分布式/多实例执行（单进程红线未变，本设计不引入跨进程锁）
- 节点级输出的版本去重（同节点续跑产生的新输出直接覆盖 checkpoint 旧值——单线程波次内无并发写同节点）
- 图结构变更后的续跑（checkpoint 与当前 flow_data 的拓扑指纹不匹配 → 拒绝续跑，提示另存新图）——热编辑后续跑是 V2+ 议题

## 3. 现状机制速写（设计所依赖的代码事实）

- **波次调度**：`executor.ts` 的 `runWaves(ctx, scope, entryEdges, outputs, seed)`——节点可执行性由 `outputs: Map<nodeId, output>` 驱动；跳过某节点 = 不往 outputs 写它的 key，其下游因无 resolved 边而级联 skip。**这意味着「从断点继续」的引擎本质 = 预填充 outputs 后正常执行**——恢复入口的改造成本天然低。
- **迭代体**：`runIterationBody` 顺序跑 items，每项一轮完整 `runWaves`；当前无项游标，`completedIterations` 只是计数。
- **span 落库**：`(run_id, node_id)` 唯一——迭代体节点跑 N 项 = 同一行**末次覆盖**（span-writer upsert 语义）。因此 **spans 不能作为恢复数据源**（迭代产出只剩最后一项；且 `output` 列为展示策展形态，非引擎原始 `INodeOutput.output`）。这是「新表 vs 复用 spans」决策的关键事实。
- **HumanInput**：节点 run() 内 `await resolver(prompt)`；聊天路径的 resolver 持有内存 Promise；画布路径无 resolver 直接抛错（2026-09-18 已加运行前预供答案缓解）。
- **注册表/取消**：`executionRegistry` byRun/byChat 双键；取消经 AbortSignal 贯穿。

## 4. 概念设计

一句话：**把 RunContext 里决定「接下来跑什么」的最小状态集，在关键节点快照落库；恢复时重建这个状态集，让普通执行路径接管。**

```
执行中                                 恢复
┌─────────────┐  每波次完成/挂起/失败   ┌──────────────┐
│ DagExecutor │ ───────────────────► │ run_checkpoints │
│ (RunContext)│                      │ (JSONB 快照)    │
└─────────────┘                      └──────┬───────┘
                                            │ resume 入口读回
                                            ▼
                                     预填充 outputs/runtime/迭代游标
                                     → 同一个 runWaves 继续跑
```

三条恢复路径共用一套 checkpoint：
1. **断点续跑**（失败/取消后，用户显式发起，新 runId 承载、checkpoint 继承）
2. **HumanInput 应答回流**（挂起 run 被应答唤醒，同 runId 原地继续——Promise 换成落库挂起）
3. **跨重启恢复**（G3：boot 时发现 awaiting 状态的 checkpoint 且超时窗未过 → 重建挂起）

## 5. 方案对比与决策

| | A. 独立 checkpoint 表（选定） | B. 从 spans 反演 | C. 事件溯源重放 |
|---|---|---|---|
| 数据保真 | 精确（引擎原始输出 + 迭代游标） | 不可行——迭代体末次覆盖、output 是策展形态 | 精确但需要全量事件流 |
| 改造面 | 新表 + executor 快照钩子（低） | span-writer 语义重写（高且破坏展示契约） | 引擎全量重设计 |
| 恢复速度 | O(读一行 JSONB) | O(全 span 扫描+反演) | O(重放全部节点)——等于变相全重跑，目标落空 |
| 审计分离 | checkpoint=控制态 / spans=观测态，职责干净 | 两态混载互相污染 | 需另建观测通道 |

**决策：A。** 理由核心是 §3 的 span 覆盖语义事实；且「控制态/观测态分离」与本仓既有的「采集层保全量、展示层做策展」契约（终端视图 PRD）同构。

## 6. 详细设计

### 6.1 数据模型

```sql
CREATE TABLE run_checkpoints (
  run_id      UUID PRIMARY KEY,          -- 首个 run 的 id；续跑产出的新 run 不建新 checkpoint，而是 UPDATE 此行
  flow_id     UUID NOT NULL,
  status      TEXT NOT NULL,             -- 'running' | 'awaiting_input' | 'resumable' | 'terminal'
                                         -- resumable = failed/cancelled 且快照完整
  topo_hash   TEXT NOT NULL,             -- 拓扑指纹（见 §6.4）
  snapshot    JSONB NOT NULL,            -- §6.2 的快照结构
  awaiting    JSONB,                     -- status='awaiting_input' 时：{nodeId, prompt, inputType, options, deadlineAt}
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_run_checkpoints_status ON run_checkpoints (status);
```

迁移 `1720000096000-create-run-checkpoints.ts`；entity 补 `run-checkpoint.entity.ts`（遵守既有 entity 约定：schema 定义 + 类型来源，热路径 raw SQL）。

### 6.2 快照结构（snapshot JSONB）

```ts
interface RunCheckpointSnapshot {
  /** 已完成节点的原始引擎输出（INodeOutput.output 原样，非展示形态）。 */
  outputs: Record<string, Record<string, unknown>>
  /** runtime state 顶层快照（含 $start 别名、各节点键、flow 键）。 */
  runtime: Record<string, unknown>
  /** 迭代游标：controllerId → 已完成项数 + 每项末态（供下游聚合复算）。 */
  iterationProgress: Record<string, { completed: number; itemOutputs: Array<Record<string, unknown>> }>
  /** 失败现场（resumable 时）：失败节点 id 与错误摘要。 */
  failedAt?: { nodeId: string; error: string }
}
```

写入时机（executor 钩子，经 gateway 注入，引擎保持 DB-free）：
- 每波次收敛后（增量合并，节流 1s/波次——波次粒度本来就有停顿，无需再节流）
- 迭代每项完成后（G2 游标）
- HumanInput 挂起时（status→awaiting_input + awaiting 载荷）
- run 终态时（status→terminal，快照保留 N 天随 retention 清理）

### 6.3 引擎改造（@dagents/workflow）

```ts
// executor.ts 新增（RunContext 拆解后已是显式对象，注入点是干净的）
export interface ResumeOptions {
  /** 预填充的节点输出（来自 checkpoint.snapshot.outputs）。 */
  seedOutputs: Record<string, Record<string, unknown>>
  /** 预填充的 runtime state。 */
  seedRuntime?: Record<string, unknown>
  /** 迭代游标：controllerId → { completed, itemOutputs }。 */
  iterationProgress?: Record<string, IterationProgress>
  /** 续跑时仍要重跑的节点（默认含失败节点及其全部下游）。 */
}
```

- `execute(flow, input, { ...opts, resume })`：构造 RunContext 时以 seedOutputs 初始化 `nodeOutputs`、以 seedRuntime merge 进 runtime；`runWaves` 首波装配照常（seed 过的节点已 processed 判定：**在 outputs 里的节点视为已执行**，其下游 pending 即刻满足）——`runWaves` 只需一处改动：初始 `processed = new Set(Object.keys(seedOutputs))`。
- 迭代续跑：`runIterationBody` 读 `iterationProgress[controllerId]`，从 `completed` 项继续；已完项的 `itemOutputs` 直接进聚合（不重跑）。
- 失败重入的节点选择：默认「失败节点起，其后全部重算」（下游可能消费了失败前状态，保守正确）；不做单节点外科手术式重试（V2+）。
- HumanInput 挂起改造：节点的 resolver 改为可选「持久模式」——resolver 抛出 `HumanInputPendingError{prompt,...}` 而非 await；executor 捕获后写 checkpoint(awaiting_input) 并以特殊状态 `awaiting` 结束本次 execute（**不占 executionRegistry 活动位**，但 run 行状态为 `awaiting_input`——新增 runs.status 枚举值）。应答到达时 gateway 重建 executor 以 resume 语义继续（同 runId）。

### 6.4 拓扑指纹（topo_hash）

节点 id/类型/出边三元组的排序序列化 SHA-1（不含节点配置——配置变更允许续跑，用户改 prompt 后续跑=用新配置跑剩余节点，**这是特性不是缺陷**；拓扑变了则节点身份错乱必须拒绝）。不匹配 → 422 `topology changed`，UI 提示「图结构已变更，无法续跑」。

### 6.5 API 契约

```
POST /api/v1/workflows/runs/:runId/resume        body: { input?, humanInputs?, directoryId? }
  → 200 { runId: <新runId> }（异步，同 ?async=1 语义）
  → 404 run 无 checkpoint / 409 status 非 resumable / 422 拓扑不匹配
POST /api/v1/chats/:chatId/answer                 body: { runId, answer }
  → 唤醒 awaiting 的 run（聊天应答回流既有路径升级为显式契约）
GET  /api/v1/runs/:runId/checkpoint               → { status, failedAt, resumableNodes... }（UI 判定入口）
```

### 6.6 Console 交互

- 失败节点卡片（结果面板 + 终端视图）：`failed` 且 checkpoint resumable → 显示「从此处继续」按钮 → 复用运行输入面板（预供答案区已有）+ 徽章「将跳过前 N 个已完成节点」。
- 画布旁观 awaiting 状态：节点徽章「⏸ 等待人工输入」+ 倒计时（PM 建议 #3 顺势落地）。
- 运行历史行：resumable 的失败 run 标「可续跑」chip。

### 6.7 副作用与并发语义（诚实声明）

- **at-least-once**：被重跑节点的 CLI 副作用（写文件/执行命令）会再次发生。UI 在续跑确认处明示。已完成节点**不会**重执行（skip 是结构保证，非 best-effort）。
- 幂等护栏：同 checkpoint 的 resume 并发发起 → 第二个请求 409（registry 已有 runId 次键，天然互斥）。
- 取消语义不变：续跑中的 run 可取消，checkpoint 回到 resumable。
- retention：checkpoint 随 run 90 天清理（复用 retention.ts，加一张表）。

## 7. 分阶段落地

| 阶段 | 范围 | 依赖 | 交付判定 |
|---|---|---|---|
| **P0 干跑跳过**（1 天） | 不落库：resume API 直接读**当前 run 的 spans**（限无迭代节点的 flow），seedOutputs 喂引擎 | §6.3 的 resume 入口 | 无迭代的线性/分支流失败后可跳过已完成节点续跑；e2e 钉住 |
| **P1 完整 checkpoint**（2~3 天） | 新表 + 快照钩子 + topo_hash + resume API 全量 + 迭代游标 | P0 | G1+G2 全达；含迭代的流程可项级续跑 |
| **P2 HumanInput 持久挂起**（2 天） | awaiting 状态 + 落库挂起 + boot 恢复 + chats/:id/answer + UI 徽章 | P1 | G3 达；重启网关不丢挂起（e2e：挂起→杀网关→重启→应答→run 完成） |

P0 的价值：把引擎 resume 入口（真正的改造风险点）先行落地并用真数据验证，P1 只是换更精确的数据源。

## 8. 测试计划

- **引擎单测**（executor-resume.test.ts）：seedOutputs 跳过语义（已完成节点 run() 不被调用——spy 钉死）；迭代游标续跑聚合正确；失败节点下游重算；resume 状态下取消。
- **网关集成**：checkpoint 写入时机（波次/迭代/终态）；resume API 404/409/422 矩阵；并发 resume 互斥。
- **e2e**：WF-14（新）「失败→修因→续跑→跳过已完成节点→完成」，断言 mock LLM 未收到已完成节点的二次调用（mock /__control/calls 是现成的确定性证据源）；ED 组补「迭代 37/100 中断续跑」。
- **P2 专项**：挂起→SIGKILL 网关→boot→应答→完成（复用测试工程师轮的停机测试基建）。

## 9. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| seedOutputs 与节点实际输出形状漂移（老 checkpoint vs 新引擎） | snapshot 带 engineVersion；不匹配拒绝续跑（诚实失败） |
| 大 outputs 快照膨胀（HTTP 节点 32KB 截断前的原文） | snapshot 单行上限 4MB（保险丝，超限节点产出截断存元数据并标记 degraded——续跑时该节点强制重跑） |
| 挂起 run 占用 runs.status 新枚举，旧消费端不识别 | 枚举向前兼容：console 端未知状态按 running 展示（既有 default 分支已如此） |
| **开放**：续跑产出的新 run 与原 run 的谱系展示（历史树？） | 倾向 checkpoint.run_id 不变 + runs 加 resumed_run_id 链；UI 细节 P1 评审定 |
| **开放**：节点配置变更后续跑用新配置——是否需要「快照配置 vs 当前配置」差异提示 | P1 不做，观察用户反馈 |

## 10. 验收标准

1. 含 4 个 LLM 节点的线性流，第 3 个失败 → 续跑后 mock LLM 只收到第 3、4 节点的调用（**用零token 重跑证明价值**）
2. 100 项迭代在第 38 项中断 → 续跑从第 39 项继续，聚合含全部 100 项产出
3. HumanInput 挂起中 SIGKILL 网关 → 重启 → 超时窗内应答 → run 正常完成
4. 拓扑变更后续跑被 422 拒绝且文案指路
5. 全量 e2e 保持全绿（既有 212 例零回归）
