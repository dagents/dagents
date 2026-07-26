# Dagents 平台 —— MVP 可执行 Plan（设计稿）

> **版本**：v0.2-exec-plan / 草案 1
> **日期**：2026-07-08
> **上游文档**：`docs/architecture-v0.2.md`（架构设计）。本文档把它展开成可执行的工程蓝图。
> **状态**：待评审。本稿基于对 `~/Projects/Flowise`（v3.1.3 fork）与 `~/Projects/multica`（Go，modified Apache 2.0）的实际勘察，不是凭文档叙事推导。
> **执行者画像**：单人主导（偶尔 dispatch 子 agent）。关键路径标注为严格串行，避免上下文切换。
> **粒度**：Part 2 的 WBS 到 PR 级任务（0.5–2 天/任务），可直接喂给 writing-plans 拆成编码任务。

---

## 阅读指引

- **Part 0**：架构决策与两个 Gate。**先读这一章**——它决定后面所有走向，且包含对 v0.2 文档几处论断的修正。
- **Part 1**：执行轨道。按薄层切，每层给出模块边界 + TS 接口契约 + 从空壳到完整的任务序列。静态视图。
- **Part 2**：里程碑时序。M0–M6 的 WBS，引用 Part 1 的任务 ID。动态视图。
- **附录**：风险登记、技术选型表、与 v0.2 文档差异声明、multica 协议翻译对照。

任务 ID 约定：`P1.<层>.T<n>` = Part 1 某层的第 n 个任务；`P2.M<n>.<seq>` = Part 2 某里程碑内的序列号。Part 2 的 WBS 通过引用 Part 1 的任务 ID 避免重复。

---

# Part 0 — 架构决策与 Gate

## 0.1 决策快照表

下列决策已在 brainstorming 阶段锁定。后续 Part 1/2 基于它们展开，不再重新讨论。

| # | 决策点 | 锁定值 | 依据 |
|---|---|---|---|
| D1 | 编排引擎 | **Fork 整个 Flowise 进 monorepo，直接改源码，暂不裁剪** | 用户要"代码在手、想改就改"；调研确认执行引擎耦合在 `packages/server`，无独立包可引，外部扩展点不足以支撑 Redis state 改造 |
| D2 | Flowise 位置 | `vendor/flowise/`，保留其 pnpm+turbo 结构，root workspace 包含它 | 保留上游可 merge 性 |
| D3 | Fork remote | M0 第一件事：在 GitHub 建自己的 fork，改 `origin` 指向 fork，`upstream` 指向 `FlowiseAI/Flowise` | 当前 `~/Projects/Flowise` 的 origin 仍指向上游 |
| D4 | 画布 | 用 Flowise 原生 `ui`（由 forked server 提供），不自研画布 | fork 已得画布，无需重复造 |
| D5 | 控制台前端 | 自研 `apps/console`（Next.js），6 页（对话/Agents/AgentFlows/Lab/Workspace/设置），**画布编辑仍用 Flowise 原生 UI** | D17 细化；v0.2 §1.3 "轻量 Chat" 边界已被 D17 推翻 |
| D6 | 自研层栈 | 全 TypeScript/Node，pnpm workspace monorepo | 与 Flowise 同栈 |
| D7 | Web 框架 | 网关与 dispatch 用 **Hono** | 轻、TS 原生、中间件够用 |
| D8 | DB 层 | **跟 Flowise 用 TypeORM**，自研表与 Flowise 表同库同 ORM，单一迁移系统 | 与 Flowise 统一，避免双 ORM |
| D9 | 队列/缓存/状态 | Redis | v0.2 §5.1 |
| D10 | 对象存储 | MinIO（MVP）→ S3 | S3 兼容 |
| D11 | Trace | Langfuse + OTel | Flowise 原生支持 Langfuse |
| D12 | 异构 agent 接入 | 自研 Agent Daemon 两段式（中央 dispatch + 本地 daemon），**参照 multica 协议用 TS 翻译，不引入其源码** | multica modified Apache 2.0 禁止 SaaS 但允许内部参照自研 |
| D13 | 协议翻译范围 | 取 multica 核心：register/heartbeat/claim/start/progress/messages/complete/fail/usage/session。**不取** branchName/git/gc-check/local-skills（multica 专有领域） | 见附录 D 对照表 |
| D14 | Plan 形态 | 双层结构（Part 1 静态 + Part 2 动态）+ 两个 Gate | brainstorming 确认 |
| D15 | 裁剪 | M0 不裁剪 Flowise（observe/市场/多租户留着不用）。裁剪留作后续按需 | 用户明确"先不做裁剪" |
| D16 | 工时估算 | 给乐观/悲观区间，标注为粗估 | 单人执行需识别关键路径 |
| D17 | 前端范围 | **完整控制台**（6 页：资源看板/Agents/AgentFlows/Lab/Workspace/设置），`apps/chat-web` 改名 `apps/console` | 原型设计要求；用户拍板 A1 |
| D18 | API Key 管理 | **接 new-api**（本地 `~/Projects/new-api`，Go LLM 网关，docker 端口 3000）。令牌由 new-api 签发托管，平台本地不存 key 原文，只管 token CRUD + 本地 remark/group 元数据 | 原型 settings 明确用 new-api；用户拍板 B1 |
| D19 | Lab/Workspace | **都进 MVP**。Lab 多 agent 聊天室 + Workspace 项目对话页 | 用户拍板 C1 |

**D8 备注（TypeORM 锁定）**：Flowise server 用 TypeORM + typeorm-cli 迁移。自研表与 Flowise 表同库同 schema，共享 `typeormDataSource`，单一迁移系统。代价：TypeORM 的 TS 体验不如 Prisma（装饰器、类型推断较弱），但避免了双 ORM / 双迁移的更大代价。`packages/db` 的 entities 用 TypeORM 装饰器写，迁移走 `migration:generate`/`migration:run`，与 Flowise 的迁移命令一致。

## 0.2 最终 monorepo 结构

```
dagents/
├─ apps/
│  ├─ gateway/          # 自研① 网关观测层（Hono）：SSO/路由/限流/审计/Trace 注入/new-api 代理
│  ├─ dispatch/         # 自研② 中央 dispatch server（Hono + WS）：任务队列 + daemon 注册
│  ├─ scheduler/        # 自研③ 调度 worker：消费 Redis 队列，并发闸/fan-out/熔断
│  └─ console/          # ★ 自研控制台（Next.js，原 chat-web）：6 页 UI（D17）
├─ packages/
│  ├─ contracts/        # ★ 共享类型：Backend/ExecOptions/AgentEvent/AgentResult/协议 DTO
│  ├─ agent-adapters/   # per-agent adapter（claude.ts/codex.ts...），实现 contracts.Backend
│  ├─ daemon/           # 本地 Agent Daemon 常驻进程：claim→execute→complete
│  ├─ db/               # TypeORM entities + 迁移（自研表；Flowise 表在 vendor）
│  ├─ repro/            # 自研④ 版本可复现层：flow JSON 快照 + 哈希锁定 + artifact 归档
│  └─ shared/           # 日志/trace/错误/Redis 客户端/通用工具
├─ vendor/
│  └─ flowise/          # ★ 完整 fork（Flowise 3.1.3），直接改源码，暂不裁剪
├─ infra/
│  ├─ docker-compose.yml # PG + Redis + MinIO + Langfuse + new-api + forked Flowise + gateway + dispatch
│  └─ .env.example
└─ docs/
   ├─ architecture-v0.2.md
   └─ superpowers/specs/
      └─ 2026-07-08-mvp-execution-plan-design.md  ← 本文件
```

**包依赖方向**（强制，避免循环）：
```
contracts  ←  agent-adapters  ←  daemon
contracts  ←  dispatch
contracts  ←  db ← repro
shared     ←  (所有)
db         ←  gateway / dispatch / scheduler
vendor/flowise ← (直接改源码，不作为 npm 依赖，由 compose 起)
```

`contracts` 是零依赖包，最先建。`daemon` 依赖 `agent-adapters`，`agent-adapters` 依赖 `contracts`。`dispatch` 只依赖 `contracts`（不依赖 daemon——它们靠 HTTP/WS 协议解耦）。

## 0.3 Gate-1 — dispatch↔daemon 协议 spike（M2）

**问题**：v0.2 §6.7 画了 claim/start/messages/complete 协议，但只是示意。multica 的实际协议（已勘察，见附录 D）更丰富，包含 register/heartbeat/session/recover-orphans。要用 TS 忠实翻译并跑通 claude-code adapter，必须先验证三件事：

1. multica 的 HTTP 端点形状能否 1:1 翻译成 TS（`/api/daemon/runtimes/{id}/tasks/claim` 等）。
2. `Backend.Execute()` 的双通道（Messages 流 + Result）能否用 TS 的 `AsyncIterable` + `Promise` 表达，且 daemon 能把 spawned CLI 的 stream-json 解析成 `AgentEvent` 流。
3. claude-code adapter 能否 spawn `claude` CLI 拿到 stream-json（这是整个异构 agent 路径的地基）。

**Spike 范围**（限时 2 天）：
- 在 `packages/contracts` 写出 `Backend`/`ExecOptions`/`AgentSession`/`AgentEvent`/`AgentResult` 的 TS 定义（P1.1 全部任务）。
- 在 `packages/agent-adapters` 写 `claude.ts`，spawn `claude -p <prompt> --output-format stream-json --verbose`，解析出 `AgentEvent` 流（P1.6.T1）。
- 在 `apps/dispatch` 写最小 HTTP：`POST /invoke` → 入队 `dispatch_tasks`；`POST /tasks/claim` → 出队；`POST /tasks/:id/complete` → 落库（P1.5.T1–T3）。
- 在 `packages/daemon` 写最小循环：poll claim → `backend.execute()` → complete（P1.6.T2）。
- **端到端验收**：手动 `POST /invoke {agent: claude-code, prompt: "列出当前目录"}` → 收到 claude 输出的事件流 + 最终 result。

**通过判据**：
- ✅ 上述端到端跑通，事件流含 text/tool-use/tool-result，result 含 usage。
- ✅ multica 协议翻译无语义损失（register/heartbeat/claim/start/complete/usage 全覆盖）。
- ✅ claude CLI stream-json 解析稳定（至少 3 次跑通，无解析崩溃）。

**失败路径**：
- 若 claude CLI 的 stream-json 格式与预期不符 → adapter 需重写解析器，Gate-1 延期 2 天，但不改架构。
- 若 multica 协议翻译有语义损失（如 session resume 无法用 TS 表达）→ **升级为架构风险**，需在 dispatch 侧自研协议补齐，M2 工期翻倍。这是头号风险点。

**Gate-1 是 M2 的入口**：不通过不进 M3。但它不是阻塞 M0/M1 的——M0/M1 只用 Flowise 原生能力，不碰 daemon。

## 0.4 Gate-2 — Flowise fork 构建 + Flow State 定位（M0 并行）

**问题**：v0.2 文档反复声称"Agentflow V2 是天生后端化的状态机引擎"、"Flow State 默认进程内，需外置到 Redis"。但勘察发现：

- `FlowExecutionState` 定义在 `packages/agentflow/src/core/types/execution.ts:15`。
- 配套 `agentflowReducer.ts`（Redux 式 reducer）在 `infrastructure/store/`。
- `infrastructure/api/` 有 `getLoadMethod`/`ApiServices`——说明 agentflow 组件靠调外部 API 执行。
- **`packages/server/src` 里 grep `flowState`/`flow_state` 零命中**。

这意味着 Flow State 很可能是 **agentflow React 组件内的前端 reducer 状态**，而不是 server 进程内的执行状态。v0.2 "天生后端化" 的论断**可能不准确**。在动手"外置 Flow State 到 Redis"之前，必须先搞清楚：

1. forked Flowise 能否在 monorepo 里构建并跑起来（`pnpm install` + `turbo build` + `bin/run start`）。
2. 一次 Prediction API 调用（`POST /api/v1/prediction/{flowId}`）的执行状态到底存哪：前端 reducer 序列化后传 server？server 有独立执行引擎？还是 agentflow 包既能前端编辑又能后端执行（同构）？
3. "外置 Flow State 到 Redis" 这个改造点是否还成立——如果 state 本就在前端、server 无状态执行，那"外置"可能是个伪命题，真正要解决的是"执行状态的跨实例恢复"，而那可能是另一回事。

**Spike 范围**（限时 3 天，与 M0 基础设施搭建并行）：
- 把 `~/Projects/Flowise` 纳入 `vendor/flowise/`，root `pnpm-workspace.yaml` 包含它。
- 跑通 `pnpm install` + `turbo build` + `start`，Flowise 画布可访问（P2.M0.T3）。
- **定位 Flow State**：读 `packages/agentflow/src/core/types/execution.ts` + `agentflowReducer.ts` + server 的 `predictions` controller，画出"一次 run 的状态流"时序图（P2.M0.T5）。
- 给出结论备忘录：Flow State 的真实位置 + "外置到 Redis" 是否仍需 + 若需，改造点在哪几个文件。

**通过判据**：
- ✅ forked Flowise 在 monorepo 里能构建、能起、画布能访问。
- ✅ Flow State 的真实位置已定位到具体文件，"一次 run 的状态流"时序图已画出。
- ✅ "是否需要 Redis 外置" 有明确结论（是/否/需要但形态不同），并能指到具体改造点。

**失败路径**：
- 若 fork 构建失败（依赖锁版本、turbo 版本不兼容等）→ 这是环境问题，单独攻破，不触发架构变更。
- 若 Flow State 定位后发现"外置到 Redis"不可行或无意义 → **触发 D1 重新评估**：可能需要 (a) 接受 Flowise 现状、放弃跨实例恢复（MVP 单实例够用），或 (b) 自研执行引擎（回到 2c 路线，代价大）。这是二号风险点。

**Gate-2 是 M3（批量执行 + Flow State 外置）的入口**：不通过不进 M3 的 Flow State 改造部分。M3 的批量 fan-out 部分不依赖 Gate-2，可独立推进。

## 0.5 关键发现与 v0.2 文档差异声明

勘察后发现的、与 v0.2 文档论断不一致的事实，必须在此显式声明，避免 plan 基于错误前提：

| v0.2 论断 | 勘察发现 | 对 plan 的影响 |
|---|---|---|
| "Agentflow V2 是天生后端化的状态机引擎"（§3.2/§6.4/§9.5） | **半对（Gate-2 已验）**：服务端执行引擎（`packages/server/buildAgentflow.ts`）确实是后端状态机——节点依赖解析/执行队列/Flow State 共享/HITL 检查点全在 Node 端；但 `@flowiseai/agentflow` **包**是 React 画布组件包，不是引擎，别把二者混为一谈。 | 后端化成立，§6.4"省掉协作后端化改造"成立；M3.3 不改 `agentflowReducer`。详见 `docs/gate-2-flow-state.md` §5.2。 |
| "Flow State 默认进程内，需外置到 Redis"（§5.5/§9.5） | **伪命题（Gate-2 已验，结论「需要但形态不同」）**：请求级 runtime 非进程全局；跨轮次 state 载体是 PG `execution` 表（`startPersistState=true`）；多实例水平扩展走 `MODE=QUEUE`（BullMQ + Redis pub/sub），Redis 用作队列/事件桥而非 state 存储。 | M3.3 重定义为「配置 + 集成验证 + `Start.ts` 默认值小改」，不把 state 搬 Redis。详见 `docs/gate-2-flow-state.md` §5.2。 |
| `@flowiseai/agentflow` 是 V2 执行引擎 | 它是 **React 组件包**（peerDeps react/reactflow/mui），画布+编辑器+reducer。执行靠调 API。 | D1 锁定 fork 全量，不引这个包当独立引擎。 |
| multica 协议 = claim/start/messages/complete（§6.7） | 实际还有 register/deregister/heartbeat/session/recover-orphans/gc-check/usage。 | Gate-1 翻译范围扩大（D13），但取核心、弃专有。 |
| multica Backend 支持 4 类 agent（§2.3 表） | 实际 11 类（claude/codex/copilot/opencode/openclaw/hermes/gemini/pi/cursor/kimi/kiro）。 | adapter 可扩展性更强，MVP 仍只做 claude-code。 |
| ExecOptions 字段（§4.1） | 漏了 `ExtraArgs`/`CustomArgs` 双层、`SemanticInactivityTimeout`、`MessageLog` 事件、`Config{ExecutablePath,Env,Logger}`。 | P1.1 contracts 补全这些字段。 |
| Flowise 有 `docker-compose.yml` | **没有**。Flowise 只 Dockerfile，无顶层 compose。 | M0 我们自己写 `infra/docker-compose.yml` 编排全栈。 |

**这些差异不推翻 v0.2 的整体架构**（单引擎 + 4 薄层 + daemon 两段式仍然成立），但修正了几处细节论断。Plan 以本差异声明为准。

---

# Part 1 — 执行轨道（按薄层）

每层给出：**职责边界** / **接口契约** / **任务序列**。任务 ID 为 `P1.<层>.T<n>`，Part 2 引用。

## 1.1 `packages/contracts` — 共享类型（最先建，零依赖）

**职责**：定义所有跨层共享的 TS 类型。daemon、dispatch、db、repro 都依赖它。不依赖任何其他包。Gate-1 的产出物。

**接口契约**（基于 multica `pkg/agent/agent.go` 翻译 + 补全 §0.5 漏字段）：

```ts
// packages/contracts/src/agent.ts
export interface AgentBackend {
  execute(prompt: string, opts: ExecOptions): AgentSession
}

export interface BackendConfig {
  executablePath: string            // CLI 路径，如 'claude'
  env?: Record<string, string>      // 额外环境变量
  logger?: Logger                   // 结构化日志（来自 shared）
}

export type BackendFactory = (agentType: AgentType, cfg: BackendConfig) => AgentBackend
export type AgentType =
  | 'claude' | 'codex' | 'copilot' | 'opencode' | 'openclaw'
  | 'hermes' | 'gemini' | 'pi' | 'cursor' | 'kimi' | 'kiro'

export interface ExecOptions {
  cwd?: string
  model?: string
  systemPrompt?: string
  maxTurns?: number
  timeoutMs?: number               // 总超时（daemon 强制）
  inactivityTimeoutMs?: number     // 静默超时（参照 multica SemanticInactivityTimeout）
  resumeSessionId?: string         // 续接上次会话
  extraArgs?: string[]             // daemon 级默认 CLI 参数（在 customArgs 前）
  customArgs?: string[]            // per-agent CLI 参数（在 extraArgs 后）
  mcpConfig?: unknown              // MCP server 配置（--mcp-config）
  thinkingLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface AgentSession {
  events: AsyncIterable<AgentEvent>  // 流式事件
  result: Promise<AgentResult>       // 最终结果
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-use'; tool: string; callId: string; input: unknown }
  | { type: 'tool-result'; tool: string; callId: string; output: string }
  | { type: 'status'; status: string; sessionId?: string }
  | { type: 'log'; content: string }          // ★ 补：multica MessageLog
  | { type: 'error'; content: string }

export interface AgentResult {
  status: 'completed' | 'failed' | 'aborted' | 'timeout' | 'cancelled'
  output: string
  error?: string
  durationMs: number
  sessionId?: string               // 供下次 resume
  usage: Record<string, TokenUsage>  // 按 model 聚合
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}
```

```ts
// packages/contracts/src/protocol.ts — dispatch↔daemon 协议 DTO（翻译自 multica）
export interface RegisterRequest {
  daemonLabel: string
  capabilities: DaemonCapability[]   // 提供哪些 agentType + 标签
  endpoint?: string                  // WS 地址（可选，MVP 用 HTTP pull）
}
export interface RegisterResponse { daemonId: string; token: string }

export interface HeartbeatPayload { daemonId: string; status: DaemonStatus; activeTasks: number }
export type DaemonStatus = 'online' | 'offline' | 'draining'

export interface ClaimTaskResponse { task: DispatchTask | null }  // null = 无可领任务

export interface DispatchTask {
  id: string
  agentDaemonId: string
  runId: string
  prompt: string
  execOptions: ExecOptions
}

export interface TaskMessageBatch { messages: AgentEvent[] }       // 批量上报，减少 HTTP 次数
export interface TaskProgress { summary: string; step: number; total: number }
export interface TaskComplete {
  output: string; sessionId?: string; usage: Record<string, TokenUsage>; durationMs: number
}
export interface TaskFail { error: string; failureReason: string; sessionId?: string }
```

**任务序列**：

| ID | 任务 | 验收 | 估时（乐观/悲观 天） |
|---|---|---|---|
| P1.1.T1 | 建 `packages/contracts`，初始化 tsconfig + tsup 构建 | 包能 build，导出空类型 | 0.25 / 0.5 |
| P1.1.T2 | 写 `agent.ts`（上述全部接口） | tsc 通过 | 0.5 / 1 |
| P1.1.T3 | 写 `protocol.ts`（上述全部 DTO） | tsc 通过 | 0.5 / 1 |
| P1.1.T4 | 写 `index.ts` 桶导出 + Vitest 单测覆盖类型契约 | 单测过 | 0.5 / 1 |

**依赖**：无（最先建）。**产出供**：Gate-1、P1.5、P1.6、P1.2。

## 1.2 `packages/db` — TypeORM entities + 迁移（自研表）

**职责**：定义 v0.2 §5.3 的自研表（`daemons`/`agent_daemons`/`dispatch_tasks`/`pipeline_versions`/`runs`/`users`/`workspaces`/`rbac_*`）为 TypeORM entities，与 Flowise 表同库同 `DataSource`。

**接口契约**（entities 略，按 §5.3 SQL 1:1 落 TypeORM 装饰器；关键决策是字段类型映射，如 `JSONB` → `json` 列 + `@Column({ type: 'jsonb' })`）：

```ts
// packages/db/src/entities/run.entity.ts（示例，其余同理）
@Entity({ name: 'runs' })
export class Run {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column() identifier: string
  @Column() pipelineId: string
  @Column({ name: 'pipeline_version_hash' }) pipelineVersionHash: string
  @Column() status: RunStatus
  @Column({ name: 'created_by_user_id', nullable: true }) createdByUserId?: string
  @Column({ name: 'created_by_run_id', nullable: true }) createdByRunId?: string
  @Column({ name: 'parent_run_id', nullable: true }) parentRunId?: string
  @Column({ type: 'jsonb' }) input: unknown
  @Column({ type: 'jsonb', nullable: true }) output?: unknown
  @Column({ name: 'artifact_uri', nullable: true }) artifactUri?: string
  @Column({ name: 'agent_daemon_calls', type: 'jsonb', default: [] }) agentDaemonCalls: AgentDaemonCall[]
  @Column({ type: 'numeric', default: 0 }) cost: number
  @Column({ name: 'trace_id', nullable: true }) traceId?: string
  @Column({ name: 'workspace_id' }) workspaceId: string
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true }) startedAt?: Date
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt?: Date
  @Column({ name: 'duration_ms', nullable: true }) durationMs?: number
}
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.2.T1 | 建 `packages/db`，配 TypeORM + 复用 vendor 的 `typeormDataSource`（或新建共享 DataSource） | 能连 PG | 0.5 / 1 |
| P1.2.T2 | 写 `daemons`/`agent_daemons` entities + 迁移 | `migration:run` 成功 | 0.5 / 1 |
| P1.2.T3 | 写 `dispatch_tasks` entity + 迁移 + 索引 | 同上 | 0.5 / 1 |
| P1.2.T4 | 写 `runs` entity + 迁移 + 索引（含 `parent_run_id` 任务树） | 同上 | 0.5 / 1 |
| P1.2.T5 | 写 `pipeline_versions` entity + 迁移（`version_hash` UNIQUE） | 同上 | 0.5 / 1 |
| P1.2.T6 | 写 `users`/`workspaces`/`rbac_roles`/`rbac_permissions` entities + 迁移（最小权限模型） | 同上 | 1 / 1.5 |
| P1.2.T7 | 写 `token_meta` entity + 迁移（new-api 令牌本地元数据，不存 key 原文） | 同上 | 0.5 / 1 |
| P1.2.T8 | 写 `workspace_members`/`workspace_flows` entities + 迁移（D19 项目关联） | 同上 | 0.5 / 1 |
| P1.2.T9 | 写 `lab_sessions`/`lab_messages` entities + 迁移（D19 聊天室，线程化 parent_id） | 同上 | 1 / 1.5 |
| P1.2.T10 | 写 `notifications` entity + 迁移（设置页通知 tab） | 同上 | 0.5 / 1 |
| P1.2.T11 | 写 repository 层（Repository 模式，每个 entity 一个 repo，封装标准操作） | 单测覆盖 80% | 1.5 / 2.5 |

**依赖**：P1.3（shared 的 Logger）。**产出供**：P1.4/P1.5/P1.7/P1.8。

## 1.3 `packages/shared` — 公共工具

**职责**：结构化日志（pino）、Trace 上下文（OTel context）、错误类型、Redis 客户端封装、通用工具。

**接口契约**：

```ts
export interface Logger { /* pino-like */ debug/info/warn/error(msg, ctx?): void }
export interface TraceContext { runId: string; traceId: string; parentRunId?: string }
export class AppError extends Error { constructor(public code: string, message: string, public ctx?: Record<string, unknown>) {} }
export interface RedisClient { /* ioredis-like 封装，带 key 前缀 */ }
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.3.T1 | 建 `packages/shared`，配 pino + ioredis + OTel api | 包能 build | 0.5 / 1 |
| P1.3.T2 | 写 Logger（pino 封装，强制带 runId 字段） + TraceContext helper | 单测过 | 0.5 / 1 |
| P1.3.T3 | 写 RedisClient（ioredis 封装，key 前缀 `dagents:`） + AppError | 单测过 | 0.5 / 1 |

**依赖**：无。**产出供**：所有层。

## 1.4 `apps/gateway` — 自研① 网关观测层（Hono）

**职责**：统一入口。SSO（OIDC/betterAuth）、请求路由（→ Flowise / → dispatch / → scheduler API）、限流、**new-api 令牌代理与治理**（D18）、审计、**为每个请求生成 `run_id` 并注入 OTel context 透传全链路**。

**接口契约**：

```ts
// 网关对所有进站请求：
// 1. 鉴权（SSO token → user）
// 2. 生成 run_id（若未带），注入 header `x-run-id` + OTel context
// 3. 限流（按 user/workspace）
// 4. 路由：/api/v1/flows/* → Flowise; /api/v1/agents/invoke → dispatch; /api/v1/runs/* → scheduler;
//         /api/v1/tokens/* → new-api 代理；/api/v1/llm/* → new-api 透传（LLM 调用统一上游）
// 5. 审计日志（敏感操作）
// new-api 代理：网关持有 new-api 管理密钥，token CRUD 转发 new-api API；
//              本地 token_meta 表只存 remark/group/visibility 等元数据，不存 key 原文
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.4.T1 | 建 `apps/gateway`（Hono）+ 健康检查 + 路由骨架 | 能起，路由到 Flowise | 0.5 / 1 |
| P1.4.T2 | SSO 中间件（OIDC，MVP 可先 betterAuth dev 模式） | 登录拿到 user | 1 / 2 |
| P1.4.T3 | run_id 注入中间件 + OTel context 透传 | header 与 trace 都带 runId | 0.5 / 1 |
| P1.4.T4 | 限流中间件（Redis 计数，按 user） | 超限返回 429 | 0.5 / 1 |
| P1.4.T5 | **new-api 令牌代理**：`/api/v1/tokens/*` 转发 new-api API + 本地 `token_meta` 表（remark/group/visibility） | 前端能 CRUD 令牌，key 不落本地 | 1.5 / 2.5 |
| P1.4.T6 | 审计日志（key 操作/权限/删除/版本锁定/令牌轮换） | 落库 | 0.5 / 1 |
| P1.4.T7 | 路由表落地（Flowise/dispatch/scheduler/new-api 分流） + 集成测试 | 全链路 e2e | 1 / 1.5 |
| P1.4.T8 | new-api 健康探测（轮询 new-api token 状态 → 标记限流/失效/过期） | 不健康令牌可见 | 1 / 1.5 |
| P1.4.T9 | 令牌轮换（调 new-api 标记待轮换 + 生成新 key + 吊销旧 key） | 轮换可用 | 1 / 1.5 |
| P1.4.T10 | LLM 调用统一上游（Flowise/daemon 的 LLM 请求经网关 → new-api） | LLM 调用走 new-api | 0.5 / 1 |

**依赖**：P1.2、P1.3。

## 1.5 `apps/dispatch` — 自研② 中央 dispatch server（Hono + WS）

**职责**：维护任务队列（`dispatch_tasks` 表 + Redis 快速队列）、daemon 注册表（`daemons`/`agent_daemons`）、衔接 Flowise HTTP 节点（`POST /invoke`）、收集 daemon 事件流回传 Flowise（SSE/轮询）、daemon 路由（按 capability）、并发闸、超时熔断。

**接口契约**（HTTP，翻译自 multica `/api/daemon/*`，路径调整为 `/api/v1/dispatch/*`）：

```
# Flowise 侧调用
POST   /api/v1/dispatch/invoke                { agentDaemonId, prompt, execOptions, runId }
       → { taskId }  或挂起等结果后直接回 AgentResult（MVP 用挂起+SSE）

# Daemon 侧调用（pull-based）
POST   /api/v1/dispatch/daemons/register      { label, capabilities }
       → { daemonId, token }
POST   /api/v1/dispatch/daemons/heartbeat     { daemonId, status, activeTasks }
POST   /api/v1/dispatch/daemons/:id/tasks/claim  → { task | null }
POST   /api/v1/dispatch/tasks/:id/start
POST   /api/v1/dispatch/tasks/:id/progress    { summary, step, total }
POST   /api/v1/dispatch/tasks/:id/messages    { messages: AgentEvent[] }
POST   /api/v1/dispatch/tasks/:id/complete    { output, sessionId, usage, durationMs }
POST   /api/v1/dispatch/tasks/:id/fail        { error, failureReason }
POST   /api/v1/dispatch/tasks/:id/usage       { usage }  # 可选，合并进 complete
DELETE /api/v1/dispatch/daemons/:id           (deregister)

# 查询（Flowise/前端用）
GET    /api/v1/dispatch/tasks/:id             # 查状态/结果
GET    /api/v1/dispatch/tasks/:id/events      # SSE 事件流
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.5.T1 | 建 `apps/dispatch`（Hono）+ 健康检查 + DB 连接 | 能起 | 0.5 / 1 |
| P1.5.T2 | `POST /invoke`：入队 `dispatch_tasks` + 返回 taskId（或挂起） | 任务落库 | 0.5 / 1 |
| P1.5.T3 | `POST /daemons/register` + `/heartbeat` + deregister | daemon 能注册 | 0.5 / 1 |
| P1.5.T4 | `POST /daemons/:id/tasks/claim`：FIFO 出队 + claimed_by 落库 | 能领任务 | 0.5 / 1 |
| P1.5.T5 | `POST /tasks/:id/start|progress|messages|complete|fail` 全套 | 事件落库 + 回传 | 1.5 / 2.5 |
| P1.5.T6 | `GET /tasks/:id/events`（SSE）：聚合 daemon 上报事件流给 Flowise | SSE 推送 | 1 / 1.5 |
| P1.5.T7 | daemon 路由（按 capability/标签匹配 agentDaemonId） + 并发闸（每 daemon max） | 正确路由 | 1 / 1.5 |
| P1.5.T8 | 超时熔断（task 级 + daemon 心跳离线检测 + 重新派发） | 离线 daemon 任务回收 | 1.5 / 2 |
| P1.5.T9 | 集成测试（mock daemon 跑全协议） | e2e 过 | 1 / 1.5 |

**依赖**：P1.1、P1.2、P1.3。**Gate-1 产出**。

## 1.6 `packages/daemon` + `packages/agent-adapters` — 自研② 本地 Agent Daemon

**职责**：常驻进程，主动 claim 任务 → spawn CLI → 流式回传 → complete/fail。每个 agent 一个 adapter 文件，收敛 CLI 差异。参照 multica `internal/daemon` + `pkg/agent`。

**adapter 接口契约**（实现 `contracts.AgentBackend`）：

```ts
// packages/agent-adapters/src/claude.ts
export const claudeBackend: BackendFactory = (type, cfg) => ({
  execute(prompt, opts) {
    // 1. 构造 argv: ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', ...extraArgs, ...customArgs]
    //    若 opts.resumeSessionId: 加 '--resume', sessionId
    //    若 opts.mcpConfig: 加 '--mcp-config', <path>
    //    若 opts.thinkingLevel: 加 '--thinking-level', level
    // 2. spawn child_process（cwd=opts.cwd, env={...process.env, ...cfg.env}）
    // 3. 解析 stdout stream-json 行 → AgentEvent
    // 4. 双层 watchdog: timeoutMs（总）+ inactivityTimeoutMs（静默）
    // 5. 返回 { events: AsyncIterable, result: Promise }
  }
})
```

**daemon 主循环契约**：

```ts
// packages/daemon/src/main.ts
while (running) {
  const { task } = await client.claimTask(daemonId)
  if (!task) { await sleep(pollInterval); continue }
  await client.startTask(task.id)
  const backend = factory(task.agentType, cfg)
  const session = backend.execute(task.prompt, task.execOptions)
  for await (const ev of session.events) {
    await client.reportMessages(task.id, [ev])   // 批量可优化
  }
  const result = await session.result
  if (result.status === 'completed') await client.completeTask(task.id, result)
  else await client.failTask(task.id, result.error, result.status)
}
// 并发：MVP 单并发；架构允许 maxConcurrency 个 session 并行（P1.6.T6）
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.6.T1 | `agent-adapters/claude.ts`：spawn + stream-json 解析 → AgentEvent | 手动 execute 能拿事件流（**Gate-1 核心**） | 1.5 / 3 |
| P1.6.T2 | `daemon/main.ts`：注册 + 心跳 + claim 循环 + start/complete | 端到端跑通（**Gate-1 核心**） | 1.5 / 2.5 |
| P1.6.T3 | 双层 watchdog（总超时 + 静默超时） + session resume（`--resume`） | 超时能杀，resume 能续 | 1 / 2 |
| P1.6.T4 | MCP 注入（`--mcp-config`） + thinkingLevel 透传 | 带参能跑 | 0.5 / 1 |
| P1.6.T5 | usage 上报（解析 stream-json 的 usage 块 → TokenUsage） | usage 落库 | 0.5 / 1 |
| P1.6.T6 | 并发治理（maxConcurrency + 本地队列） | 多任务并行 | 1 / 2 |
| P1.6.T7 | daemon CLI（`mil-daemon register <server> --label <l> --agent <type>`） + 配置文件 | 可命令行启动 | 0.5 / 1 |
| P1.6.T8 | `agent-adapters/codex.ts`（第二批，参照 multica codex.go） | codex 能跑 | 1 / 2 |

**依赖**：P1.1（contracts）。**Gate-1 核心 = T1+T2**。

## 1.7 `apps/scheduler` — 自研③ 调度 worker

**职责**：消费 Redis 队列，并发闸、批量 fan-out（补 Flowise Iteration 串行）、成本熔断、长任务（operationId 轮询/webhook）、断点续跑。

**接口契约**：

```ts
// apps/scheduler/src/index.ts
// 消费 Redis 队列 'dagents:tasks'，每条消息 = { runId, pipelineId, input, parentRunId? }
// 执行: 调 Flowise POST /api/v1/predrediction/{flowId}（经 gateway）
// 并发闸: maxConcurrent（如 10）
// fan-out: 收到批量输入 → 拆 N 个子 run（parent_run_id）→ 并发调 Prediction API
// 成本熔断: 累计 cost > budget → 暂停入队
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.7.T1 | 建 `apps/scheduler`（Node worker）+ Redis 队列消费 | 能消费一条 | 0.5 / 1 |
| P1.7.T2 | 单 run 执行：创建 run（runs 表）→ 调 Flowise Prediction API → 落 output | 单篇跑通 | 1 / 1.5 |
| P1.7.T3 | 并发闸（maxConcurrent，Redis 信号量） | 超限排队 | 0.5 / 1 |
| P1.7.T4 | 批量 fan-out：parent_run + N 子 run（parent_run_id）+ 并发调 Prediction | 批量跑通 | 1.5 / 2.5 |
| P1.7.T5 | 失败重跑（同一 pipeline_version_hash 重跑指定子 run） | 可单独重跑 | 0.5 / 1 |
| P1.7.T6 | 成本熔断（预算阈值 → 暂停 + 告警） | 超预算停 | 0.5 / 1 |
| P1.7.T7 | 长任务 operationId 模式（立即返回 + 轮询/webhook） | 长任务可异步 | 1 / 1.5 |
| P1.7.T8 | 断点续跑（重启后从 runs 表 status=running 的恢复） | 重启续跑 | 1 / 2 |

**依赖**：P1.2、P1.3、P1.4（经 gateway 调 Flowise）。

## 1.8 `packages/repro` — 自研④ 版本可复现层

**职责**：flow JSON 快照、SHA-256 哈希锁定、run 绑定版本、artifact 归档到对象存储。

**接口契约**：

```ts
export interface PipelineVersion { id: string; pipelineId: string; versionHash: string; flowJson: unknown; note?: string }
export async function snapshotPipeline(flowId: string): Promise<PipelineVersion>
// 1. GET Flowise flow JSON（经 gateway）
// 2. 计算 SHA-256
// 3. 若 hash 已存在（pipeline_versions.version_hash UNIQUE）→ 复用
// 4. 否则插入
export async function bindRunToVersion(runId: string, versionHash: string): Promise<void>
export async function archiveArtifact(runId: string, artifact: RunArtifact): Promise<string /* uri */>
// 归档到 MinIO，返回 uri，写入 runs.artifact_uri
```

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.8.T1 | 建 `packages/repro` + Flowise flow JSON 获取（经 gateway） | 能拿到 JSON | 0.5 / 1 |
| P1.8.T2 | SHA-256 哈希 + `pipeline_versions` 去重写入 | 同 flow 二次快照复用 | 0.5 / 1 |
| P1.8.T3 | run 绑定 version（`runs.pipeline_version_hash`） | 绑定成功 | 0.25 / 0.5 |
| P1.8.T4 | artifact 归档（MinIO S3 客户端 + uri 回写） | 文件可存可取 | 1 / 1.5 |
| P1.8.T5 | 复现：同 hash + 同 input 重跑 + 结果比对（非字节级，结构比对） | 可重跑可比对 | 1 / 1.5 |

**依赖**：P1.2、P1.3、P1.4。

## 1.9 `vendor/flowise` 改造点（直接改 fork 源码）

**职责**：在 forked Flowise 里做 v0.2 点名的两处改造。**Gate-2 先定位，再改**。

**改造点 1：Flow State 外置 Redis**（Gate-2 定位后落具体文件）
- 预期位置：`packages/agentflow/src/core/types/execution.ts` + `infrastructure/store/agentflowReducer.ts`，以及 server 的 `predictions` controller。
- 改造目标：执行态外置到 Redis，使多实例 Flowise 可共享运行态。
- **若 Gate-2 发现 state 本就在前端、server 无状态**：改造点变为"执行状态跨实例恢复"，方案另定（可能是 run checkpoint 入 Redis）。

**改造点 2：HTTP→dispatch 自定义节点**
- Flowise 画布需要一个节点把异构 agent 调用桥接到中央 dispatch。
- 方案：在 forked Flowise 的节点目录加一个自定义节点，配置项 `{ agentDaemonId, promptTemplate }`，执行时 `POST /api/v1/dispatch/invoke`。
- 位置：`packages/server/src/.../nodes/` 或 `packages/components/`（具体看 Flowise 节点注册机制，Gate-2 后定）。

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.9.T1 | Gate-2 定位 Flow State 真实位置 + 出时序图（= P2.M0.T5） | 时序图出炉 | 0.5 / 1 |
| P1.9.T2 | Flow State → Redis 改造（按 Gate-2 结论） | 多实例共享 state | 1.5 / 4（视 Gate-2） |
| P1.9.T3 | HTTP→dispatch 自定义节点（forked Flowise 内） | 画布能拖出该节点并调通 dispatch | 1.5 / 3 |
| P1.9.T4 | Flowise 升级 merge 流程文档（`git fetch upstream && merge`） | 有文档可循 | 0.5 / 1 |
| P1.9.T5 | flow 监控数据接口（读 runs + flow JSON → 节点状态着色所需数据，供 console AgentFlows 浏览页） | 接口返回节点级 run 状态 | 1 / 1.5 |

**依赖**：P1.5（dispatch 可调）、Gate-2。**风险最高的一层**。

## 1.10 `apps/console` — 自研控制台（Next.js，M5 才动）

**职责**：完整控制台（D17），6 个页：资源看板 / Agents / AgentFlows / Lab / Workspace / 设置。对话 + 会话 + agent 切换 + 触发 run + agents 管理 + flows 浏览 + 项目对话 + 多 agent 聊天室 + 设置 6 tab。**画布编辑仍用 Flowise 原生 UI**，console 只做浏览/监控/管理。

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.10.T1 | 建 `apps/console`（Next.js app router）+ 路由骨架 + 侧栏（6 页导航） | 能起，6 页空壳 | 1 / 1.5 |
| P1.10.T2 | 对话视图 + 会话列表 + SSE 流式渲染 | 能对话 | 1.5 / 2 |
| P1.10.T3 | agent 切换（提示词 agent / 异构 agent） + 触发 run（手动/批量） | 可切换可触发 | 1 / 1.5 |
| P1.10.T4 | **Agents 管理页**：列表/看板/详情 + 过滤（类型/状态/角色/区域） + 能力描述符 + 当前 run + 资源占用 + 日志流 | 可浏览可过滤 | 2 / 3 |
| P1.10.T5 | **AgentFlows 浏览页**：flow 列表 + DAG 只读渲染 + 节点状态着色 + 节点级 run 耗时/预算/token/成本/日志（读 P1.9.T5 接口） | 可浏览 flow 运行态 | 2 / 3 |
| P1.10.T6 | **Workspace 项目对话页**：项目列表 + 成员 + 关联 flow + 产物 + 配额 + 对话线程 + 附件 | 可按项目对话 | 2 / 3 |
| P1.10.T7 | **Lab 多 agent 聊天室**：实验会话列表 + 线程化消息 + @提及 + thinking 展示 + tool 调用块 + 人工介入 | 可多 agent 协作 | 2.5 / 4 |
| P1.10.T8 | **设置页**：6 tab（API Key/默认模型/预算配额/通知/账户团队/危险区），API Key tab 接 new-api 代理 | 6 tab 可用 | 2 / 3 |
| P1.10.T9 | **资源看板页**：fleet 密度 + 状态分布 + 24h 吞吐 + 区域 + 成本（MVP 级数据，读 P1.11.T6 接口） | 看板可看 | 1.5 / 2.5 |
| P1.10.T10 | 接入 SSO（经 gateway）+ 全页统一 run_id 透传 | 登录可用 | 0.5 / 1 |

**依赖**：P1.4（gateway）、P1.9.T5（flows 浏览）、P1.11.T6（资源看板）。**M5 才启动**，不阻塞 M0–M4。建议 M5 拆 M5a（对话+agents+flows+设置）+ M5b（workspace+lab+dashboard）。

## 1.11 可观测性接线（Langfuse + OTel）

**职责**：全链路 trace 串 `run_id`。Langfuse 自动捕获 Flowise run 的 token/cost；OTel span 携带 resource.usage；daemon 上报 usage 落 `runs.agent_daemon_calls`。

**任务序列**：

| ID | 任务 | 验收 | 估时 |
|---|---|---|---|
| P1.11.T1 | Langfuse 接入 Flowise（原生集成，配 env） | Flowise run 上报 Langfuse | 0.5 / 1 |
| P1.11.T2 | OTel SDK 接入 gateway/dispatch/daemon/scheduler，trace 串 run_id | 同 traceId 全链路 | 1 / 1.5 |
| P1.11.T3 | daemon usage → dispatch → runs.agent_daemon_calls 落库 | usage 可查 | 0.5 / 1 |
| P1.11.T4 | 资源面板 MVP（用量/成本/daemon 状态，读 runs + Langfuse） | 面板可看 | 1.5 / 2.5 |
| P1.11.T5 | 节点级 trace（Flowise run 的节点 span 落库 + 前端展示，供 AgentFlows 浏览页） | 节点级状态可查 | 1 / 1.5 |
| P1.11.T6 | 资源看板数据聚合 API（fleet 状态分布/吞吐/区域/成本，读 runs + Langfuse + new-api） | 看板数据可取 | 1 / 1.5 |

---

# Part 2 — 里程碑时序（M0–M6）

每个里程碑：**目标** / **WBS（引用 P1 任务 ID）** / **依赖** / **验收** / **风险** / **工时**。工时为单人乐观/悲观区间（天）。

## M0 — 基础设施 + Gate-2（关键路径起点）

**目标**：docker-compose 起全栈；forked Flowise 能构建能跑；Gate-2 定位 Flow State。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M0.1 | 建 monorepo 骨架（pnpm-workspace、tsconfig base、turbo） | — | 0.5 / 1 |
| M0.2 | 建 `infra/docker-compose.yml`：PG + Redis + MinIO + Langfuse + **new-api**（D18） | — | 0.5 / 1 |
| M0.3 | 纳入 `vendor/flowise`，跑通 install+build+start（**Gate-2 一部分**） | P1.9.T1 前置 | 1 / 3 |
| M0.4 | fork remote 改造（建 GitHub fork，改 origin/upstream） | D3 | 0.25 / 0.5 |
| M0.5 | 核对 `~/Projects/Flowise` 本地 `package.json` 已改动那行（git status 显示 M），决定保留还是丢弃后再纳入 vendor | 输出"保留/丢弃"决定，记录在 M0 备忘 | 0.25 / 0.5 |
| M0.6 | 建 `packages/contracts`（**P1.1 全部**） | P1.1.T1–T4 | 1.5 / 3 |
| M0.7 | 建 `packages/shared`（**P1.3 全部**） | P1.3.T1–T3 | 1.5 / 3 |
| M0.8 | 建 `packages/db` 骨架 + DataSource 连 PG | P1.2.T1 | 0.5 / 1 |
| M0.9 | **Gate-2：定位 Flow State + 出时序图** | P1.9.T1 / P2.M0.T5 | 1 / 2 |
| M0.10 | compose 把 gateway/dispatch/scheduler 空壳起起来（健康检查互通） | P1.4.T1/P1.5.T1/P1.7.T1 | 1 / 1.5 |
| M0.11 | new-api 接入验证（起容器、配渠道、签发首个 sk-newapi token、Flowise 指向 new-api） | D18 | 0.5 / 1 |

**依赖**：无（起点）。
**验收**：`docker compose up` 全绿（含 new-api）；Flowise 画布可访问且 LLM 调用走 new-api；contracts/shared/db 包可 build；Gate-2 时序图出炉。
**风险**：M0.3 fork 构建失败（依赖锁版本/turbo 不兼容）→ 单独攻破。M0.9 Gate-2 结论可能推翻 §9.5 → 见 §0.4 失败路径。M0.11 new-api 渠道配置错 → LLM 调不通，按 new-api 文档排查。
**工时**：8.5 / 17 天。**关键路径**：M0.1→M0.3→M0.9（Gate-2）严格串行；M0.6/M0.7/M0.8 可与 M0.3 并行；M0.11 可与 M0.10 并行。

## M1 — 单 Agent 验证（Flowise 原生）

**目标**：Flowise 建 1 个 Agent 节点，跑通对话 + 工具。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M1.1 | 在 forked Flowise 配一个 LLM model 节点（接 API key） | — | 0.5 / 1 |
| M1.2 | 建 1 个 Agent 节点（带工具） | — | 0.5 / 1 |
| M1.3 | 用 Flowise 自带 chat 跑通对话 | — | 0.25 / 0.5 |
| M1.4 | 经 gateway 路由到 Flowise 对话（验证网关） | P1.4.T7 | 0.5 / 1 |
| M1.5 | Langfuse 接入（**P1.11.T1**） | P1.11.T1 | 0.5 / 1 |

**依赖**：M0。
**验收**：经 gateway 能对话；Langfuse 见 trace。
**风险**：低。
**工时**：2 / 4 天。

## M2 — 第一个 Agent Daemon + Gate-1（头号 spike）

**目标**：中央 dispatch + claude-code daemon 跑通；画布内 HTTP 节点能调 Claude Code。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M2.1 | `agent-adapters/claude.ts`（**Gate-1 核心**） | P1.6.T1 | 1.5 / 3 |
| M2.2 | `apps/dispatch` 最小协议（**P1.5.T1–T5**） | P1.5 | 3.5 / 6.5 |
| M2.3 | `packages/daemon` 主循环（**Gate-1 核心**） | P1.6.T2 | 1.5 / 2.5 |
| M2.4 | **Gate-1 端到端验证**：`POST /invoke` → claude → 事件流 + result | — | 0.5 / 1 |
| M2.5 | 双层 watchdog + session resume（**P1.6.T3**） | P1.6.T3 | 1 / 2 |
| M2.6 | MCP 注入 + thinkingLevel（**P1.6.T4**） | P1.6.T4 | 0.5 / 1 |
| M2.7 | usage 上报（**P1.6.T5**） | P1.6.T5 | 0.5 / 1 |
| M2.8 | new-api 令牌代理 + 健康探测 + LLM 统一上游（**P1.4.T5/T8/T10**） | P1.4 | 2.5 / 4 |
| M2.9 | HTTP→dispatch 自定义节点（**P1.9.T3**） | P1.9.T3 | 1.5 / 3 |
| M2.10 | 画布端到端：HTTP 节点 → dispatch → claude daemon → 结果回画布 | — | 0.5 / 1 |

**依赖**：M0（contracts/shared/db）、M1（Flowise 可用）。
**验收**：画布内能调 Claude Code 拿到结果；Gate-1 通过。
**风险**：**头号风险**——Gate-1 失败（见 §0.3 失败路径）。M2.1 claude stream-json 解析是最大未知。
**工时**：12 / 23 天。**关键路径**：M2.1→M2.4（Gate-1）→M2.9→M2.10 严格串行；M2.5/M2.6/M2.7/M2.8 可与 M2.9 并行。

## M3 — 批量执行 + Flow State 改造（依赖 Gate-2）

**目标**：调度层并发 fan-out 跑通 N 输入；Flow State 外置 Redis。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M3.1 | `apps/scheduler` 单 run 执行 + 并发闸（**P1.7.T1–T3**） | P1.7 | 2 / 3.5 |
| M3.2 | 批量 fan-out（**P1.7.T4**） | P1.7.T4 | 1.5 / 2.5 |
| M3.3 | Flow State → Redis 改造（**P1.9.T2**，**依赖 Gate-2 结论**） | P1.9.T2 | 1.5 / 4 |
| M3.4 | 失败重跑（**P1.7.T5**） | P1.7.T5 | 0.5 / 1 |
| M3.5 | 断点续跑（**P1.7.T8**） | P1.7.T8 | 1 / 2 |
| M3.6 | 批量端到端：N 篇输入 → fan-out → 重启可续 | — | 0.5 / 1 |

**依赖**：M2、Gate-2 通过。
**验收**：批量任务可跑可查，重启可续；Flow State 改造落地。
**风险**：M3.3 受 Gate-2 结论直接影响——若 Gate-2 发现 state 在前端，改造方案变，工时取悲观值。
**工时**：7 / 14 天。

## M4 — 版本可复现

**目标**：flow JSON 快照 + 哈希锁定 + run 绑定 + artifact 归档。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M4.1 | `packages/repro` 全部（**P1.8.T1–T5**） | P1.8 | 3.25 / 5.5 |
| M4.2 | scheduler 集成 repro（run 创建时绑定 version，完成时归档） | P1.7 + P1.8 | 0.5 / 1 |
| M4.3 | 复现端到端：同 hash + 同 input 重跑 + 比对 | — | 0.5 / 1 |

**依赖**：M3。
**验收**：同一 hash + 同一 input 可重跑并比对。
**风险**：低。
**工时**：4.25 / 7.5 天。

## M5 — 控制台前端（D17，拆 M5a/M5b）

**目标**：自研完整控制台（6 页）。拆两批交付，M5a 先交付核心，M5b 补重功能。

### M5a — 核心控制台（对话 + Agents + AgentFlows + 设置）

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M5a.1 | `apps/console` 骨架 + 侧栏 + 对话/会话/SSE（**P1.10.T1–T3**） | P1.10 | 3.5 / 5 |
| M5a.2 | Agents 管理页（**P1.10.T4**） | P1.10.T4 | 2 / 3 |
| M5a.3 | AgentFlows 浏览页（**P1.10.T5**，依赖 P1.9.T5） | P1.10.T5 | 2 / 3 |
| M5a.4 | 设置页 6 tab（**P1.10.T8**，API Key tab 接 new-api 代理） | P1.10.T8 | 2 / 3 |

**依赖**：M1（对话可用）、M2（异构 agent + new-api 代理）。
**验收**：能对话、管 agent、浏览 flow 运行态、管令牌。
**风险**：中——6 页工作量集中。M5a.3 依赖 P1.9.T5 接口先就绪。
**工时**：9.5 / 14 天。

### M5b — 协作与看板（Workspace + Lab + 资源看板）

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M5b.1 | Workspace 项目对话页（**P1.10.T6**） | P1.10.T6 | 2 / 3 |
| M5b.2 | Lab 多 agent 聊天室（**P1.10.T7**，依赖 lab 数据模型 P1.2.T9） | P1.10.T7 | 2.5 / 4 |
| M5b.3 | 资源看板页（**P1.10.T9**，依赖 P1.11.T6 接口） | P1.10.T9 | 1.5 / 2.5 |
| M5b.4 | SSO 接入 + run_id 全页透传（**P1.10.T10**） | P1.10.T10 | 0.5 / 1 |

**依赖**：M5a、M6（资源看板接口）。
**验收**：项目对话、多 agent 聊天室、资源看板可用。
**风险**：M5b.2 Lab 聊天室语义复杂（@提及/线程/thinking）。
**工时**：6.5 / 10.5 天。

**M5 总工时**：16 / 24.5 天（M5a 9.5/14 + M5b 6.5/10.5）。**可与 M3/M4 部分并发**——M5a 只依赖 M1/M2。

## M6 — 监控日志 + 资源面板 + 节点级 trace

**目标**：全链路 trace 串 run_id；资源面板 MVP；节点级 trace 供 AgentFlows 浏览。

**WBS**：

| 序号 | 任务 | 引用 | 估时 |
|---|---|---|---|
| M6.1 | OTel 全链路（**P1.11.T2**） | P1.11.T2 | 1 / 1.5 |
| M6.2 | daemon usage 落库（**P1.11.T3**） | P1.11.T3 | 0.5 / 1 |
| M6.3 | 资源面板 MVP（**P1.11.T4**） | P1.11.T4 | 1.5 / 2.5 |
| M6.4 | 节点级 trace（**P1.11.T5**） | P1.11.T5 | 1 / 1.5 |
| M6.5 | 资源看板数据聚合 API（**P1.11.T6**） | P1.11.T6 | 1 / 1.5 |
| M6.6 | 审计日志落地（**P1.4.T6**） | P1.4.T6 | 0.5 / 1 |
| M6.7 | 全链路追溯端到端验证 | — | 0.5 / 1 |

**依赖**：M2（daemon 可调）、M3（runs 有数据）。
**验收**：任一任务可全链路追溯；面板可看用量/成本；节点级 trace 可查；资源看板 API 可用。
**风险**：低。
**工时**：6 / 10 天。

## 总工时与关键路径

- **总工时**（乐观/悲观）：M0(8.5/17) + M1(2/4) + M2(12/23) + M3(7/14) + M4(4.25/7.5) + M5(16/24.5) + M6(6/10) = **55.75 / 100 天**。
- **关键路径**（严格串行）：M0 → M1 → M2(Gate-1) → M3(Gate-2) → M4 → M6。M5a 可在 M2 后与 M3/M4 并发；M5b 依赖 M6 接口。
- **两个 Gate 是最大不确定源**：
  - Gate-1 失败 → M2 翻倍（+10 天）。
  - Gate-2 失败 → 触发 D1 重评，M3 可能重设计（+7 天起）。
- **乐观情形**（Gate 都过、无大坑）：~8 周到 MVP 全闭环。
- **悲观情形**（Gate 各延期 + 环境坑）：~15 周。
- **注**：相比未纳入原型功能前的 41/77 天，采纳 A1+B1+C1 后前端（M5）与监控（M6）显著膨胀，这是"做完整控制台"的必然代价。

---

# 附录

## A. 风险登记册

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| R1 | Gate-1 失败（multica 协议 TS 翻译有语义损失 / claude stream-json 解析不稳） | M2 翻倍 | 中 | 限时 2 天 spike；失败先攻 claude 解析（不改架构），协议损失才升级 |
| R2 | Gate-2 发现"Flow State 后端化"不成立 | M3 重设计 | 中高 | §0.4 已列失败路径；M0 最早暴露 |
| R3 | fork Flowise 升级 merge 冲突 | 长期维护负担 | 高 | P1.9.T4 文档化流程；改造点集中、少改上游文件 |
| R4 | fork 构建失败（turbo/依赖锁） | M0 延期 | 中 | M0.3 单独攻破；锁 Docker 镜像 tag |
| R5 | Flowise Iteration 串行限制批量吞吐 | 批量慢 | 已知 | 自研 fan-out 绕开（P1.7.T4） |
| R6 | daemon 离线致任务积压 | 任务卡死 | 中 | 心跳 + 超时回收 + 重新派发（P1.5.T8） |
| R7 | LLM 成本失控 | 批量爆账 | 中 | 预算熔断 + 单 run 上限 + 并发闸（P1.7.T6） |
| R8 | 论文复现成功率低 | 场景验证失败 | 高（场景固有） | 定位"辅助复现"，选易复现论文起步，HITL 兜底 |
| R9 | Flowise 单实例 Prediction API 吞吐瓶颈 | 阶段1 扩展受阻 | 低（MVP 单机） | 多副本 + LB（前提：Flow State 已外置） |
| R10 | TypeORM 装饰器类型推断弱致开发体验差 | 开发慢 | 中 | `packages/db` 用 repository 模式封装，entities 类型手写补强；必要时上 `typeorm-typescript` 最佳实践 |
| R11 | new-api 与 Flowise 自带 credentials 冲突 | LLM 调用配置混乱 | 中 | Flowise credentials 指向 new-api 的 base_url + token，统一上游；M0.11 验证 |
| R12 | Lab 多 agent 聊天室语义复杂（@提及/线程/thinking/tool 块） | M5b 延期 | 中 | Lab 数据模型（P1.2.T9）先于前端落地；MVP 聊天室先做线程 + @提及，thinking/tool 块复用 daemon 事件流 |
| R13 | 控制台 6 页工作量压垮 M5 | M5 严重延期 | 中高 | M5 拆 M5a（核心 4 页）+ M5b（协作 3 页），M5a 先交付可用闭环 |
| R14 | 控制台 flows 浏览页与 Flowise 画布 UI 割裂 | 体验不一致 | 低 | flows 浏览页自研只读渲染，编辑跳 Flowise 画布；职责清晰 |
| R15 | new-api 令牌轮换误操作吊销在线 key | 正在进行的请求被拒 | 中 | 轮换需二次确认 + 审计日志（P1.4.T9 + P1.4.T6）；MVP 可只做单个轮换不做"轮换全部" |

## B. 技术选型表

| 维度 | 选型 | 理由 |
|---|---|---|
| 编排引擎 | Fork Flowise 3.1.3 | D1 |
| Monorepo | pnpm workspace + turbo | 与 Flowise 同构 |
| Web 框架 | Hono（gateway/dispatch） | 轻、TS 原生 |
| ORM | TypeORM | D8（与 Flowise 统一） |
| DB | PostgreSQL | Flowise 原生支持 |
| 队列/缓存/状态 | Redis | v0.2 §5.1 |
| 对象存储 | MinIO → S3 | S3 兼容 |
| Trace | Langfuse + OTel | Flowise 原生 Langfuse |
| 控制台前端 | Next.js（`apps/console`） | D17，6 页 |
| LLM 网关 | new-api（本地 `~/Projects/new-api`，docker 端口 3000） | D18，令牌托管 + 渠道 + 计费 |
| 异构 agent | 自研 daemon 两段式 | D12 |
| daemon 协议 | multica 翻译（TS） | D13 |

## C. 与 v0.2 文档差异声明

见 §0.5 表格。核心：v0.2 整体架构不变，但修正"天生后端化""Flow State 进程内""agentflow 是执行引擎"三处论断。Gate-2 双签通过，结论「需要但形态不同」已落入 §0.5 前两行；M3.3 据 §0.5 重定义为「配置 + 集成验证 + `Start.ts` 默认值小改」，详见 `docs/gate-2-flow-state.md` §5.2。

## C'. multica 使用路线决策（为何只翻译、不 fork）

> 背景：multica 本地位于 `~/Projects/multica`，是 Go + Next.js 的 AI 原生任务管理平台（"like Linear, but with AI agents"）。勘察后确认它不是"daemon 库"，而是完整平台，因此必须显式记录"为什么不像 Flowise 那样 fork 进来"。本节基于 multica v0.3.40（2026-07-07 最新拉取）复核，决策不变。

**勘察到的事实**（最新数据）：

- multica 是完整 SaaS 后台：Gorilla 路由、JWT、GitHub 集成、SMTP/Resend 邮件、S3/CloudFront、Google OAuth、pgvector 搜索。
- 域模型以任务管理为核心：`Issue`/`Squad`/`Autopilot`/`Skill`/`Runtime`/`Task`，**188 个 DB 迁移**（数百张表，且仍在增长——上次勘察 96，现已翻倍）。
- daemon 主体 `daemon.go` **4699 行** + `claude.go` **934 行**——功能远超"claim→execute→complete"。
- adapter 覆盖 **14 类** agent（claude/codex/copilot/opencode/openclaw/hermes/gemini/pi/cursor/kimi/kiro/antigravity/codebuddy/qoder）。
- **daemon↔server 协议形状稳定**：client.go 的方法签名（`ClaimTask`/`StartTask`/`ReportProgress`/`ReportTaskMessages`/`CompleteTask`/`ReportTaskUsage`/`FailTask`/`SendHeartbeat`/`Register`）与端点路径跨版本未变——这是选丙路线的关键利好，翻译目标是稳定靶子。
- license：modified Apache 2.0，**禁止用源码做 SaaS / 嵌入商业产品卖给第三方**；内部使用与参照自研允许。跨版本未改。

**三条路线对比**：

| | 甲. fork multica 当后端（改源码） | 乙. 跑 multica server，只用 daemon API | 丙. 只翻译协议 + adapter 知识（**选定**） |
|---|---|---|---|
| 省工 | M2 几乎全省、M6 大半省 | 同甲 | 不省 M2 |
| 代价 | Go 栈（违背 D6 全 TS）；背 Issue/Squad/Autopilot 域模型（用不到）；96 迁移 schema；它的认证/邮件/GitHub | 同甲 + 受 API 演进制约 | 翻译工作量 |
| 与 Flowise 重叠 | **严重**：multica autopilot ≈ Flowise flow，两编排系统打架 | 同甲 | 无 |
| license | 内部自用允许；对外服务触发商业 license | 同甲 | 无风险（不引源码） |

**决策：选丙（只翻译，不 fork）。理由**：

1. **功能重叠致命**：multica 的 autopilot（自动驾驶任务流）与 Flowise Agentflow V2 都是"编排 agent 执行"。已 fork Flowise 做编排引擎，再引入 multica autopilot = 两个编排系统打架。v0.2 把 multica 降级为"只参照 daemon 协议"正因如此——要的是它的**异构 agent 执行能力**（daemon + adapter，~15% 代码），不是它的**任务管理 + 编排能力**（Issue/Squad/Autopilot，~85%）。
2. **Go 栈与 D6 冲突**：全 TS 是锁定决策。fork multica 引入 Go 后端，daemon 的写/改/调试与 TS 层割裂，且 3272 行 Go 需先吃透。
3. **域模型不匹配**：dagents 要"编排 agent 跑流水线 + 批量复现"，不要 issue 跟踪/squad 协作/autopilot 语义。引入它们 = 背用不到的任务管理系统。
4. **license 边界**：fork 改源码自用允许，但 dagents 若未来对外服务则触发商业 license。翻译协议形状不引源码，完全规避。
5. **翻译成本被高估，且协议稳定**：multica 协议是标准 REST，client.go 方法签名跨版本未变（v0.3.40 复核），TS 翻译是机械工作且目标是稳定靶子；claude adapter 是 spawn + stream-json 解析，TS 等价物不更复杂。Gate-1 限时 2 天 spike 足以验证。相比 fork 4699 行 Go 代码的长期学习成本，翻译是赚的。

**结论**：D12（参照 multica 协议用 TS 自研、不引源码）成立。Gate-1（翻译协议 + claude adapter spike）是丙路线的验证点。Plan 不变。

## D. multica 协议翻译对照表

| multica（Go） | 本平台（TS） | 取/舍 | 说明 |
|---|---|---|---|
| `Backend.Execute(ctx, prompt, opts)` | `AgentBackend.execute(prompt, opts)` | 取 | 语义一致；ctx 用 AbortSignal 代替 |
| `Session.Messages`/`Result` | `AgentSession.events`/`result` | 取 | channel → AsyncIterable / Promise |
| `ExecOptions` 全字段 | 补全 ExtraArgs/CustomArgs/SemanticInactivityTimeout | 取 | §0.5 漏字段补全 |
| `MessageLog` | `AgentEvent.log` | 取 | §0.5 漏事件补全 |
| `Config{ExecutablePath,Env,Logger}` | `BackendConfig` | 取 | 同构 |
| `New(agentType, cfg)` 工厂 | `BackendFactory` | 取 | 11 类 agentType 全量 |
| `Register`/`Deregister`/`Heartbeat` | `/daemons/register`/`DELETE`/`/heartbeat` | 取 | daemon 生命周期 |
| `ClaimTask`/`StartTask` | `/daemons/:id/tasks/claim`/`/tasks/:id/start` | 取 | pull-based 核心 |
| `ReportProgress`/`ReportTaskMessages` | `/tasks/:id/progress`/`/messages` | 取 | 批量 messages 减 HTTP |
| `CompleteTask`/`FailTask` | `/tasks/:id/complete`/`/fail` | 取 | 去掉 branchName（multica git 专有） |
| `ReportUsage` | `/tasks/:id/usage`（合并进 complete） | 取·简化 | MVP 合并 |
| session resume | `AgentResult.sessionId` → `ExecOptions.resumeSessionId` | 取 | 跨调用续接 |
| `recover-orphans` | — | **舍** | multica 异常恢复专有，MVP 不做 |
| `gc-check`（issue/session/autopilot/task） | — | **舍** | multica issue 生命周期专有 |
| `local-skills` 相关 | — | **舍** | multica 技能市场专有 |
| `update`/`models` result | — | **舍** | multica runtime 自更新专有 |
| `X-Client-*` identity headers | 取 | daemon 侧附带 | 便于审计 |

---

## 下一步

本稿评审通过后，进入 writing-plans，把 Part 2 的 WBS 拆成 PR 级编码任务清单。**建议第一周只做 M0**，重点是 M0.3（fork 构建）与 M0.9（Gate-2 定位 Flow State）——这两个的结果决定 M2/M3 的走向。
