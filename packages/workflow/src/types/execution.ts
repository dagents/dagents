/**
 * Execution types — runtime state and result shapes.
 *
 * `IExecutionContext` replaces Flowise's `ICommonObject` bag — it's a typed
 * container for everything a node needs at runtime (state, chatId, SSE streamer,
 * plus host-injected resolvers.
 */

import type { IServerSideEventStreamer } from './stream.js'

/** Execution status for a node or the overall flow run. */
/** 'awaiting'：HumanInput 持久挂起（断点续跑 §6.3）—— 非终态，可应答回流续跑。
 *  'partial_success'（2026-10-04 失败分支隔离）：声明了 isolateFailure 的节点
 *  失败后下游剪枝、其余分支照常完成——run 有产出但带失败节点，不是纯成功。
 *  'budget_exceeded'（2026-10-04 run 级 token 预算）：累计用量越过
 *  tokenBudget，调度器主动停机——区别于失败：产出截至停机点，根因明确。
 *  'cached'（2026-10-07 可恢复性地基）：种子命中的节点跳过执行——只出现在
 *  节点终态（IExecutedNode.status，resume/暖缓存钩子回放），run 级终态永不取
 *  此值。
 *  'rejected'（2026-10-07 工程决策 9d，design-sharp §2.4）：声明型超限的节点
 *  拒绝（迭代项上限/子流程深度/retries≥1 耗尽，NodeRejectedError）——同样
 *  只出现在节点终态；失败并入 isolateFailure 管道 → run 走 partial_success，
 *  不整体翻红。 */
export type ExecutionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'awaiting'
  | 'partial_success'
  | 'budget_exceeded'
  | 'cached'
  | 'rejected'

/** Token usage reported by an LLM call. */
export interface ITokenUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

/** A single chat message — supports the tool-calling message roles. */
export interface IChatMessage {
  role: string
  content: string
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  /** Present on role: 'tool' messages, linking back to the tool_call id. */
  tool_call_id?: string
}

/** A tool call returned by the LLM, to be dispatched via the tool registry. */
export interface IToolCall {
  id: string
  function: { name: string; arguments: string }
}

/** Tool definition passed to the LLM API (OpenAI function-tool shape). */
export interface IToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A tool the agent can call during its reasoning loop. */
export interface IAgentTool {
  name: string
  description: string
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>
  /** Execute the tool; the returned string is fed back to the LLM. */
  handler: (args: Record<string, unknown>) => Promise<string>
}

/** The result of executing one node — stored in the execution log. */
export interface IExecutedNode {
  /** The node instance id. */
  nodeId: string
  /** The node type name. */
  nodeName: string
  /** Start time (ISO). */
  startedAt: string
  /** End time (ISO). */
  endedAt: string
  /** Execution status of this node. */
  status: ExecutionStatus
  /** The input that was passed in. */
  input: Record<string, unknown>
  /** The output that was produced. */
  output: Record<string, unknown>
  /** Error message if status === 'failed'. */
  error?: string
  /** Token usage reported by the node (LLM/Agent nodes); null when not applicable. */
  tokens?: ITokenUsage | null
  /** Monetary cost of the node's LLM call, when reported. */
  cost?: number | null
  /**
   * per-node 执行实例序号（2026-10-07 可恢复性地基，AD-R4）：每 nodeId 从 0
   * 单调递增——非迭代节点恒 0；迭代 body 第 n 次执行 = n（单层下恰等于项
   * 索引）。种子跳过（cached）的节点同样按其占位取号。span 标注、journal
   * decision 键 `(nodeId, ordinal)`、R8 会话寻址共用。
   */
  ordinal: number
  /**
   * 本次执行实际使用的模型（2026-10-07 R8 §3.6(c)）：HTTP = 实际请求
   * model 终值；CLI = `cli:<kind>` 形态。span / journal decision
   * `payload.resolvedModel` 与 runs.models 聚合的数据源（AC-R8-4 可查性）。
   */
  resolvedModel?: string
}

/** One chunk of a streamed LLM response. */
export interface IChatStreamChunk {
  /** Incremental text delta (absent on the final usage-only chunk). */
  delta?: string
  /** Token usage, reported on the final chunk when the provider sends it. */
  usage?: ITokenUsage
  /**
   * 本次调用实际使用的模型（2026-10-07 R8 §3.6(c)）：随末个 usage chunk
   * 上抛（HTTP = 实际请求 model 终值；CLI = `cli:<kind>`）——流式路径的
   * resolvedModel 数据源。
   */
  model?: string
}

/** activity 的过程活动类型 —— 与 contracts 的 AgentEvent 变体一一对应。
 *  `user_input`（2026-09-08 可操作终端）不是 CLI 事件 —— 它由宿主在插话
 *  送达后经 onNodeDelta 回写（同一条节点绑定通道），审计「谁在何时对哪个
 *  节点说了什么」。`verdict`（2026-10-07 R5 三值裁决）同性质：节点层合成
 *  的审计事件（第 N 轮裁决 / 回喂了什么 / 会话延续方式），不是 CLI AgentEvent
 *  的直译。与 contracts `RunLiveDelta.activity.kind`（宽松 string）人肉保持
 *  同步——新词在此加，契约侧形状零改动。 */
export type IStreamActivityKind =
  'thinking' | 'tool' | 'tool_result' | 'status' | 'log' | 'error' | 'user_input' | 'verdict'

/**
 * 节点增量产出载荷（onNodeDelta / llmClient.chat.onDelta，2026-08-30）：
 * `text` = 正文增量；`activity` = 过程活动。
 *
 * 保真契约（2026-09-06 终端视图用户裁决「采集层保全文，展示层做策展」）：
 * label/detail 由发送端携带**完整内容**、一律不截断 —— 短摘要/单行预览由
 * 展示层派生。字段语义：thinking 全文在 `label`；tool 的 `label`=工具名、
 * `detail`=参数 JSON 全文；tool_result 的 `label`=工具名、`detail`=输出
 * 全文；status/log/error 的 `label`=文本。
 */
export type IStreamDelta =
  | { type: 'text'; text: string }
  | { type: 'activity'; kind: IStreamActivityKind; label: string; detail?: string }

/**
 * Runtime context passed to every `INode.run`.
 *
 * This is the typed replacement for Flowise's `ICommonObject` options bag.
 * Nodes access state, chatId, and the SSE streamer through this object.
 */
export interface IExecutionContext {
  /** The chat id this execution belongs to (for SSE streaming + persistence). */
  chatId: string
  /** The run id (for trace correlation). */
  runId: string
  /** Mutable runtime state — nodes can read/write via `state`. */
  state: Record<string, unknown>
  /** Whether this is the last node in the DAG (enables streaming). */
  isLastNode: boolean
  /** SSE streamer — present when the client subscribed to /stream. */
  sseStreamer?: IServerSideEventStreamer
  /** The user's question/input that started the flow (from Start node). */
  startInput?: string
  /** Session id for memory continuity (Plan B: LLM/Agent memory). */
  sessionId?: string
  /** Abort signal — nodes should check this for long-running operations. */
  signal?: AbortSignal
  /**
   * 当前节点实例的执行序号（2026-10-07 地基）：与 IExecutedNode.ordinal 同源
   * （executor 按 per-node 计数器分配）。下游 llmClient.chat 的会话铸造
   * （R8 CliChatParams.ordinal，第 5 批接线）与 span 标注共用；根图节点恒 0。
   */
  nodeOrdinal?: number
  /** The runtime state container (deprecated alias — use `state` directly). */
  agentflowRuntime?: { state: Record<string, unknown> }
  /**
   * 节点增量产出回调（2026-08-30 流式展示）：LLM/Agent 节点在生成过程中
   * 逐段回调。载荷两种：`text` = 正文增量（live tail）；`activity` = 过程
   * 活动（CLI agent 的 thinking 摘要 / 工具调用）—— CLI Agent 干活的
   * 大部分时间在思考和调工具而非写正文，只有 text 时旁观端仍是「（执行
   * 中…）」黑盒。由 executor 按「当前节点」绑定 —— 节点内部无需（也不
   * 应）自己报 nodeId。宿主（gateway）把它接到 span-writer 的节流 partial
   * 落库，旁观端轮询即得 live tail + 活动流。
   */
  onNodeDelta?: (chunk: IStreamDelta) => void
  /** LLM client for LLM and Agent nodes. */
  llmClient?: {
    chat(params: {
      model: string
      messages: IChatMessage[]
      temperature?: number
      /** Function tools the model may call (OpenAI tool format). */
      tools?: IToolSchema[]
      /**
       * Cancellation signal (execution-cancellation spec D3): hosts should
       * abort the in-flight HTTP fetch / kill the CLI child when it fires.
       */
      signal?: AbortSignal
      /**
       * 调用方节点 id（2026-09-08 可操作终端）：CLI 宿主据此把本次会话
       * 登记进「运行中节点 → 会话」汇点表，运行中插话路由到正确的 CLI
       * 进程。并行波次各节点各报各的；HTTP 路径可忽略。
       */
      nodeId?: string
      /**
       * 增量产出回调（2026-08-30 流式展示）：CLI 后端逐事件转发 text 增量
       * 与过程活动（thinking/工具调用）；HTTP 非流式 chat 可忽略。
       * PlatformAgent 工具循环把它接到节点的 onNodeDelta，旁观端即可看到
       * Agent 边干边说的 live tail。
       */
      onDelta?: (chunk: IStreamDelta) => void
      /**
       * 输出契约（2026-10-04 结构化输出）：JSON Schema 子集。宿主把它编进
       * system prompt（要求只输出符合 schema 的 JSON），并在响应侧做一轮
       * 「校验 + 格式修复重试」；命中后返回的 text 是模型原始输出，节点侧
       * 解析后的对象挂在输出的 `json` 字段（下游模板 `{{id.json}}`）。
       * 声明了 responseSchema 的调用不走流式（修复重试无法撤回已推增量）。
       */
      responseSchema?: Record<string, unknown>
      /**
       * 会话延续（2026-10-07 R5 三值裁决 · 能力披露协议）：非空 = CLI 后端
       * 以 `--resume` 恢复该会话，本次 messages 只含增量消息（不含历史重放）；
       * 后端不支持时忽略（contracts ExecOptions 语义）。**取值单源**：只承载
       * 上一轮 chat 返回的后端真实会话 id（原样透传），严禁注入宿主自铸 id
       * ——run 级派生 id 不对应任何真实 CLI 会话，`--resume` 必炸首跳。
       */
      resumeSessionId?: string
      /**
       * per-node 执行实例序号（2026-10-07 R8，AD-R4）：CLI 宿主据此把会话
       * 登记进 `runId:nodeId:ordinal` 汇点键（并发迭代多会话可寻址）；
       * HTTP 路径可忽略。缺省 0。
       */
      ordinal?: number
      /**
       * 模型 pin 位（2026-10-07 R8.4）：显式声明过模型的调用置位——宿主
       * 对 pin 的调用禁熔断/瞬时降级（provider 故障响亮失败）；未声明维持
       * 降级基线（CLI 第一性）。
       */
      modelPinned?: boolean
    }): Promise<{
      text: string
      tool_calls?: IToolCall[]
      usage?: ITokenUsage
      /**
       * 本次调用的 CLI 会话 id（2026-10-07 R5 能力披露协议）：缺席 = 该后端
       * 无会话延续能力（HTTP provider 无状态 / 适配器无 resume）——节点层
       * 据此自动降级为 messages 全量回放的逻辑会话。
       */
      sessionId?: string
      /**
       * 本次调用实际使用的模型（2026-10-07 R8 §3.6(c) resolved model）：
       * HTTP = 实际请求 model 终值；CLI = `cli:<kind>` 形态。节点层透传进
       * 输出（IExecutedNode.resolvedModel 的数据源，AC-R8-4 可查性）。
       */
      model?: string
    }>
    /**
     * Streamed variant of `chat` — yields incremental deltas. Optional: when
     * absent (or when the node isn't streamable) nodes fall back to `chat`.
     */
    chatStream?(params: {
      model: string
      messages: IChatMessage[]
      temperature?: number
      signal?: AbortSignal
      /** 调用方节点 id（同 chat.nodeId，2026-09-08 可操作终端）。 */
      nodeId?: string
      /** 同 chat.onDelta（2026-09-08）：插话汇点回写 user_input 事件用。 */
      onDelta?: (chunk: IStreamDelta) => void
      /** 同 chat.ordinal（2026-10-07 R8）：CLI 会话汇点键的实例序号。 */
      ordinal?: number
      /** 同 chat.modelPinned（2026-10-07 R8.4）：pin 调用禁降级。 */
      modelPinned?: boolean
    }): AsyncIterable<IChatStreamChunk>
  }
  /** Tool registry for Agent / Platform Agent nodes' tool-calling loop. */
  toolRegistry?: Record<string, IAgentTool>
  /** Platform agent fetcher — resolves an agentId to its config (instructions, model, etc.). */
  agentFetcher?: (agentId: string) => Promise<PlatformAgentConfig | null>
  /** Human input resolver for HumanInputNode. */
  humanInputResolver?: (prompt: string, inputType: string, options?: unknown[]) => Promise<string>
  /**
   * 会话上下文检索器（2026-10-04 混合检索；P1b 升级两级契约）：
   * `summary` = 滚动会话摘要（更早对话的浓缩 checkpoint，可空）；
   * `messages` = 按相关性排序的近期原文消息。引擎只定义契约，排序/摘要
   * 策略在宿主（gateway）。
   */
  historyRetriever?: (
    query: string,
    opts: { chatId: string; limit: number },
  ) => Promise<{
    summary?: string | null
    messages: Array<{ role: string; content: string; createdAt?: string }>
  }>
  /**
   * flow 级上下文文件（P2a，2026-10-04）：宿主把 flows.context_md 按字节
   * 预算预裁后注入——LLM/Agent 节点编进 system 前部（特定上下文，牺牲序
   * 仅次于常驻）。引擎不感知存储。
   */
  flowContext?: string
  /**
   * 子流程执行器（2026-10-04 ExecuteFlow 一等节点）：引擎 DB-free——加载
   * 目标 flow 并以父 run 的同一套上下文执行由宿主注入。返回子流程 finalOutput。
   */
  flowExecutor?: (
    flowId: string,
    input: unknown,
    opts: { signal?: AbortSignal },
  ) => Promise<{ output: Record<string, unknown>; status: string }>
  /**
   * 受控命令执行（R4 声明式权限闭环，2026-10-07）：宿主注入（gateway
   * controlled-exec.ts 受控 spawn——no-shell、spawn 闸、超时强杀、输出
   * 截断）。customFunction 用户代码经 worker RPC → 引擎白名单裁决 →
   * 本通道执行；**未注入 = 通道不存在 = 全拒**（引擎 DB-free/spawn-free，
   * 与 flowExecutor 同模式）。
   */
  execRunner?: (req: ControlledExecRequest) => Promise<ControlledExecResult>
  /**
   * 试运行模式（R10，2026-10-07，design-sharp §3.4-③）：宿主（gateway
   * workflow-trial.ts）置位——http 节点在**全部静态校验之后、fetch 之前**
   * 按 httpMode 短路（skip = 不发真实请求、输出带「试运行」标注；real =
   * 照常真发，SSRF/R4 域名守卫零变化）。缺省（未置位）= 正式执行，行为
   * 逐字不变。
   */
  trialMode?: { http: 'skip' | 'real' }
}

/** 受控命令执行请求（R4）：引擎校验白名单后转发宿主执行。 */
export interface ControlledExecRequest {
  /** 裸命令名（引擎侧已校验 ∈ allowedCommands）。 */
  command: string
  /** 参数原样透传（no-shell spawn，无注入面）。 */
  args: string[]
  /** 该节点声明白名单（gateway 二次复核用，纵深防御）。 */
  allowedCommands: string[]
  /** 单次执行超时（缺省 15s，上限 60s）。 */
  timeoutMs?: number
  /** worker 超时/取消级联。 */
  signal?: AbortSignal
}

/** 受控命令执行结果（stdout/stderr 各 32KB 截断：保头 60% + 标记 + 保尾 40%）。 */
export interface ControlledExecResult {
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

/** Platform agent configuration — fetched by PlatformAgentNode via `agentFetcher`. */
export interface PlatformAgentConfig {
  id: string
  name: string
  /** System instructions (equivalent to systemPrompt). */
  instructions: string
  /** LLM model identifier. */
  model: string
  /** Agent kind (prompt, claude, codex, remote). */
  kind: string
  /** Skills / tools the agent has. */
  skills?: unknown[]
}
