# 百万智能体平台 —— 架构设计文档（MVP）

> **版本**：v0.1（MVP 阶段）
> **日期**：2026-07-06
> **定位**：先不做"百万级"，但架构必须为水平扩展留好接口
> **状态**：草案，供团队评审

---

## 0. TL;DR

- 平台 = **对话式智能体运营**（lobehub）+ **可视化流水线编排引擎**（langflow），通过 HTTP 解耦集成。
- MVP 目标：在**单机 / 小集群**上跑通"定义智能体 → 编排流水线 → 批量执行任务 → 监控资源与日志"全闭环。
- 扩展性策略：**无状态服务层 + 共享存储 + 异步任务队列**。MVP 用单实例，但所有有状态逻辑隔离到存储层，使未来横向扩展只需"加机器 + 加 worker"，不改业务代码。
- 核心取舍：不追求自研全部组件，复用两个成熟开源项目的内核，自研集中在**调度层 / 网关层 / 资源治理**。

---

## 1. 背景与问题定义

### 1.1 要解决什么问题

构建一个支撑大量智能体（agent）与流水线（pipeline）的平台，覆盖五类能力：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 解题智能体流水线 | 把一个复杂目标拆解为多步骤、多 agent 协作的执行流 |
| 2 | 批量任务执行与复现 | 对一批输入（如多篇论文、多份数据）跑同一流水线，结果可追溯、可复现 |
| 3 | 资源管理面板 | 统一管理算力（GPU/CPU/沙箱）与 API 资源（LLM key、凭证） |
| 4 | 智能体 / 流水线 / 任务的"定义" | 三类核心实体可声明式定义、版本化、复用 |
| 5 | 用户、监控、日志 | 多租户、RBAC、运行可观测性 |

### 1.2 为什么不自研而从开源组合起步

| 选项 | 代价 | 结论 |
|---|---|---|
| 全自研 | 需重写 workflow 引擎、agent runtime、可视化编辑器、对话 UI，数月起步 | ✗ |
| 仅 langflow | 多 agent 协作（带状态/审批/返工）弱、对话运营 UI 弱 | ✗ |
| 仅 lobehub | 无可视化 DAG 流水线、批量编排弱 | ✗ |
| **lobehub + langflow** | 两套技术栈（TS + Python）、需写集成层 | **✓ 互补性最强** |

### 1.3 不做什么（MVP 边界）

- ❌ 不做"百万 agent"的分布式调度（留接口，见 §9）
- ❌ 不做 GPU 训练队列（沙箱可执行代码，但 GPU 调度需自研，超出 MVP）
- ❌ 不做全自动科研复现（复现成功率受限于 LLM 能力与论文本身，平台只提供框架）
- ❌ 不做多租户强隔离（MVP 用 workspace 软隔离）

---

## 2. 术语对齐

本平台有三套易混概念，必须先对齐，否则后续设计全乱。

### 2.1 两类"Workflow"——这是最大的认知陷阱

| | lobehub 的 "workflow" | langflow 的 "workflow / Flow" |
|---|---|---|
| **本质** | QStash 定时任务 + 事件触发器 + 运行守卫 | 可视化 DAG 流水线引擎 |
| **构成** | `runGuard` / `scheduleDispatch` / `onTopicComplete` | `Graph`（2601 行 DAG 引擎）+ `loop`/`sub_flow`/`conditional_router` |
| **是否可视化编辑** | ❌ 代码定义 | ✅ 拖拽编辑器 |
| **是否可版本化复现** | ❌ | ✅ `flow_version` |
| **本平台中的角色** | **后台调度器**（定时巡检、事件回调） | **流水线定义与执行引擎** |

> ⚠️ **设计原则**：本平台文档中，**"流水线 / Pipeline"统一指 langflow 的 Flow**；**"定时任务 / 调度"指 lobehub 的 workflow**。两者职责绝不混用。

### 2.2 三类核心实体

```
智能体 (Agent)     流水线 (Pipeline)     任务 (Task)
   │                   │                   │
   ▼                   ▼                   ▼
"一个会做事的角色"   "一条可复现的执行路径"  "一次具体的执行实例"
```

| 实体 | 定义在哪 | 实例化产物 | 类比 |
|---|---|---|---|
| **Agent** | lobehub `agents` 表 | 一次 LLM+工具的执行 | 程序里的"函数/对象" |
| **Pipeline** | langflow Flow（版本化） | 一次 Flow 运行（job） | "脚本/配方" |
| **Task** | lobehub `tasks` 表（assignee=user+agent） | 一次可追踪的工作单元 | "一次调用" |

关系：**Pipeline 编排 Agent；Task 记录 Pipeline/Agent 的执行实例**。

### 2.3 异构智能体（Heterogeneous Agent）

指**外部 CLI / 远程 runtime**，自带工具集与模型，不占 lobehub 的插件位。lobehub 已支持：

| 类型 | kind | MVP 可用性 |
|---|---|---|
| `claude-code` | cli | ✅ 开箱（adapter 完整） |
| `codex` | cli | ✅ 开箱 |
| `hermes` / `amp` / `opencode` / `openclaw` | remote/cli | 🟡 预留位，需补 adapter |

---

## 3. 架构总览

### 3.1 分层视图

```
┌─────────────────────────────────────────────────────────────────┐
│  接入层 (Access)                                                 │
│  Web UI (lobehub Next.js + langflow React)  · OpenAPI · Webhook │
├─────────────────────────────────────────────────────────────────┤
│  网关层 (Gateway) —— 本平台自研核心①                              │
│  统一鉴权(SSO) · 请求路由 · 限流 · API Key 治理 · 审计           │
├──────────────────────┬──────────────────────────────────────────┤
│  编排层 (Orchestration)                                          │
│  ┌──────────────────┐ │ ┌────────────────────────────────────┐ │
│  │ lobehub Server   │ │ │ langflow Server                    │ │
│  │ (Hono/Node)      │ │ │ (FastAPI/Python)                   │ │
│  │ · Agent 运行时   │◄┼─┤ · Flow DAG 引擎                    │ │
│  │ · 多agent协作    │ │ │ · 批量执行(loop/sub_flow)          │ │
│  │ · 异构agent接入  │ │ │ · 版本化复现(flow_version)         │ │
│  │ · 工具/技能/MCP  │ │ │ · 组件市场                         │ │
│  └────────┬─────────┘ │ └──────────────┬─────────────────────┘ │
├───────────┼─────────────────────────────┼──────────────────────┤
│  调度层 (Scheduler) —— 本平台自研核心②                           │
│  异步任务队列 · 并发控制 · 重试 · 断点续跑 · 成本熔断            │
├─────────────────────────────────────────────────────────────────┤
│  能力层 (Capability)                                             │
│  代码沙箱(jupyter/cloud-sandbox) · 文件/知识库 · MCP · 模型代理  │
├─────────────────────────────────────────────────────────────────┤
│  存储层 (Storage) —— 所有状态的唯一来源                          │
│  PostgreSQL(元数据/任务) · 对象存储(文件/artifact) · Redis(缓存/队列) │
├─────────────────────────────────────────────────────────────────┤
│  可观测层 (Observability)                                        │
│  Tracing(OTel/Langfuse) · Metrics · Logs · 审计                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **状态外置**：编排层服务必须无状态，所有状态进存储层。这是水平扩展的前提。
2. **两个引擎各司其职**：lobehub 管智能体与协作，langflow 管流水线与批量。不在两边重复实现。
3. **自研收敛到两层**：网关层（统一入口与治理）、调度层（异步与规模化）。其余复用开源。
4. **同步触达 + 异步执行**：短任务同步返回；长任务立即返回 `operationId`，靠轮询/webhook 取结果。
5. **可观测性优先**：每一步都要能追溯到 trace，每个资源消耗都要能计量。

### 3.3 物理拓扑（MVP：单机起步）

```
单台服务器（或 docker-compose）
├─ nginx / 反代
├─ lobehub（Node，含 Next.js + Hono）
├─ langflow（Python FastAPI）
├─ PostgreSQL（共享，两库或同库多 schema）
├─ Redis（队列 + 缓存）
├─ MinIO（对象存储，S3 兼容）
└─ Sandbox Runner（代码执行，可选独立容器）
```

---

## 4. 核心概念模型

### 4.1 智能体（Agent）定义

存储在 lobehub `agents` 表，核心字段：

```ts
{
  id, title, description, tags,
  model,            // 使用的 LLM
  provider,         // 模型来源
  systemRole,       // 系统提示词 —— 定义"这个专家是谁"
  plugins,          // 内置工具/插件列表（function calling）
  skills,           // 高级技能（关联 agent_skills 表）
  chatConfig,       // 对话行为配置
  agencyConfig,     // ★ 异构配置（claude-code/codex/hermes...）
  knowledgeBases,   // 关联知识库（RAG）
  workspaceId,      // 多租户隔离
  visibility        // private | public
}
```

**`agencyConfig` 是接入 Claude Code 等异构 agent 的关键字段**：
```ts
agencyConfig: {
  type: 'claude-code' | 'codex' | 'hermes' | ...,
  command?: 'claude',          // cli 类
  args?: ['--model', '...'],
  platformAgentId?: 'main',    // remote 类
  effort?: 'high',             // 推理强度
}
```

编排器（Supervisor）通过**能力描述符**判断该 agent 是否胜任某项分派，而非看 model/plugins 字段——因为异构 agent 自带工具集，忽略插件配置。

### 4.2 流水线（Pipeline）定义

存储在 langflow，定义为 DAG：
- **节点（Vertex）**：组件实例（Agent / LLM / 工具 / 子流程 / 循环 / 分支）
- **边（Edge）**：数据依赖
- **版本（flow_version）**：每次保存产生快照，锁定后可复现

关键组件（langflow `flow_controls`）：
| 组件 | 作用 | MVP 用途 |
|---|---|---|
| `loop` | 循环执行 | 批量跑 N 个输入 |
| `sub_flow` | 嵌套调用另一 Flow | "单篇处理"作为子流程 |
| `conditional_router` | 条件分支 | 失败重试 / 成功归档 |
| `run_flow` | 编程式触发 Flow | 被 API 调用 |
| `API Request` | 出站 HTTP | 调用 lobehub 的 agent API |
| `webhook` | 入站 HTTP | 接收 lobehub 回调 |

### 4.3 任务（Task）定义

lobehub `tasks` 表，是**执行实例的可追踪单元**：

```ts
{
  id, identifier,        // 如 'T-42'
  title, status,         // pending|running|done|failed
  createdByUserId | createdByAgentId,   // ★ 可由 agent 创建
  assigneeUserId | assigneeAgentId,     // ★ 可同时指派 user + agent
  workspaceId,
  parentId?,             // ★ 支持任务树（子任务）
  ...
}
```

另有 `asyncTasks` 表，专门记录**异步长任务**，带 `inferenceId` / `status` / `duration` / `parentId`，支持子任务树和按状态索引。

**Task 的三种来源**：
1. 用户手动创建（UI）
2. Supervisor agent 通过工具创建并分派给专家 agent
3. Pipeline 运行时通过 API 创建

### 4.4 协作编排（Multi-Agent Orchestration）

lobehub 内置的协作引擎，三件套：

```
GroupOrchestrationRuntime（循环驱动器）
        │ 调用
        ▼
GroupOrchestrationSupervisor（决策状态机）
   决策分支: speak | broadcast | delegate | execute_task
             execute_tasks | finish
        │ 产出 instruction
        ▼
Executors（执行层）
   callAgent | parallelCallAgents | execAsyncTask | humanApprove
```

**决策语义**：
- `speak`：让单个 agent 发言（同步等）
- `broadcast`：让多个 agent 并行发言（多视角）
- `execute_task` / `execute_tasks`：派长任务给 agent（异步）
- `humanApprove`：暂停等人工审批（关键节点兜底）
- `finish`：结束，带 `maxRounds` 防死循环

**⚠️ MVP 关键改造点**：协作循环目前在前端 store 驱动（浏览器内），后端只暴露"跑单个 agent"的接口（trpc `aiAgent.execAgent`）。要在流水线里自动触发协作，需**把编排循环搬到后端**（见 §6.4 / §9.4）。

---

## 5. 数据模型与存储设计

### 5.1 存储分工

| 存储 | 用途 | 谁用 |
|---|---|---|
| **PostgreSQL** | 所有结构化元数据 | lobehub（主）+ langflow（各自 schema/库） |
| **对象存储（MinIO/S3）** | 文件、artifact、模型权重、trace 导出 | 共享 |
| **Redis** | 任务队列、缓存、会话状态、限流计数 | 共享 |

### 5.2 核心表（lobehub 侧，已存在）

```
users ──< workspaces ──< agents
                          │
                          ├──< agent_skills
                          ├──< chat_groups >── chat_groups_agents（多对多）
                          ├──< agent_documents / files
                          └──< tasks >── async_tasks（树状）
sessions ──< topics ──< messages
api_keys          # API 资源治理
ai_infra          # 算力资源注册
agent_evals / rag_evals   # 评测
llm_generation_tracing    # 调用追踪
rbac / roles              # 权限
```

### 5.3 核心表（langflow 侧，已存在）

```
flows ──< flow_versions      # ★ 流水线版本化
users / projects / teams
credentials                  # 凭证（API key 等）
messages / transactions      # 运行日志（monitor）
vertex_builds                # 节点构建记录
```

### 5.4 跨系统实体映射（本平台集成层维护）

两个系统的"用户/资源"必须打通，集成层维护映射表：

```sql
-- 集成层新增（可放 lobehub 库）
platform_user_map (lobehub_user_id, langflow_user_id, sso_subject)
platform_pipeline_binding (pipeline_flow_id, langflow_version_id, trigger_endpoint)
platform_run (run_id, pipeline_id, status, lobehub_operation_ids[], result_uri)
```

### 5.5 状态外置原则

**任何要支持水平扩展的服务，禁止把状态存在内存/进程内**：
- 会话状态 → Redis
- 任务状态 → PostgreSQL `async_tasks` / Redis 队列
- 文件 → 对象存储
- 协作运行态 → `AgentState` 序列化进 PostgreSQL（lobehub 已支持 `operationId` + 持久化）

---

## 6. 关键数据流

### 6.1 单 Agent 对话流（最简单，验证用）

```
用户 → Web UI → lobehub trpc/chat → agent-runtime(LLM+工具)
                                       ↓
                                  tracing 落库 → 返回流式响应
```
**全在 lobehub 内完成，不经过 langflow**。

### 6.2 流水线执行流（批量核心）

```
触发(定时/手动/API)
  → langflow Graph.async_start()
  → 拓扑执行各节点:
       [Loop] 对每个输入:
         [SubFlow: 单项处理]
           → [API Request] POST lobehub/api/...   ← 调 agent
           ← 同步结果 或 operationId
           → [条件分支] 成功/失败处理
  → [聚合输出] 报告
  → tracing 上报 Langfuse
```

### 6.3 资源消耗计量流

```
每次 LLM/工具调用
  → lobehub usage 统计(tokens/cost)  ──┐
  → langflow transactions 落库        ├→ 资源面板聚合展示
  → OTel span 携带 resource.usage     ─┘
```

### 6.4 多 Agent 协作流（需改造，重点）

**当前现状**（协作循环在浏览器）：
```
Web UI(浏览器)
  → GroupOrchestrationRuntime.run()    ← 循环在前端
  → 每轮调 trpc aiAgent.execAgent      ← 后端只跑单 agent
```

**MVP 目标**（协作循环搬到后端）：
```
外部触发(API/Pipeline)
  → POST /api/v1/agent-groups/:id/run  ← ★ 本平台新增路由
  → 后端 GroupOrchestrationRuntime.run():
       Supervisor.decide() → executor
       → aiAgent.execAgent(专家1)
       → aiAgent.execAgent(专家2=claude-code)
       → humanApprove(关键点)
       → 循环到 finish
  → 返回 operationId(异步) 或 结果(同步)
```

> **改造工作量评估**：核心引擎（Runtime + Supervisor + Executors，约 1500 行）已实现且有测试。主要工作是：
> 1. 把 executors 中依赖浏览器 API 的部分（SWR 轮询、DOM）改成后端实现
> 2. 新增 Hono 路由作为入口
> 3. 异步化（长任务返回 operationId）

### 6.5 异步长任务流（复现/训练场景）

```
Pipeline 发起 → lobehub 创建 asyncTask(parentId 可构成树)
  → 立即返回 { operationId, status: 'running' }
  → 后台执行(可能数小时)
  → 完成后:
       选项A: POST 回 langflow webhook
       选项B: langflow 轮询 GET /api/operations/:id
  → 结果存对象存储, URL 回传
```

---

## 7. 资源管理面板设计

### 7.1 两类资源

| 类别 | 实体 | 来源 | 治理动作 |
|---|---|---|---|
| **API 资源** | LLM key、凭证、模型 provider | lobehub `api_keys` + langflow `credentials` | 配额、轮转、失效告警 |
| **算力资源** | GPU、沙箱、远程设备 | lobehub `ai_infra` + 自研调度 | 调度、排队、回收 |

### 7.2 面板功能（MVP）

```
资源面板
├─ API 资源
│  ├─ 各 provider 用量曲线(tokens/$)
│  ├─ key 健康状态(额度/限流/失效)
│  └─ 按 workspace/agent 的用量分摊
├─ 算力资源
│  ├─ GPU/沙箱 占用与队列
│  ├─ 运行中任务数 / 排队数
│  └─ 设备在线状态(异构 agent 的 remote device)
└─ 成本
   ├─ 实时成本(按 model/tool 汇总)
   └─ 预算阈值与熔断告警
```

### 7.3 数据来源

- lobehub 已有：`AgentUsage` feature、`llm_generation_tracing`、`apiKey` 表
- langflow 已有：`monitor` 路由（transactions）、`vertex_builds`
- **本平台集成层新增**：跨系统用量聚合视图（定时从两边拉取，写入聚合表）

### 7.4 ⚠️ MVP 边界

- GPU 调度：MVP **只展示占用，不实现调度**（沙箱能跑代码，但 GPU 训练队列需自研，超出 MVP）
- 凭证轮转：MVP 只支持手动，不实现自动轮转

---

## 8. 用户、监控与可观测性

### 8.1 用户与权限

- **认证**：统一 SSO（lobehub 支持 `betterAuth`/`oidc`），langflow 通过集成层的 token 映射复用同一身份
- **RBAC**：lobehub 有完整 `rbac`/`roles`/`permissions`；langflow 有 `authorization`(roles/teams/audit)。集成层做权限映射
- **多租户**：MVP 用 workspace 软隔离（共享库，按 `workspaceId` 过滤）

### 8.2 监控面板

| 维度 | 数据源 | 展示 |
|---|---|---|
| 任务监控 | `async_tasks` / langflow jobs | 运行/排队/失败数、时长分布 |
| Agent 监控 | tracing | 调用次数、token、成功率 |
| Pipeline 监控 | langflow `monitor` | Flow 运行历史、节点耗时 |
| 资源监控 | §7 | 见资源面板 |

### 8.3 日志与 Tracing

- **统一 Trace 后端**：Langfuse（langflow 原生支持，lobehub `observability-otel` 可对接）
- **每条 trace 携带**：`run_id` / `pipeline_id` / `task_id` / `agent_id` / `user_id`，串起全链路
- **结构化日志**：服务日志走 stdout，由采集器（Loki/ELK）聚合
- **审计日志**：敏感操作（key 操作、权限变更、删除）单独记录，lobehub 已有 audit 机制

### 8.4 可观测性设计原则

1. **trace 全链路贯穿**：从 Pipeline 触发 → Agent 执行 → 工具调用 → 模型调用，用同一 traceId
2. **结构化优先**：所有日志带 `run_id`/`task_id`，可按任务反查
3. **采样与成本**：MVP 全量 trace；规模化后对成功请求采样，失败/慢请求全留

---

## 9. 可扩展性设计（核心章节）

> MVP 是单机，但**架构必须保证：扩到多机时只加机器、加 worker，不改业务代码**。

### 9.1 扩展性目标与瓶颈分析

"百万智能体"的真实瓶颈不在 agent 数量（DB 行数好办），而在：

| 瓶颈 | 原因 | MVP 策略 | 扩展路径 |
|---|---|---|---|
| **并发执行** | 同时跑的 agent/flow | 限制并发数 | 加 worker + 队列 |
| **LLM 调用吞吐** | 上游限流 | 限流 + 排队 | 多 key 池 + 负载均衡 |
| **DB 写入** | 海量 trace/message | 先写后批量归档 | 读写分离 + 分表 |
| **存储容量** | 文件/artifact | 对象存储 | 天然可扩展 |
| **长任务调度** | 训练/复现数小时 | asyncTask + 轮询 | 专用调度器（K8s/Ray） |

### 9.2 水平扩展的三个前提（MVP 必须满足）

1. **服务无状态**：lobehub/langflow 实例可随意重启/复制，状态全在存储层（§5.5）
2. **任务走队列**：执行不绑死在请求线程，进 Redis 队列由 worker 消费
3. **会话可迁移**：协作运行态序列化到 DB，任何实例都能接续

### 9.3 从 MVP 到规模化的演进路径

```
阶段0 (MVP): 单机 docker-compose
  └─ 验证全闭环, 并发数 ~10

阶段1: 应用层水平扩展
  ├─ lobehub / langflow 多实例 + 负载均衡
  ├─ Redis 队列 + N 个 worker
  └─ 并发数 ~100

阶段2: 存储与调度扩展
  ├─ PostgreSQL 读写分离 → 分库(按 workspace 分片)
  ├─ trace 冷热分层(热 PG, 冷 S3/数仓)
  ├─ GPU/长任务专用调度器(K8s 作业 / Ray)
  └─ 并发数 ~1000+

阶段3: 百万级
  ├─ 多租户强隔离(库级隔离 / 独立集群)
  ├─ 异地多活
  └─ 自研调度内核(开源项目到此为止)
```

### 9.4 MVP 中必须"预留"的扩展接口

即使 MVP 单机，下列设计必须落实，否则阶段1 要重写：

| 设计点 | MVP 实现 | 为何重要 |
|---|---|---|
| 任务经队列而非内联 | Redis 队列（即使 1 个 worker） | 加 worker 即扩容 |
| 服务不持有协作状态 | `AgentState` 序列化入 PG | 协作可跨实例接续 |
| LLM key 可池化 | `api_keys` 表支持多 key | 突破单 key 限流 |
| trace/metric 标准化 | OTel + Langfuse | 换后端不改代码 |
| 文件走对象存储 | MinIO（S3 兼容） | 换 S3/OSS 不改代码 |
| API 统一前缀与版本 | `/api/v1/...` | 网关可替换 |

### 9.5 ⚠️ 两个开源项目的扩展性硬伤（必须自研补齐）

1. **协作循环在浏览器**：lobehub 的多 agent 协作当前由前端驱动。要规模化/自动化，**必须搬到后端**（§6.4）。这是本平台必做改造。
2. **无内置 GPU 调度**：两个项目的沙箱都是"代码执行器"，不是"GPU 训练队列"。长时训练需自研调度层（阶段2）。

---

## 10. 应用样例：论文批量复现

> 作为架构的具象落点。完整复现成功率受限于科研难度，平台提供的是"协作 + 执行 + 可追溯 + 人工介入"框架。

### 10.1 场景拆解

对 N 篇 Nature 论文，用多专家协作复现关键结果。每个专家是一个 Agent。

### 10.2 专家角色定义（Agent）

| 专家 Agent | systemRole 要点 | 关键工具 | agent 类型 |
|---|---|---|---|
| 文献解读 | 提取方法/数据集/超参/指标 | 知识库 + 文件解析 | lobehub 原生 |
| 环境配置 | 处理依赖冲突 | cloud-sandbox + claude-code | 异构(claude-code) |
| 代码复现 | 逐模块实现论文方法 | notebook + python-interpreter | lobehub 原生或异构 |
| 实验执行 | 跑训练/推理 | 沙箱 + asyncTask | lobehub + 调度层 |
| 结果验证 | 数值比对、找差异 | verify + self-iteration | lobehub 原生 |
| 协调者 | 分派/汇总/决定返工 | group-management 工具 | lobehub Supervisor |

### 10.3 编排架构

```
批量层 (langflow Pipeline: batch_reproduce)
  [论文清单CSV] → [Loop] → [SubFlow: reproduce_one]
                              ↓ POST
单篇层 (lobehub AgentGroup 协作)
  Supervisor
   ├─ 文献解读 → 复现清单
   ├─ 环境配置 → [humanApprove] → 搭环境
   ├─ 代码复现 → [claude-code 异构]
   ├─ 实验执行 → [asyncTask] 长任务
   ├─ 结果验证 → [verify] 不达标则返工
   └─ 协调者 → 生成报告
```

### 10.4 关键集成点

- langflow `API Request` 组件 → `POST lobehub/api/v1/agent-groups/:id/run`（需 §6.4 改造）
- 长任务：返回 operationId → langflow `webhook` 或轮询取结果
- 全程 trace 串到同一 `run_id`，便于复盘"这篇为什么没复现成功"

### 10.5 务实预期

- 平台提供框架，**不保证复现成功**
- 建议定位为"AI 辅助复现 + 专家在环"，关键节点 `humanApprove` 兜底
- 先跑通 1 篇方法清晰、有开源参考的论文，再扩展到批量

---

## 11. 技术选型与决策记录

### 11.1 核心选型

| 决策 | 选择 | 理由 | 代价 |
|---|---|---|---|
| 对话/Agent 运行时 | lobehub | 多 agent 协作、异构 agent、工具系统成熟 | 协作循环需后端化 |
| 流水线引擎 | langflow | 可视化 DAG、批量、版本化复现 | Python 栈，需集成 |
| 数据库 | PostgreSQL | 两边原生支持，事务/JSON 强 | 单点需分库扩展 |
| 队列/缓存 | Redis | 轻量、通用、两边易接 | 需持久化配置 |
| 对象存储 | MinIO(MVP)→S3 | S3 兼容，无缝迁移 | 自运维 |
| Trace | Langfuse + OTel | 两边原生支持 | 自部署 |

### 11.2 关键权衡

**Q：为什么不统一成一个技术栈？**
A：两个引擎各自在其语言生态里最强（lobehub 的 TS agent runtime、langflow 的 Python LangChain 生态）。强行统一会丧失生态红利。集成成本（HTTP + 统一鉴权）低于重写成本。

**Q：协作循环为什么要后端化？**
A：浏览器驱动的协作无法被 API/流水线自动触发，无法水平扩展，无法持久化长任务。这是从"MVP 能用"到"能规模化"的必经改造。

**Q：为什么不直接上 K8s？**
A：MVP 用 docker-compose 验证闭环，K8s 引入运维复杂度但不改变架构。架构预留无状态 + 队列设计后，阶段1 再上 K8s 是平移而非重写。

---

## 12. 实施路线图

### MVP（目标：单机跑通全闭环）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 基础设施** | docker-compose 起 lobehub + langflow + PG + Redis + MinIO | 两边 UI 可访问，SSO 打通 |
| **M1 单 Agent 验证** | 配置 1 个 agent，跑通对话 + 工具 | lobehub 内闭环可用 |
| **M2 流水线验证** | langflow 建一个简单 Flow，用 `API Request` 调 lobehub agent | 两系统 HTTP 通 |
| **M3 协作后端化** | 把 GroupOrchestrationRuntime 搬后端，新增触发路由 | API 可启动一次协作 |
| **M4 批量执行** | langflow `loop` + `sub_flow` 跑批量 | 批量任务可跑可查 |
| **M5 资源面板** | 跨系统用量聚合展示 | 面板可看用量/成本 |
| **M6 监控日志** | Langfuse 接入，全链路 trace | 任一任务可全链路追溯 |

### MVP 之后（不在本文档展开）

- 应用水平扩展（阶段1）
- 存储与调度扩展（阶段2）
- 多租户强隔离与百万级（阶段3）

---

## 附录 A：lobehub 关键能力清单（已验证）

| 能力 | 实现位置 | 状态 |
|---|---|---|
| Agent 定义 | `packages/database/src/schemas/agent.ts` | ✅ |
| 多 agent 协作状态机 | `agent-runtime/groupOrchestration/` | ✅ 有测试 |
| 声明式图编排 | `agent-runtime/agents/GraphAgent.ts` (363行) + `ReasoningGraph` | ✅ |
| 异构 agent（Claude Code） | `heterogeneous-agents/adapters/claudeCode.ts` | ✅ 开箱 |
| 代码沙箱 | `builtin-tool-cloud-sandbox` / `notebook` / `python-interpreter` | ✅ |
| 异构 agent（Hermes 等） | 类型已预留，adapter 待写 | 🟡 |
| 用户/RBAC | `betterAuth` / `rbac.ts` / `roles` | ✅ |
| 资源治理 | `apiKey.ts` / `aiInfra.ts` / `AgentUsage` | ✅ |
| Tracing | `observability-otel` / `agent-tracing` | ✅ |
| 异步任务 | `asyncTask.ts` (带 parentId 树) | ✅ |
| 协作触发 API | **❌ 缺，需新增** | 🔴 |

## 附录 B：langflow 关键能力清单（已验证）

| 能力 | 实现位置 | 状态 |
|---|---|---|
| DAG 引擎 | `lfx/graph/graph/base.py` (2601行) | ✅ |
| 批量/循环/子流程 | `components/flow_controls/` (loop/sub_flow/router) | ✅ |
| 流水线版本化 | `api/v1/flow_version.py` (310行) | ✅ |
| HTTP 出站 | `components/data_source/api_request.py` | ✅ |
| Webhook 入站 | `components/input_output/webhook.py` | ✅ |
| Tracing | `services/tracing/` (langfuse/langsmith/otel) | ✅ |
| 用户/RBAC | `services/auth` / `authorization` | ✅ |
| Agent 组件 | `components/models_and_agents/agent.py` (基于 LangChain) | ✅ |
| 监控 | `api/v1/monitor.py` | ✅ |

## 附录 C：本平台自研清单

| 自研项 | 层 | 优先级 | 说明 |
|---|---|---|---|
| 统一网关 + SSO | 网关层 | 高 | 单入口、统一鉴权 |
| 协作触发 API | 编排层 | 高 | §6.4 改造 |
| 跨系统资源聚合 | 网关层 | 中 | 资源面板数据源 |
| 调度层（队列+并发控制+熔断） | 调度层 | 高 | 规模化关键 |
| GPU 训练调度 | 调度层 | 低(MVP外) | 阶段2 |
| Hermes 等 adapter | 编排层 | 低 | 按需 |

## 附录 D：风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协作循环后端化工作量大 | 阻塞 M3 | 先做最小路径：单 agent API 跑通，协作后置 |
| 双技术栈集成复杂 | 运维成本 | 统一 docker-compose，集成层最小化 |
| 论文复现成功率低 | 场景验证失败 | 定位为"辅助复现"，选易复现论文起步 |
| LLM 成本失控 | 批量跑爆账 | 预算熔断 + 单篇上限 + 并发闸 |
| langflow/lobehub 版本升级破坏集成 | 维护成本 | 锁版本 + 集成测试 |

---

> **下一步建议**：本文档评审通过后，从 M0/M1 起步。M3（协作后端化）是最大技术风险点，建议尽早做技术验证（spike）而非拖到最后。
