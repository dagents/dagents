# Dagents 平台 —— 架构设计文档（v0.2，基于 Flowise 重构）

> **版本**：v0.2
> **日期**：2026-07-07
> **相对 v0.1 的定位**：推翻「lobehub + langflow 双引擎」组合，改为 **Flowise 单引擎 + 4 个薄自研层**。v0.1 文档（`architecture.md`）保留供对照评审。
> **状态**：草案，供团队评审

---

## 0. TL;DR

- 平台 = **单一可视化编排引擎（Flowise）** + **4 个薄自研层**（Agent Daemon / 调度批量 / 版本可复现 / 网关观测）+ **轻量自研 Chat 前端**。
- 推翻 v0.1 的「lobehub + langflow 双引擎 + 集成层 + 实体映射表」：实际使用 langflow 与 lobehub 后发现**两者各自太重、各自方向偏强**——langflow 重在 Python LangChain 组件生态，lobehub 重在对话运营前端，而本平台的核心诉求是**编排 agent**，并不需要这么强的两套子系统。
- Flowise 一个引擎同时覆盖：对话 runtime、可视化 DAG、批量循环、多 agent 协作、HITL（人在回路）。其 **Agentflow V2 是天生后端化的状态机引擎**（Node 服务端执行 + Flow State + 检查点持久化），直接消解了 v0.1 §9.5.1 点名的最大硬伤——「协作循环在浏览器、必须搬后端」。
- 自研收敛到能力边缘的 4 个薄层，定位是**补 Flowise 缺口**而非重造：
  1. **网关观测层**：统一鉴权、路由、限流、审计、Trace 注入
  2. **Agent Daemon 层**（参照 multica，**两段式架构**）：中央 dispatch server（任务队列，衔接 Flowise）+ 本地 daemon（常驻、主动 claim 任务、spawn CLI）。异构 agent（Claude Code / Codex / 远程 runtime）在此被统一封装。
  3. **调度批量层**：并发闸、批量 fan-out（补 Flowise Iteration 串行短板）、成本熔断、长任务
  4. **版本可复现层**：flow JSON 快照、哈希锁定、run 绑定版本、artifact 归档
- **异构 agent 如何参与 flow**：作为 flow 画布里的一个**被调节点**——Flowise 的 HTTP 节点 → 中央 dispatch → 某个本地 daemon → spawn coding agent。Flowise 全程掌控编排，agent 只负责「接到 prompt、干完活、回结果」（MVP 语义；agent 反向驱动 flow 留作演进）。
- 扩展性策略与 v0.1 一致：**无状态服务层 + 共享存储 + 异步任务队列**。MVP 单实例起步，但所有有状态逻辑隔离到存储层，未来横向扩展只需「加机器 + 加 daemon/worker」，不改业务代码。

---

## 1. 背景与问题定义

### 1.1 要解决什么问题

构建一个支撑大量智能体（agent）与流水线（pipeline）的平台，覆盖五类能力（**与 v0.1 完全一致，本平台要解决的问题没有变**）：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 解题智能体流水线 | 把一个复杂目标拆解为多步骤、多 agent 协作的执行流 |
| 2 | 批量任务执行与复现 | 对一批输入（如多篇论文、多份数据）跑同一流水线，结果可追溯、可复现 |
| 3 | 资源管理面板 | 统一管理算力（GPU/CPU/沙箱）与 API 资源（LLM key、凭证） |
| 4 | 智能体 / 流水线 / 任务的"定义" | 三类核心实体可声明式定义、版本化、复用 |
| 5 | 用户、监控、日志 | 多租户、RBAC、运行可观测性 |

### 1.2 为什么从 v0.1 的双引擎退回单引擎

v0.1 的结论是「lobehub（TS）+ langflow（Python）互补性最强」。**实际使用后发现两者都太重**，且各自在自己的方向上强得过头，超出本平台诉求：

| 选项 | 实际体验 | 结论 |
|---|---|---|
| 全自研 | 需重写 workflow 引擎、agent runtime、可视化编辑器、对话 UI，数月起步 | ✗ |
| 仅 langflow | Python 栈，组件生态围绕 LangChain 重；多 agent 协作带状态/审批/返工仍偏弱；对话运营 UI 偏编辑器而非运营 | ✗ 太重 |
| 仅 lobehub | 重在对话运营前端（Next.js 全栈），无可视化 DAG 流水线，批量编排弱；其多 agent 协作循环当前在前端驱动（v0.1 §9.5.1 硬伤） | ✗ 太重 |
| lobehub + langflow | v0.1 方案。两套技术栈（TS + Python）、需写集成层与实体映射表、运维两套服务 | ✗ 集成成本高 |
| **Flowise 单引擎** | Node/TS 单栈；Agentflow V2 一套引擎覆盖可视化 DAG + 多 agent 协作 + 批量循环 + HITL，且**协作天生后端化** | **✓ 最贴合"编排 agent"的诉求** |

> **核心判断**：本平台要做的是「**编排 agent 的平台**」——agent 可以是 Claude Code 这样的异构 CLI agent，也可以是只有简单提示词的 agent。这不是「做最强的对话运营平台」也不是「做最强的 Python 组件市场」。Flowise 恰好够用、且最轻。

### 1.3 不做什么（MVP 边界）

继承 v0.1 的边界，并新增两条：

- ❌ 不做"百万 agent"的分布式调度（留接口，见 §9）
- ❌ 不做 GPU 训练队列（沙箱可执行代码，但 GPU 调度需自研，超出 MVP）
- ❌ 不做全自动科研复现（复现成功率受限于 LLM 能力与论文本身，平台只提供框架）
- ❌ 不做多租户强隔离（MVP 用 workspace 软隔离）
- ❌ **不做 lobehub 式重型对话运营平台**（不做会话分析、消息搜索、插件市场、市场分发等）——只做够用的轻量 Chat 前端
- ❌ **不做 langflow 式 Python 组件市场**——不自建组件生态，复用 Flowise 已有节点 + 自研少量桥接节点

---

## 2. 术语对齐

### 2.1 删掉的认知陷阱

v0.1 §2.1 花大篇幅区分「lobehub 的 workflow（定时任务）」与「langflow 的 Flow（DAG 流水线）」——这是双引擎带来的术语歧义。**单引擎后此陷阱消失**：本平台所有「流水线 / Pipeline / Flow」统一指 Flowise Agentflow V2 的 DAG。

定时任务/调度统一由自研调度层承担（基于 Redis 队列 + cron），不再混淆。

### 2.2 三类核心实体（定义位置迁移）

```
智能体 (Agent)     流水线 (Pipeline)     任务 (Task/Run)
   │                   │                   │
   ▼                   ▼                   ▼
"一个会做事的角色"   "一条可复现的执行路径"  "一次具体的执行实例"
```

| 实体 | v0.1 定义在哪 | **v0.2 定义在哪** | 类比 |
|---|---|---|---|
| **Agent** | lobehub `agents` 表 | Flowise `Agent` 节点配置（提示词 agent）**或** Agent Daemon 注册（异构 agent） | "函数/对象" |
| **Pipeline** | langflow Flow（版本化） | **Flowise Agentflow V2**（DAG，服务端执行） | "脚本/配方" |
| **Task** | lobehub `tasks` 表 | **本平台自研 `runs` 表**（Flowise 无原生任务实例表，必须自建，见 §4.3 / §5.3） | "一次调用" |

关系不变：**Pipeline 编排 Agent；Run 记录 Pipeline/Agent 的执行实例**。

### 2.3 异构智能体（Heterogeneous Agent）—— 经 Agent Daemon 接入

指**外部 CLI / 远程 runtime**，自带工具集与模型，不占 Flowise 的节点位。v0.2 统一定义为：**经 Agent Daemon 适配、接入中央 dispatch server**的 agent。

> **术语演变**：v0.2 草案曾用「Agent Bridge（被动 HTTP 服务）」。调研 multica 后升级为 **「Agent Daemon（主动拉取式）」**——因为真实 coding agent 执行时间长（分钟~小时）、常需访问特定机器（repo/GPU/内网）、需要并发治理与排队。被动 HTTP 服务无法承载这些特性，必须用本地常驻 daemon + 中央 dispatch server 的两段式架构（参照 multica `pkg/agent` + `internal/daemon`）。

**两段式架构**：

```
Flowise HTTP 节点 ──POST──▶ 中央 dispatch server ──派发──▶ 本地 Agent Daemon
       ▲                         │                              │ (spawn CLI)
       │                         │                              ▼
       └──── 结果/事件流 ◀──── WebSocket 心跳 ◀──── claim → execute → complete
```

- **中央 dispatch server**（自研，TS）：维护任务队列，衔接 Flowise HTTP 节点，把请求转化为「任务」派给已注册的 daemon，收集事件流回传。
- **本地 Agent Daemon**（自研，TS，参照 multica daemon）：常驻在 agent 能访问的机器上；主动 `POST /tasks/claim` 领任务 → spawn CLI → 流式回传 messages/progress → complete/fail + usage。

| 类型 | daemon adapter | MVP 可用性 |
|---|---|---|
| `claude-code` | 自研 daemon adapter → spawn `claude` CLI（stream-json） | ✅ 首批实现（M2） |
| `codex` | 自研 daemon adapter → spawn `codex` CLI | 🟡 第二批 |
| 远程 runtime（自部署 agent 服务） | daemon adapter → 转发远程 HTTP | 🟡 按需 |
| MCP server 形态 agent | daemon 内嵌 MCP client 调用 | 🟡 备选路径（见 §11.2） |

> **统一接口契约**参照 multica `pkg/agent/agent.go` 的 `Backend` interface：`execute(prompt, opts) → AsyncIterable<AgentEvent> + Result`（TS 翻译版见 §4.1）。每个 agent 一个 adapter 文件（`claude.ts`/`codex.ts`...），收敛所有 CLI 调用差异。
>
> **设计参考来源与 license**：multica 采用 modified Apache 2.0（禁止直接拿其源码做 SaaS/嵌入商业产品，但**组织内部使用与参照设计自研实现均允许**）。本平台**参照其接口形状与 adapter 知识，用 TS 自研实现**，不引入 multica 源码依赖。详见附录 D'。

---

## 3. 架构总览

### 3.1 分层视图

```
┌─────────────────────────────────────────────────────────────────┐
│  接入层 (Access)                                                 │
│  轻量自研 Chat 前端(Next.js 精简) · Flowise 画布(原生)          │
│  · OpenAPI · Webhook                                            │
├─────────────────────────────────────────────────────────────────┤
│  网关观测层 (Gateway) —— 本平台自研①                            │
│  统一鉴权(SSO) · 请求路由 · 限流 · API Key 治理 · 审计          │
│  · Trace 注入(生成 run_id 透传全链路)                           │
├─────────────────────────────────────────────────────────────────┤
│  编排层 (Orchestration) —— Flowise 单引擎                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Agentflow V2 (Node/TypeScript，服务端状态机引擎)         │  │
│  │  · Agent 节点(提示词 agent) · HTTP 节点→中央 dispatch      │  │
│  │  · Iteration(for-each)·Loop(重试/循环)·Condition(分支)   │  │
│  │  · Execute Flow(子流程) · Human Input(HITL，检查点持久化)│  │
│  │  · Custom Function(服务端 JS)·MCP 工具节点               │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  能力适配层 (Capability Adapter) —— 本平台自研②（两段式）       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  中央 dispatch server (TS)：任务队列 + daemon 注册表      │  │
│  │  · 衔接 Flowise HTTP 节点 → 转化为「任务」派给 daemon     │  │
│  │  · 收集 daemon 事件流，回传 Flowise (SSE/轮询)            │  │
│  │  · daemon 路由(按 capability/标签)、并发闸、超时熔断     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                            ↕ WebSocket 心跳 + HTTP claim          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  本地 Agent Daemon × N (TS，参照 multica daemon)          │  │
│  │  · 常驻 agent 能访问的机器 · 主动 POST /tasks/claim       │  │
│  │  · spawn CLI(claude/codex...)·stream-json 解析            │  │
│  │  · 统一 Backend interface · MCP 注入 · session resume     │  │
│  │  · timeout/retry/审计/usage 上报                         │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  调度层 (Scheduler) —— 本平台自研③                              │
│  异步任务队列 · 并发闸 · 批量 fan-out(补 Iteration 串行)        │
│  · 成本熔断 · 断点续跑 · 长任务(operationId 轮询/webhook)      │
├─────────────────────────────────────────────────────────────────┤
│  版本可复现层 (Reproducibility) —— 本平台自研④                  │
│  flow JSON 快照 · 哈希锁定 · run 绑定版本 · artifact 归档       │
├─────────────────────────────────────────────────────────────────┤
│  存储层 (Storage) —— 所有状态的唯一来源                         │
│  PostgreSQL(元数据/runs/版本) · Redis(队列·缓存·Flow State 外置)│
│  · MinIO/S3(文件/artifact/快照)                                │
├─────────────────────────────────────────────────────────────────┤
│  可观测层 (Observability)                                       │
│  Langfuse(trace/cost) + OTel · 结构化日志 · 审计                │
└─────────────────────────────────────────────────────────────────┘
```

> **为什么两段式**：真实 coding agent 执行时间长（分钟~小时）、常需访问特定机器（repo/GPU/内网）、需并发治理与排队。被动 HTTP bridge 无法承载这些特性。中央 dispatch + 本地 daemon 的架构（参照 multica）让 daemon 可部署在任意机器、可多副本、主动拉取任务——这是水平扩展的真正弹性来源（§9）。

### 3.2 设计原则

1. **单引擎、自研收敛到能力边缘**：编排能力全交给 Flowise，自研只补缺口（异构接入、批量并发、版本复现、网关治理），不重造 DAG 引擎、不重造对话 runtime。
2. **状态外置**：编排层与自研层服务必须无状态。Flowise 的 Flow State 默认仅运行期存在（不跨 session），**本平台将其外置到 Redis**，解「跨 session 持久化」短板，同时为水平扩展铺路。这是水平扩展的前提。
3. **同步触达 + 异步执行**：短任务同步返回；长任务立即返回 `operationId`，靠轮询/webhook 取结果（沿用 v0.1 模式）。
4. **可观测性优先**：网关层为每个请求生成 `run_id` 并透传到 Flowise run → daemon call → LLM call，全程 trace 串到同一 `run_id`，每个资源消耗都能计量。
5. **薄层可回贡**：自研层全用 TypeScript/Node，与 Flowise 同栈；成熟的桥接节点（如并发批量执行）未来可包装成 Flowise 自定义节点回贡社区。

### 3.3 物理拓扑（MVP：单机起步，daemon 可远程）

```
单台服务器（或 docker-compose）
├─ nginx / 反代（统一入口 = 网关层）
├─ 网关观测层（Node/Hono，自研①）
├─ Flowise（Node/TS，单引擎）
├─ 中央 dispatch server（Node，自研②，任务队列 + daemon 注册）
├─ 调度 worker（Node，自研③，消费 Redis 队列）
├─ PostgreSQL（共享）
├─ Redis（队列 + 缓存 + Flow State 外置）
├─ MinIO（对象存储，S3 兼容）
└─ Langfuse（trace，可选独立容器）

本地 Agent Daemon × N（自研②，部署在 agent 能访问的机器上）
├─ daemon-本地（同机容器，MVP 起步用）
├─ daemon-开发机（可访问私有 repo 的开发机）
└─ daemon-GPU机（带 GPU 的训练机，阶段2）
```

> daemon 在 MVP 可与中央服务同机部署（容器），但架构上**它是可远程的独立进程**——当 agent 需要访问特定机器（某 repo、GPU、内网）时，把 daemon 部署到那台机器即可，中央不动。这是 multica daemon/server 分离架构的核心优势。
>
> 对比 v0.1：**少起 lobehub（Node 全栈）、langflow（Python FastAPI）两个重型服务**；多起一个中央 dispatch server（轻量）+ 若干 daemon（每个 spawn CLI 的薄包装）。总体运维面更小、技术栈全 TS 统一。

---

## 4. 核心概念模型

### 4.1 智能体（Agent）定义

本平台有两类 agent，统一通过**能力描述符（capability descriptor）**让编排器判断胜任度：

#### (a) 提示词 Agent —— Flowise 原生

直接用 Flowise 的 `Agent` 节点定义，核心字段映射到节点配置：

```ts
{
  // Flowise Agent 节点配置
  model,            // 使用的 LLM（Flowise 内置 model 节点）
  systemPrompt,     // 系统提示词 —— 定义"这个专家是谁"
  tools,            // 工具列表（Flowise Tool 节点 / MCP 节点 / Custom Tool）
  memory,           // 对话记忆（BufferWindow / Redis-backed）
  // 本平台元数据（存在 agent_daemons 或 agents_meta 表）
  capabilityDescriptor: {
    name, summary,          // 能力摘要，供编排器分派
    inputSchema,            // 接受什么输入
    outputSchema,           // 产出什么
    tags: ['analysis'|'coding'|'verify'|...]
  }
}
```

#### (b) 异构 Agent —— 经 Agent Daemon 接入（参照 multica）

异构 agent 的「定义」分两层：**daemon adapter**（怎么 spawn 这个 CLI）+ **dispatch 注册**（中央怎么找到它）。

**统一执行契约**（TS 翻译自 multica `server/pkg/agent/agent.go` 的 `Backend` interface）：

```ts
// daemon 内每个 agent adapter 实现此接口（参照 multica Backend）
interface AgentBackend {
  execute(prompt: string, opts: ExecOptions): AgentSession
}

interface ExecOptions {
  cwd?: string
  model?: string
  systemPrompt?: string        // 仅支持 system 指令的 backend 消费
  maxTurns?: number
  timeoutMs?: number           // ★ 总超时（daemon 强制）
  inactivityTimeoutMs?: number // ★ 静默超时（参照 multica 双层 watchdog）
  resumeSessionId?: string     // ★ 续接上次会话（session resume）
  extraArgs?: string[]         // CLI 透传参数
  mcpConfig?: object           // ★ MCP server 注入（--mcp-config）
  thinkingLevel?: 'low'|'medium'|'high'  // 推理强度
}

// 双通道：事件流 + 最终结果（参照 multica Session.Messages / Session.Result）
interface AgentSession {
  events: AsyncIterable<AgentEvent>  // 流式（text/thinking/tool-use/tool-result/...）
  result: Promise<AgentResult>       // 最终（status/output/usage/sessionId）
}

type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-use'; tool: string; callId: string; input: object }
  | { type: 'tool-result'; tool: string; callId: string; output: string }
  | { type: 'status'; status: string; sessionId?: string }
  | { type: 'error'; content: string }

interface AgentResult {
  status: 'completed'|'failed'|'aborted'|'timeout'|'cancelled'
  output: string
  error?: string
  durationMs: number
  sessionId?: string           // 供下次 resume
  usage: Record<string, TokenUsage>  // 按 model 聚合
}
interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number }
```

每个 agent 一个 adapter 文件（`claude.ts`/`codex.ts`/...），收敛所有 CLI 调用差异（argv 构造、stream-json 解析、Windows 坑、stderr tail 诊断）。**adapter 知识直接参照 multica `pkg/agent/claude.go`/`codex.go`**——那里凝结了大量「这个 CLI 怎么 spawn、参数怎么传、有哪些坑」的实战经验。

**中央 dispatch 注册**（存 `agent_daemons` 表，见 §5.3）：

```ts
{
  id, name, kind,            // 'claude-code' | 'codex' | 'remote'
  daemonId,                  // ★ 哪个本地 daemon 实例提供此 agent
  daemonEndpoint,            // daemon 的 WebSocket/HTTP 地址（中央 → daemon）
  capabilityDescriptor,      // 与(a)同构，编排器据此分派
  // timeoutMs / maxRetries / concurrencyLimit 由 daemon 自治，中央只做路由
}
```

> **关键**：编排器（Flowise 中的 Condition Agent 或自研分派逻辑）通过 `capabilityDescriptor` 判断该 agent 是否胜任某项分派，**而非看 model/tools 字段**——因为异构 agent 自带工具集，不暴露内部插件配置。
>
> **agent 如何参与 flow**：作为画布里的**被调节点**。Flowise HTTP 节点 → `POST 中央dispatch/invoke {agent, prompt}` → 中央派给某 daemon → daemon `execute()` → 事件流回传中央 → 中央回传 Flowise。Flowise 全程掌控编排，agent 只负责「接到 prompt、干完活、回结果」（MVP 语义；agent 反向驱动 flow 留作演进，见 §11.2）。

### 4.2 流水线（Pipeline）定义

存储在 Flowise，定义为 Agentflow V2 的 DAG：
- **节点（Node）**：组件实例（Agent / LLM / 工具 / 子流程 / 循环 / 分支 / HITL）
- **边（Edge）**：数据依赖与执行顺序
- **Flow State**：节点间共享状态（`$flow.state.xxx`），运行期存在；本平台外置到 Redis

#### Agentflow V2 节点清单（14 类）与 v0.1 langflow 组件映射

| Flowise 节点 | 作用 | 对应 v0.1 langflow 组件 | MVP 用途 |
|---|---|---|---|
| `Start` | 流水线入口，定义输入 | — | 接收触发 payload |
| `LLM` | 单次模型调用 | LLMChain | 轻量推理 |
| `Agent` | 提示词 agent（带工具/记忆） | Agent 组件 | 单专家执行 |
| `Tool` | 执行工具（含 MCP） | Tool 组件 | 工具调用 |
| `Retriever` | RAG 检索 | Retriever 组件 | 知识库查询 |
| `HTTP` | 出站 HTTP 请求 | `API Request` | **★ 调中央 dispatch（异构 agent，见 §6.7）** |
| `Condition` | 条件分支（基于状态） | `conditional_router` | 成功/失败分流 |
| `Condition Agent` | LLM 判断分支 | — | 语义路由（谁来接） |
| `Iteration` | for-each 遍历数组 | `loop` | 批量跑 N 个输入 |
| `Loop` | 循环回到上游节点 | `loop`(retry 语义) | 失败重试 / 迭代精炼 |
| `Human Input` | HITL，检查点暂停 | — | 关键节点人工审批 |
| `Direct Reply` | 直接返回 | — | 早出 |
| `Custom Function` | 服务端 JS | 自定义组件 | 轻量数据加工 |
| `Execute Flow` | 调用另一 Agentflow | `sub_flow` | "单篇处理"作为子流程 |

> ⚠️ **Iteration 串行限制**：Flowise Iteration 节点目前**串行**处理数组（[Issue #6571](https://github.com/FlowiseAI/Flowise/issues/6571)）。本平台在调度层用「并发 fan-out 多次 Prediction API」补齐此短板（见 §6.5）。

### 4.3 任务（Run）定义

**Flowise 无原生的「任务/执行实例」表**——它只有 flow 定义和 chat history。本平台必须自建 `runs` 表，作为执行实例的可追踪单元（这是自研层④的承载点）：

```ts
{
  id,                       // = run_id，全链路 trace 主键
  identifier,               // 如 'R-42'
  pipelineId,               // 哪条 pipeline
  pipelineVersionHash,      // ★ 绑定的版本快照哈希（§4.4 / §5.3）
  status,                   // pending|running|paused(human)|done|failed|cancelled
  createdByUserId | createdByRunId,   // 可由用户或父 run 创建
  parentRunId?,             // ★ 支持任务树（批量 fan-out 的子任务）
  input,                    // 输入 payload（JSON）
  output?,                  // 产出（或 artifact URI）
  agentDaemonCalls[],       // ★ 调了哪些异构 agent、各自耗时/成本
  cost,                     // 聚合成本
  traceId,                  // Langfuse trace id
  workspaceId,
  startedAt, finishedAt, durationMs
}
```

**Run 的三种来源**（沿用 v0.1 语义）：
1. 用户手动创建（Chat 前端 / API）
2. 编排器（Condition Agent）在流水线内分派给专家 agent 时创建子 run
3. 外部系统通过 OpenAPI/Webhook 触发

### 4.4 版本与可复现（本平台自建，补 Flowise 缺口）

Flowise 的 flow 可导出为 JSON，但**无 langflow 式的 `flow_version` 锁定**——即同一 flow 编辑后无法锁定历史版本复现。本平台自建版本层：

```
flow 编辑保存
  → 导出 flow JSON
  → 计算内容哈希 SHA-256
  → 存 pipeline_versions 表（hash 唯一，重复不存）
  → 该 hash 绑定到所有用它发起的 run
  → run 完成后，artifact（输入/输出/trace 导出）归档到对象存储
  → 复现 = 用同一 hash 的快照重新发起 run
```

复现语义：**同一 `pipelineVersionHash` + 同一 `input` → 应得到可比对的结果**（LLM 非确定性，复现指「可重跑 + 可追溯 + 可比对」，而非字节级一致）。

---

## 5. 数据模型与存储设计

### 5.1 存储分工

| 存储 | 用途 | 备注 |
|---|---|---|
| **PostgreSQL** | 所有结构化元数据、runs、版本快照索引、用户/RBAC | Flowise 可配 PG；本平台自研表同库 |
| **Redis** | 任务队列、缓存、限流计数、**Flow State 外置** | 解 Flowise「Flow State 不跨 session」短板 |
| **对象存储（MinIO/S3）** | 文件、artifact、模型权重、trace 导出、flow JSON 快照 | S3 兼容，无缝迁移 |

### 5.2 Flowise 原生表（Flowise 管理，本平台只读/透传）

```
chatflows / agentflows        # flow 定义（JSON）
chat_messages                 # 对话历史
tools / credentials           # 工具与凭证（Flowise 内置）
users / organizations          # Flowise 自带认证（本平台用网关 SSO 覆盖）
```

> Flowise 支持 SQLite/PostgreSQL/MySQL。**生产用 PostgreSQL**，与自研表同库不同 schema，便于事务与备份统一。

### 5.3 本平台自研表（核心）

```sql
-- 本地 daemon 实例注册（中央 dispatch 维护，参照 multica runtime 注册）
daemons (
  id, label,                      -- daemon 实例标识，如 'dev-laptop' / 'gpu-box-1'
  endpoint,                       -- daemon 的 WebSocket/HTTP 地址
  status,                         -- online|offline|draining
  last_heartbeat_at,
  capabilities JSONB,             -- 该 daemon 提供哪些 agent kind + 标签(repo 访问/gpu)
  workspace_id,
  created_at
)

-- 异构 agent 注册（哪个 daemon 提供哪个 agent）
agent_daemons (
  id, name, kind,                 -- 'claude-code' | 'codex' | 'remote'
  daemon_id,                      -- ★ 关联 daemons.id
  capability_descriptor JSONB,    -- 能力描述符（编排器据此分派）
  executable_path,                -- CLI 路径，如 'claude'
  default_args JSONB,             -- 默认 CLI 参数
  workspace_id, visibility,
  created_at, updated_at
)

-- 中央 dispatch 任务队列（daemon 主动 claim，参照 multica task 模型）
dispatch_tasks (
  id, agent_daemon_id, run_id,    -- 关联 agent 与 run
  prompt TEXT, exec_options JSONB,
  status,                         -- queued|claimed|running|completed|failed
  claimed_by_daemon_id,
  result JSONB,                   -- AgentResult 序列化
  created_at, claimed_at, finished_at
)
-- 索引: (status, agent_daemon_id), (run_id)

-- 流水线版本快照（补 Flowise 无版本锁定的短板）
pipeline_versions (
  id, pipeline_id,                -- pipeline_id 对应 Flowise flow id
  version_hash CHAR(64) UNIQUE,   -- SHA-256 of flow JSON
  flow_json JSONB,                -- 完整快照
  created_by_user_id,
  created_at,
  note                            -- 版本说明
)

-- 执行实例（Flowise 无此表，必须自建）
runs (
  id, identifier, pipeline_id, pipeline_version_hash,
  status, created_by_user_id, created_by_run_id, parent_run_id,
  input JSONB, output JSONB, artifact_uri,
  agent_daemon_calls JSONB,       -- [{agent_daemon_id, dispatch_task_id, duration_ms, cost, status}]
  cost NUMERIC, trace_id,
  workspace_id,
  started_at, finished_at, duration_ms
)
-- 索引: (workspace_id, status), (parent_run_id), (pipeline_version_hash)

-- 用户与 RBAC（可复用 Flowise 或自建，MVP 自建轻量版）
users (id, sso_subject, email, ...)
workspaces (id, name, owner_user_id)
rbac_roles / rbac_permissions   -- 最小权限模型
```

### 5.4 删掉的设计：跨系统实体映射表

v0.1 §5.4 维护了 `platform_user_map` / `platform_pipeline_binding` / `platform_run` 三张映射表，用于打通 lobehub 与 langflow 的用户/资源。**单引擎后此层彻底消失**——这是 v0.2 相对 v0.1 的显著简化点。

### 5.5 状态外置原则（沿用 v0.1 §5.5，强化 Flowise 部分）

**任何要支持水平扩展的服务，禁止把状态存在内存/进程内**：
- 会话状态 → Redis
- 任务状态 → PostgreSQL `runs` 表 / Redis 队列
- 文件 → 对象存储
- **Flow State → Redis（本平台改造点）**：Flowise 默认把 Flow State 存进程内存，重启即失。本平台通过 Redis backend 将其外置，使任何 Flowise 实例都能接续某次运行的状态——这是协作/长任务可跨实例恢复的前提。
- Run 运行态 → `runs` 表序列化（status / agent_daemon_calls / checkpoint）

---

## 6. 关键数据流

### 6.1 单 Agent 对话流（最简单，验证用）

```
用户 → 轻量 Chat 前端 → 网关(鉴权+注入run_id)
  → Flowise Prediction API(chatflow/agentflow)
  → Agent 节点(LLM + 工具)
  → 结果 SSE 流式回前端
  → tracing 落 Langfuse（带 run_id）
```

全在 Flowise 内完成。若该 agent 是异构的，则走 §6.2 的 HTTP 节点 → 中央 dispatch → Agent Daemon 路径。

### 6.2 流水线执行流（批量核心）

```
触发(定时/手动/API) → 网关(生成 run_id)
  → 调度层: 创建 run(status=running)，绑定 pipeline_version_hash
  → Flowise Agentflow V2 服务端执行:
       [Iteration] 对每个输入:        ← ⚠️ 串行，并行见 §6.5
         [Execute Flow: 单项处理]
           → [Agent 节点] 提示词专家
           → [HTTP 节点] POST 中央 dispatch(异构 agent)  ← 见 §6.7
           ← 同步结果 或 operationId
           → [Condition] 成功/失败处理
           → [Human Input] 关键点审批(检查点暂停)
  → [聚合输出] 报告
  → tracing 上报 Langfuse
  → run.status=done，artifact 归档对象存储
```

> **对比 v0.1 §6.2**：不再需要「langflow `API Request` 组件 POST 到 lobehub」的跨系统调用——单引擎内，提示词 agent 用 Agent 节点，异构 agent 用 HTTP 节点 → 中央 dispatch → Agent Daemon，全部在一个画布里触发。

### 6.3 资源消耗计量流

```
每次 LLM/工具/daemon 调用
  → Flowise run 携带 usage(tokens/cost)        ──┐
  → Agent Daemon 上报调用计量(duration/cost)     ├→ runs.agent_daemon_calls 落库
  → OTel span 携带 resource.usage               │  → 资源面板聚合
  → Langfuse 自动捕获 cost/metrics              ─┘
```

### 6.4 ⚠️ 删掉的设计：协作后端化改造

**v0.1 §6.4 花了整章描述「把 lobehub 浏览器内的协作循环搬到后端」**，并标注为「最大技术风险点」。

**v0.2 中此问题不存在**：Flowise Agentflow V2 是**天生后端化的状态机引擎**——节点依赖解析、执行队列调度、Flow State 共享、HITL 检查点持久化全部在 Node 服务端完成，浏览器只负责展示与人工审批的交互。

这是 v0.2 相对 v0.1 的**最大减负**：省掉了「重写协作引擎、把 SWR 轮询/DOM 依赖改后端、新增触发路由、异步化」的约 1500 行改造工作量（v0.1 §6.4 评估）。

### 6.5 批量并行执行流（补 Flowise 短板）

Flowise Iteration 节点串行处理数组（[#6571](https://github.com/FlowiseAI/Flowise/issues/6571)）。对于「批量跑 N 篇论文」这类吞吐敏感场景，本平台在调度层补齐：

```
批量触发(论文清单 N 篇)
  → 调度层: 创建 parent_run
  → 并发 fan-out: 按并发闸(如 max=10)并发调 Flowise Prediction API
       每次 POST /api/v1/prediction/{flowId}
            body: { 单篇输入, overrideConfig: {sessionId: 子run_id} }
       → 每篇 = 一个子 run(parent_run_id 关联)
  → 收集结果(成功/失败分别计数)
  → 失败的篇目可单独重跑(用同一 pipeline_version_hash 保证可比对)
  → parent_run 聚合产出报告
```

> 并发闸 + 成本熔断由调度层强制；超时/重试由各 Agent Daemon 自治。这样既绕开 Flowise 串行限制，又不破坏 Flowise 单次 run 的语义。

### 6.6 异步长任务流（复现/训练场景）

```
Pipeline 内 Human Input / 调度层发起 → 创建 run(status=running)
  → 立即返回 { run_id, status: 'running' }
  → 后台执行(可能数小时) —— Agent Daemon 长连接或轮询
  → 完成后:
       选项A: POST 回指定 webhook
       选项B: 前端轮询 GET /api/v1/runs/:id
  → 结果存对象存储, URL 回传, run.status=done
```

> Flowise Human Input 节点的检查点持久化天然支持「暂停 → 等人工 → 恢复」，即便服务重启也能续跑，适合长任务里的关键审批点。

### 6.7 Agent Daemon 执行流（异构 agent 如何被 flow 调用）

这是 §6.2 中「HTTP 节点 → 异构 agent」的展开，也是 multica daemon/server 协议在本平台的落地：

```
Flowise HTTP 节点
  → POST 中央 dispatch /invoke  { agent_daemon_id, prompt, exec_options, run_id }
  → 中央: 创建 dispatch_task(status=queued)，立即返回 task_id（或挂起等结果）
  → 某个已注册的本地 Agent Daemon 主动 claim:
       POST 中央 /tasks/claim { daemon_id }  → 领到 task
       POST 中央 /tasks/:id/start
       daemon 内部: backend.execute(prompt, opts)
            → spawn CLI(claude/codex...)
            → 流式解析 stream-json → AgentEvent
       执行中: POST 中央 /tasks/:id/messages  (流式 text/tool-use/...)
               POST 中央 /tasks/:id/progress
       完成:   POST 中央 /tasks/:id/complete { AgentResult, usage }
            或 POST 中央 /tasks/:id/fail { error }
  → 中央收集事件流，回传 Flowise（SSE 或轮询）
  → 中央把 usage/耗时写入 runs.agent_daemon_calls
```

**关键设计点（参照 multica）**：
- **拉取式（pull-based）**：daemon 主动 claim，而非中央推送。这让中央无需关心 daemon 是否在线、是否忙碌，只需维护任务队列；daemon 重启后自动恢复领任务。
- **daemon 心跳保活**：daemon 定期 `heartbeat`，中央据此判断 daemon 健康度、路由任务（离线 daemon 不派任务）。
- **超时双保险**：daemon 内 `timeoutMs`（总超时）+ `inactivityTimeoutMs`（静默超时，参照 multica 双层 watchdog）；中央也有 task 级超时兜底。
- **session resume**：`AgentResult.sessionId` 可存入下次 `ExecOptions.resumeSessionId`，支持跨调用的多轮协作。
- **agent 当节点语义**：对 Flowise 而言，这整个流程就是一次「HTTP 节点调用」——它不关心背后是 daemon 还是别的，只看到「输入 prompt → 输出结果/事件流」。Flowise 全程掌控编排，agent 是被调节点（MVP；agent 反向驱动 flow 见 §11.2）。

> 这套协议与 multica `internal/daemon/client.go` 的 claim/start/messages/complete/fail/usage 接口形状一致，是经过生产验证的 daemon↔server 契约。

---

## 7. 资源管理面板设计

### 7.1 两类资源（沿用 v0.1）

| 类别 | 实体 | 来源 | 治理动作 |
|---|---|---|---|
| **API 资源** | LLM key、凭证、模型 provider | 网关层 `api_keys` 治理 + Flowise credentials | 配额、轮转、失效告警 |
| **算力资源** | GPU、沙箱、远程设备 | `daemons` + `agent_daemons`（异构 agent 背后） + 自研调度 | 调度、排队、回收 |

### 7.2 面板功能（MVP）

```
资源面板
├─ API 资源
│  ├─ 各 provider 用量曲线(tokens/$)        ← Langfuse 数据
│  ├─ key 健康状态(额度/限流/失效)           ← 网关层探测
│  └─ 按 workspace/agent 的用量分摊          ← runs 表聚合
├─ 算力资源
│  ├─ Agent Daemon 调用次数 / 平均耗时 / 失败率   ← runs.agent_daemon_calls
│  ├─ 各 daemon 在线状态与并发占用             ← daemons 心跳 + dispatch_tasks
│  └─ 远程设备(daemon 所在机器)在线状态
└─ 成本
   ├─ 实时成本(按 model/daemon/run 汇总)
   └─ 预算阈值与熔断告警
```

### 7.3 数据来源（比 v0.1 大幅简化）

- **Langfuse**：自动捕获每次 Flowise run 的 token/cost/latency/metrics（[官方集成](https://langfuse.com/integrations/no-code/flowise)）
- **自研 runs 表**：`agent_daemon_calls` 字段聚合异构 agent 的调用计量
- **网关层**：API key 健康探测、限流计数

> 对比 v0.1 §7.3：v0.1 需要「定时从 lobehub 与 langflow 两边拉取、写入聚合表」。**单引擎后此聚合层消失**——数据源收敛为 Langfuse + 自研 runs 表两个。

### 7.4 ⚠️ MVP 边界（沿用 v0.1）

- GPU 调度：MVP **只展示占用，不实现调度**（沙箱能跑代码，但 GPU 训练队列需自研，超出 MVP）
- 凭证轮转：MVP 只支持手动，不实现自动轮转

---

## 8. 用户、监控与可观测性

### 8.1 用户与权限

- **认证**：网关层自研 SSO（支持 OIDC / betterAuth）。Flowise 自带的认证由网关透传的 token 覆盖，避免两套登录。
- **RBAC**：本平台自建最小权限模型（`rbac_roles` / `rbac_permissions`），作用于网关层路由与 runs 可见性。Flowise 内部编辑权限可单独配，但生产建议统一走网关。
- **多租户**：MVP 用 workspace 软隔离（共享库，按 `workspace_id` 过滤）。

### 8.2 监控面板

| 维度 | 数据源 | 展示 |
|---|---|---|
| 任务监控 | 自研 `runs` 表 | 运行/排队/失败数、时长分布、任务树 |
| Agent 监控 | Langfuse + runs | 调用次数、token、成功率、各 daemon 耗时 |
| Pipeline 监控 | Flowise run 历史 + pipeline_versions | 版本运行历史、节点耗时 |
| 资源监控 | §7 | 见资源面板 |

### 8.3 日志与 Tracing

- **统一 Trace 后端**：Langfuse（Flowise 原生支持）
- **每条 trace 携带**：`run_id` / `pipeline_id` / `pipeline_version_hash` / `agent_id` / `user_id`，串起全链路
- **结构化日志**：网关、dispatch、daemon、调度 worker 的日志走 stdout，带 `run_id`，由采集器（Loki/ELK）聚合
- **审计日志**：敏感操作（key 操作、权限变更、删除、版本锁定）单独记录

### 8.4 可观测性设计原则（沿用 v0.1）

1. **trace 全链路贯穿**：网关注入 `run_id` → Flowise run → daemon call → LLM call，同一 traceId
2. **结构化优先**：所有日志带 `run_id`，可按任务反查
3. **采样与成本**：MVP 全量 trace；规模化后对成功请求采样，失败/慢请求全留

---

## 9. 可扩展性设计（核心章节）

> MVP 是单机，但**架构必须保证：扩到多机时只加机器、加 worker，不改业务代码**。此原则与 v0.1 一致，但 v0.1 §9.5.1 点名的最大硬伤在 v0.2 已不存在。

### 9.1 扩展性目标与瓶颈分析

"Dagents"的真实瓶颈不在 agent 数量（DB 行数好办），而在：

| 瓶颈 | 原因 | MVP 策略 | 扩展路径 |
|---|---|---|---|
| **并发执行** | 同时跑的 agent/flow | 限制并发数 | 加 worker + 队列 |
| **LLM 调用吞吐** | 上游限流 | 限流 + 排队 | 多 key 池 + 负载均衡 |
| **DB 写入** | 海量 trace/message | 先写后批量归档 | 读写分离 + 分表 |
| **存储容量** | 文件/artifact/快照 | 对象存储 | 天然可扩展 |
| **长任务调度** | 训练/复现数小时 | run + 轮询 | 专用调度器（K8s/Ray） |
| **Agent Daemon 并发** | 单 daemon 进程并发上限 | daemon 自治并发闸 | 加 daemon 副本（可跨机） |

### 9.2 水平扩展的三个前提（MVP 必须满足）

1. **服务无状态**：Flowise / 网关 / 中央 dispatch / 调度 worker 实例可随意重启/复制，状态全在存储层（§5.5）。**Agent Daemon 例外**：它本就是有状态的本地常驻进程（spawn CLI），但状态通过 session resume + 重新 claim 可恢复。
2. **任务走队列**：执行不绑死在请求线程，进 Redis 队列由 worker 消费；异构 agent 任务进 `dispatch_tasks` 由 daemon 主动 claim
3. **会话可迁移**：Flow State 外置到 Redis，任何 Flowise 实例都能接续某次运行

### 9.3 从 MVP 到规模化的演进路径

```
阶段0 (MVP): 单机 docker-compose
  └─ 验证全闭环, 并发数 ~10

阶段1: 应用层水平扩展
  ├─ Flowise 多实例 + 负载均衡（共享 PG + Redis，Flow State 外置）
  ├─ Agent Daemon 多副本（可跨机部署，按 capability 路由任务）
  ├─ Redis 队列 + N 个调度 worker
  └─ 并发数 ~100

阶段2: 存储与调度扩展
  ├─ PostgreSQL 读写分离 → 分库(按 workspace 分片)
  ├─ trace 冷热分层(热 PG, 冷 S3/数仓) —— Langfuse 原生支持
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
| 服务不持有运行态 | `runs` 表 + Flow State 外置 Redis | 运行可跨实例接续 |
| LLM key 可池化 | 网关层 `api_keys` 多 key | 突破单 key 限流 |
| trace/metric 标准化 | OTel + Langfuse | 换后端不改代码 |
| 文件走对象存储 | MinIO（S3 兼容） | 换 S3/OSS 不改代码 |
| API 统一前缀与版本 | `/api/v1/...` | 网关可替换 |
| Agent Daemon 状态可恢复 | daemon 用 session resume + 重新 claim 恢复 | daemon 可多副本、可跨机 |

### 9.5 ⚠️ Flowise 的扩展性注意点（替代 v0.1 的「两个硬伤」）

v0.1 §9.5 点名了两个开源项目硬伤。v0.2 中：

1. ~~**协作循环在浏览器**~~：**已不存在**。Flowise Agentflow V2 天生后端化。
2. ~~**无内置 GPU 调度**~~：**仍然成立**。Flowise 的代码沙箱是「执行器」而非「GPU 训练队列」。长时训练需自研调度层（阶段2）。这与 v0.1 一致。

**Flowise 自身需关注的扩展点**（v0.2 新增）：

- **Flow State 默认进程内**：必须改造为 Redis backend（§5.5），否则多实例 Flowise 无法共享运行态。这是 v0.2 的关键改造点之一。
- **Iteration 串行**：批量并行靠自研调度层 fan-out（§6.5），不依赖 Flowise 单实例吞吐。
- **单实例 Prediction API 吞吐**：阶段1 靠 Flowise 多副本 + 前置负载均衡解决，前提是 Flow State 已外置。

---

## 10. 应用样例：论文批量复现

> 作为架构的具象落点。完整复现成功率受限于科研难度，平台提供的是"协作 + 执行 + 可追溯 + 人工介入"框架。场景与 v0.1 §10 一致，落地方式简化为单引擎。

### 10.1 场景拆解

对 N 篇 Nature 论文，用多专家协作复现关键结果。每个专家是一个 Agent。

### 10.2 专家角色定义（Agent）

| 专家 Agent | systemPrompt 要点 | 关键工具 | agent 类型 |
|---|---|---|---|
| 文献解读 | 提取方法/数据集/超参/指标 | Retriever 节点（知识库） + Tool | Flowise 原生 Agent |
| 环境配置 | 处理依赖冲突 | HTTP→中央dispatch→claude-code daemon | 异构（claude-code） |
| 代码复现 | 逐模块实现论文方法 | HTTP→daemon 或 Tool | 异构或原生 |
| 实验执行 | 跑训练/推理 | HTTP→daemon(GPU机) + 长任务 run | daemon + 调度层 |
| 结果验证 | 数值比对、找差异 | Tool + Loop 迭代 | Flowise 原生 |
| 协调者 | 分派/汇总/决定返工 | Condition Agent 路由 | Flowise Condition Agent |

> **注意**：实验执行这类需要 GPU 或特定环境的专家，其 daemon 部署在 GPU 机上（中央 dispatch 按 capability 路由）。这正是 daemon 可远程部署架构的价值——编排服务器无需 GPU，GPU daemon 主动 claim 训练任务。

### 10.3 编排架构（单引擎，一个画布搞定）

```
批量层 (调度层 fan-out 或 Flowise Iteration)
  [论文清单 N 篇] → 并发 fan-out(max=10) → 每篇一个子 run
                                                    ↓
单篇层 (Flowise Agentflow V2: reproduce_one)
  Start
   ├─ [Agent: 文献解读] → 复现清单
   ├─ [Condition Agent: 路由] 决定下一步
   ├─ [HTTP→中央dispatch: 环境配置] → 派给 claude-code daemon
   │      → [Human Input: humanApprove] ← 检查点暂停，可跨重启恢复
   ├─ [HTTP→中央dispatch: 代码复现] → daemon
   ├─ [HTTP→中央dispatch: 实验执行] → GPU 机 daemon → 长任务 operationId
   ├─ [Agent: 结果验证] → [Condition] 不达标则 Loop 回代码复现
   └─ [Agent: 协调者] → Direct Reply 报告
```

> **对比 v0.1 §10.3**：v0.1 需要「langflow 批量层 + lobehub AgentGroup 协作单篇层」两段式跨系统编排，且协作要等 §6.4 改造。**v0.2 在一个 Flowise 画布内完成全部编排**，批量层用调度层 fan-out（或 Iteration），单篇层用 Agentflow V2 的 Agent/HTTP/Condition/Human Input 节点直接串起来。

### 10.4 关键集成点

- 调度层 fan-out → 并发调 Flowise `POST /api/v1/prediction/{reproduce_one_flowId}`，body 带单篇输入与子 run 的 sessionId
- 异构 agent：Flowise `HTTP` 节点 → `POST 中央dispatch/invoke` → dispatch 创建 `dispatch_task` → 某 daemon claim → spawn CLI（详见 §6.7）
- 长任务：daemon 执行数小时的训练，dispatch_task 持续 running，Flowise 轮询 `GET /api/v1/runs/:id` 或 webhook 取结果
- 全程 trace 串到同一 `run_id`（批量层为 parent_run_id，单篇为子 run_id，daemon 调用进 agent_daemon_calls），便于复盘"这篇为什么没复现成功"
- **版本绑定**：每次批量跑都锁定 `reproduce_one` 的 `pipeline_version_hash`，失败篇目可用同一 hash 重跑，结果可比对

### 10.5 务实预期（沿用 v0.1）

- 平台提供框架，**不保证复现成功**
- 建议定位为"AI 辅助复现 + 专家在环"，关键节点 `Human Input` 兜底
- 先跑通 1 篇方法清晰、有开源参考的论文，再扩展到批量

---

## 11. 技术选型与决策记录

### 11.1 核心选型

| 决策 | 选择 | 理由 | 代价 |
|---|---|---|---|
| 编排引擎（唯一） | **Flowise** | Agentflow V2 一套覆盖可视化 DAG + 多 agent 协作 + 批量 + HITL，且天生后端化；Node/TS 单栈最轻 | Iteration 串行、无版本锁定需自研补 |
| 异构 agent 接入 | **自研 Agent Daemon 两段式**（参照 multica） | 拉取式 daemon 支持长任务/远程机/并发治理；中央 dispatch 衔接 Flowise | 要写中央 dispatch + 每 agent 一个 daemon adapter |
| 对话运营 UI | **轻量自研 Chat 前端** | 只做对话+会话+切换，不碰编辑器；比 lobehub 轻 90% | 需自建前端，但范围极小 |
| 自研层栈 | **全 TypeScript/Node** | 与 Flowise 同栈，运维单一，可回贡 | — |
| 数据库 | PostgreSQL | Flowise 原生支持，事务/JSON 强 | 单点需分库扩展 |
| 队列/缓存/状态 | Redis | 轻量、通用、承载 Flow State 外置 | 需持久化配置 |
| 对象存储 | MinIO(MVP)→S3 | S3 兼容，无缝迁移 | 自运维 |
| Trace | Langfuse + OTel | Flowise 原生支持 | 自部署 |

### 11.2 关键权衡

**Q：为什么从 lobehub + langflow 退回单引擎？**
A：实际使用后发现两者各自太重、方向偏强——langflow 重在 Python LangChain 组件生态，lobehub 重在对话运营前端。本平台核心诉求是「编排 agent」，不是「做最强对话平台」也不是「做最强组件市场」。Flowise 单引擎恰好覆盖编排所需全部能力（DAG + 协作 + 批量 + HITL），且天生后端化，省掉了 v0.1 最大的改造风险（协作后端化）和集成成本（实体映射表）。**少即是多**。

**Q：为什么异构 agent 用「daemon 两段式」而非 MCP / Custom Tool / 被动 HTTP bridge？**
A：四种方案对比（关键决策，调研 multica + open-design 后定）：
- **Custom Tool + child_process**（Flowise 节点内 spawn CLI）：零额外组件，但与 Flowise JS 沙箱强耦合、难做超时/重试/并发治理/审计、难水平扩展（agent 状态漂在 Flowise 进程里）。仅适合 demo。
- **被动 HTTP bridge**（v0.2 草案曾选）：统一接口、可控。但真实 coding agent 执行时间长（分钟~小时）、常需访问特定机器（repo/GPU/内网）、需并发治理——被动服务无法承载，长连接易断、部署位置受限。
- **MCP Server 封装**：最标准最解耦，Claude Code/Codex 正陆续原生支持。但 MCP 协议偏「工具调用」语义，对「长任务/流式/HITL/session resume」这类 agent 生命周期场景支持偏弱，且被动等待调用，同样有部署位置问题。
- **自研 Agent Daemon 两段式**（参照 multica，**本平台选择**）：中央 dispatch + 本地 daemon。daemon 主动 claim 任务（拉取式），可部署在任意机器、可多副本、自治超时/重试/并发；中央只做任务队列与 Flowise 衔接。这是经过 multica 生产验证的架构（`internal/daemon` + `pkg/agent`），完整覆盖长任务/远程机/并发治理/session resume。

> **参照而非依赖 multica**：multica server 是 Go 写的，与 v0.2「全 TS」决策冲突，且其 modified Apache 2.0 license 禁止直接做 SaaS。本平台**参照其 `Backend` interface 形状与 daemon/server 协议（claim/start/messages/complete），用 TS 自研实现**，不引入其源码。详见附录 D'。
>
> MCP 仍作为 daemon 内部「备选路径」保留：当某异构 agent 原生提供 MCP server 时，daemon adapter 可内嵌 MCP client 直接对接。两条路径不冲突。

**Q：multica 式 agent 如何参与 agent flow？MVP 支持到哪一层？**
A：两种语义，MVP 只做**方式 A**：
- **方式 A（MVP）：agent 当被调节点**。Flowise HTTP 节点 → 中央 dispatch → daemon → spawn CLI。Flowise 全程掌控编排，agent 只负责「接到 prompt、干完活、回结果」。覆盖论文复现等大部分场景，用 Flowise 原生 HTTP 节点即可，零额外机制。
- **方式 B（演进）：agent 反向驱动 flow**。coding agent 在执行中通过 MCP 工具调用 `flow.continue(nextNode, payload)` 动态决定下一步——适合目标不固定的「解题流水线」。需在 daemon 嵌入 flow 控制回调，复杂度高，且 Flowise Condition Agent 已能覆盖大部分动态决策需求，故 MVP 不做。

**Q：协作循环为什么不再需要后端化改造（v0.1 的最大风险点）？**
A：Flowise Agentflow V2 是 Node 服务端执行的状态机引擎，节点依赖解析、执行队列、Flow State 共享、HITL 检查点持久化全在服务端。浏览器只负责展示与人工审批交互。v0.1 §6.4 评估的约 1500 行改造工作量（重写协作引擎、去浏览器依赖、新增触发路由、异步化）在 v0.2 中**为零**。

**Q：为什么不直接上 K8s？**
A：与 v0.1 一致。MVP 用 docker-compose 验证闭环，K8s 引入运维复杂度但不改变架构。架构预留无状态 + 队列 + Flow State 外置后，阶段1 再上 K8s 是平移而非重写。

---

## 12. 实施路线图

### MVP（目标：单机跑通全闭环）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 基础设施** | docker-compose 起 Flowise + PG + Redis + MinIO + Langfuse + 网关骨架 + 中央 dispatch 骨架 | Flowise 画布可访问，PG 连通，网关/dispatch 能起 |
| **M1 单 Agent 验证** | Flowise 建 1 个 Agent 节点，跑通对话 + 工具 | Chat 前端（或 Flowise 自带 chat）能对话 |
| **M2 第一个 Agent Daemon** | 自研中央 dispatch 任务派发 + claude-code daemon adapter（spawn CLI），Flowise HTTP 节点 → dispatch → daemon 跑通 | 画布内能调 Claude Code 拿到结果 |
| **M3 批量执行** | 调度层并发 fan-out，跑通 N 输入批量；Flow State 外置 Redis | 批量任务可跑可查，重启可续 |
| **M4 版本可复现** | flow JSON 快照 + 哈希锁定 + run 绑定版本 + artifact 归档 | 同一 hash + 同一 input 可重跑并比对 |
| **M5 轻量 Chat 前端** | 自研精简对话前端（对话 + 会话列表 + agent 切换） | 前端能切换 agent、查历史、触发 run |
| **M6 监控日志** | Langfuse 接入，全链路 trace 串 run_id；资源面板 MVP | 任一任务可全链路追溯，面板可看用量/成本 |

> 对比 v0.1：**省掉 M3「协作后端化」**（v0.1 最大风险点）。M2「第一个 daemon」是关键技术验证点（spike）——验证中央 dispatch ↔ daemon 的 claim/start/complete 协议与 claude-code adapter 可行，建议尽早做。

### MVP 之后（不在本文档展开）

- 应用水平扩展（阶段1）
- 存储与调度扩展（阶段2）
- 多租户强隔离与百万级（阶段3）

---

## 13. v0.1 → v0.2 迁移与差异

> 供团队评审：明确哪些设计被推翻、哪些保留、哪些强化。

### 13.1 被推翻的设计

| v0.1 设计 | 推翻理由 | v0.2 替代 |
|---|---|---|
| lobehub + langflow 双引擎组合 | 两者各自太重、方向偏强；集成成本高（双栈 + 实体映射） | Flowise 单引擎 |
| 跨系统实体映射表（§5.4） | 单引擎无需映射 | 删除 |
| 协作循环后端化改造（§6.4，最大风险点） | Flowise 天生后端化 | 无需改造 |
| 双技术栈（TS + Python） | 运维两套栈 | 全 TypeScript/Node |
| lobehub 重型对话运营平台 | 超出「编排 agent」诉求 | 轻量自研 Chat 前端 |

### 13.2 被保留的设计

| 设计 | 保留理由 |
|---|---|
| 五类能力目标（解题/批量/资源/实体定义/监控） | 平台要解决的问题未变 |
| 状态外置原则（§5.5） | 水平扩展的前提，不变 |
| 异步 operationId 模式（同步触达 + 异步执行） | 长任务通用模式 |
| workspace 软隔离（MVP） | 多租户渐进策略 |
| 可观测性优先（trace 全链路 + 结构化日志） | 运维基础 |
| 不做 GPU 训练调度（MVP 外） | 边界一致 |
| 异构 agent 概念（Claude Code/Codex） | 核心诉求，接入方式变（→ Agent Daemon）但概念保留 |

### 13.3 被强化的设计

| 设计 | v0.1 | v0.2 强化点 |
|---|---|---|
| 异构 agent 接入 | lobehub `agencyConfig` 字段 | Agent Daemon 两段式（参照 multica）：中央 dispatch + 本地 daemon，拉取式、可远程/多副本、自治超时/重试/并发 |
| 版本可复现 | 依赖 langflow `flow_version` | 自建 `pipeline_versions` + 哈希锁定，不依赖引擎 |
| 批量并发 | 依赖 langflow `loop` | 自研调度层并发 fan-out，绕开 Iteration 串行 |
| Flow State 持久化 | 依赖 lobehub operationId | 明确外置到 Redis，解跨 session + 跨实例 |
| 任务实例表 | 依赖 lobehub `tasks`/`async_tasks` | 自建 `runs` 表，引擎无关 |

---

## 附录 A'：Flowise 能力清单（v0.2 依赖依据）

| 能力 | 实现位置 | 状态 |
|---|---|---|
| Agentflow V2 DAG 引擎 | 服务端状态机引擎 | ✅ 天生后端化 |
| 14 类节点 | Start/LLM/Agent/Tool/Retriever/HTTP/Condition/Condition Agent/Iteration/Loop/Human Input/Direct Reply/Custom Function/Execute Flow | ✅ |
| HITL（人在回路） | Human Input 节点 + 检查点持久化 | ✅ 可跨重启恢复 |
| MCP 工具节点 | Tools & MCP 集成 | ✅ 一等公民 |
| HTTP 出站 | HTTP 节点 | ✅ ★ 调中央 dispatch（异构 agent）的入口 |
| Custom Tool（服务端 JS） | Custom Tool 节点 | ✅（沙箱对 child_process 支持有限） |
| Prediction API（REST 触发） | `/api/v1/prediction/{flowId}` | ✅ 批量 fan-out 调用入口 |
| Webhook 入站 | Webhook 节点 | ✅ |
| 流式输出 | SSE | ✅ |
| Tracing | Langfuse 原生集成 + OTel | ✅ |
| 多 DB 支持 | SQLite/PostgreSQL/MySQL | ✅ 生产用 PG |
| 认证 | 内置 + 可被网关覆盖 | ✅ |
| **批量并行** | Iteration 节点 | ❌ **串行**（[#6571](https://github.com/FlowiseAI/Flowise/issues/6571)），自研调度层补 |
| **Flow State 持久化** | 默认进程内 | ❌ **不跨 session**，自研外置 Redis 补 |
| **版本锁定复现** | 无 | ❌ 自建 `pipeline_versions` 补 |
| **任务实例表** | 无（只有 chat history） | ❌ 自建 `runs` 表补 |
| **GPU 调度** | 无 | ❌ 阶段2 自研 |

## 附录 B'：本平台自研清单

| 自研项 | 层 | 优先级 | 说明 |
|---|---|---|---|
| 统一网关 + SSO + Trace 注入 | 网关观测层 | 高 | 单入口、统一鉴权、生成 run_id |
| 中央 dispatch server | 能力适配层 | 高 | 任务队列 + daemon 注册表 + Flowise 衔接（参照 multica server 侧） |
| Agent Daemon + adapter（claude-code 首批） | 能力适配层 | 高 | 本地常驻、claim 任务、spawn CLI、`Backend` interface（参照 multica daemon） |
| 调度层（队列+并发闸+熔断+fan-out） | 调度层 | 高 | 规模化与批量并发的关键 |
| 版本可复现层 | 可复现层 | 高 | flow 快照 + run 绑定 |
| 轻量 Chat 前端 | 接入层 | 中 | 对话+会话+切换，不碰编辑器 |
| Flow State Redis backend | 存储层改造 | 高 | 解跨 session + 跨实例 |
| codex/远程 runtime 等 daemon adapter | 能力适配层 | 低 | 按需，参照 multica `pkg/agent/*.go` |
| GPU 训练调度 | 调度层 | 低(MVP外) | 阶段2 |

## 附录 C'：风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| Flowise 版本升级破坏集成（如 V1→V2 已有先例 [#4756](https://github.com/FlowiseAI/Flowise/issues/4756)） | 阻塞 | 锁 Docker 镜像 tag + 集成测试 + 版本快照锁定 run |
| Iteration 串行限制批量吞吐 | 批量慢 | 自研调度层并发 fan-out 绕开（§6.5） |
| Custom Function 沙箱限制 child_process | 异构 agent 接入受阻 | 走 Agent Daemon（外部进程 spawn CLI），不依赖节点内 spawn |
| 中央 dispatch ↔ daemon 协议自研工作量大 | 阻塞 M2 | 直接参照 multica `internal/daemon/client.go` 的 claim/start/messages/complete 协议；MVP 先单 daemon 同机验证 |
| daemon 离线导致任务积压 | 任务卡死 | daemon 心跳 + 中央任务超时回收 + 重新派发其他 daemon |
| Flow State 外置改造工作量大 | 阻塞 M3 | 优先验证 Flowise 是否原生支持 Redis state backend；否则薄封装 |
| 论文复现成功率低 | 场景验证失败 | 定位为"辅助复现"，选易复现论文起步，HITL 兜底 |
| LLM 成本失控 | 批量跑爆账 | 预算熔断 + 单 run 上限 + 并发闸 |
| Flowise 单实例 Prediction API 吞吐瓶颈 | 阶段1 扩展受阻 | Flowise 多副本 + 前置负载均衡（前提：Flow State 已外置） |

---

## 附录 D'：设计参考来源（异构 agent / Agent Daemon）

本平台的 Agent Daemon 两段式架构（中央 dispatch + 本地 daemon）参照以下开源项目的设计，但**用 TypeScript 自研实现，不引入其源码依赖**。

### multica（主要参照对象）

- **定位**：开源「把 coding agent 变成可指派队友」的托管平台（task/issue/skill/squad）。与 dagents 契合度最高。
- **技术栈**：server 用 **Go**，前端 TS。`server/pkg/agent`（纯适配器）+ `server/internal/daemon`（本地守护进程）+ `server/internal/daemonws`（WS 通信）。
- **license**：modified Apache 2.0——**禁止直接拿其源码做 SaaS 或嵌入商业产品卖给第三方**，但「组织内部使用（含多 workspace）」与「参照设计自研实现」均允许。
- **具体借鉴点**：
  | 借鉴内容 | multica 位置 | 本平台对应 |
  |---|---|---|
  | 统一执行接口 `Backend.Execute()` | `server/pkg/agent/agent.go` | §4.1 `AgentBackend.execute()`（TS 翻译版） |
  | 双通道 Session（Messages 流 + Result） | `agent.go` Session 结构 | §4.1 `AgentSession.events + result` |
  | ExecOptions（cwd/model/timeout/resume/mcp/thinking） | `agent.go` ExecOptions | §4.1 `ExecOptions` |
  | daemon↔server 协议（claim/start/messages/complete/usage） | `internal/daemon/client.go` | §6.7 Agent Daemon 执行流 |
  | 双层 watchdog（总超时 + 静默超时） | `internal/daemon`（`failForInactivity`） | §4.1 `timeoutMs + inactivityTimeoutMs` |
  | per-agent adapter 文件 | `pkg/agent/claude.go`/`codex.go`/... | 计划：`daemon/adapters/claude.ts`/`codex.ts` |
  | 任务派发（autopilot + issue→agent） | `internal/handler/autopilot.go` | §6.7 中央 dispatch + Flowise HTTP 节点 |
  | adapter 实战知识（argv/stream-json/Windows 坑） | 各 `*.go` | 翻译为 TS adapter 时直接参考 |

### open-design（次要参照对象）

- **定位**：开源「Claude Design 替代品」本地设计工具，其 agent bridge 是最强的多 CLI 适配器实现（24 个 adapter）。
- **技术栈**：全 TypeScript（Node daemon + Next.js + Electron），与 v0.2 同栈。
- **具体借鉴点**：`RuntimeAgentDef` 数据驱动注册表、`acp.ts`（ACP 协议客户端）、`defs/claude.ts`/`codex.ts`（adapter 知识）、`ChatSseEvent`（SSE 事件契约）。
- **不直接采用原因**：bridge 嵌在 8912 行的设计产品 daemon 中，耦合设计概念，无独立库边界，fork 成本高。

### 边界声明

- 本平台**只参照上述项目的接口形状、协议设计与 adapter 知识**，所有代码用 TypeScript 自研。
- 不引入 multica/open-design 源码依赖，规避 multica 的 SaaS 限制。
- 若未来某 adapter（如 codex）的 spawn/解析逻辑复杂，可考虑参考 open-design 对应 TS 文件（同语言，license 为 MIT/Apache，需核对）。

---

> **下一步建议**：本文档评审通过后，从 M0/M1 起步。**M2（中央 dispatch + 第一个 claude-code daemon，参照 multica 协议）与 Flow State 外置验证**是两个关键技术验证点（spike），建议尽早做。相比 v0.1，v0.2 不再有「协作后端化」这一最大风险点，整体路线更平顺。
