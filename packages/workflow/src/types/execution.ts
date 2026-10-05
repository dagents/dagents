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
 *  tokenBudget，调度器主动停机——区别于失败：产出截至停机点，根因明确。 */
export type ExecutionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'awaiting'
  | 'partial_success'
  | 'budget_exceeded'

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
}

/** One chunk of a streamed LLM response. */
export interface IChatStreamChunk {
  /** Incremental text delta (absent on the final usage-only chunk). */
  delta?: string
  /** Token usage, reported on the final chunk when the provider sends it. */
  usage?: ITokenUsage
}

/** activity 的过程活动类型 —— 与 contracts 的 AgentEvent 变体一一对应。
 *  `user_input`（2026-09-08 可操作终端）不是 CLI 事件 —— 它由宿主在插话
 *  送达后经 onNodeDelta 回写（同一条节点绑定通道），审计「谁在何时对哪个
 *  节点说了什么」。 */
export type IStreamActivityKind =
  'thinking' | 'tool' | 'tool_result' | 'status' | 'log' | 'error' | 'user_input'

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
    }): Promise<{ text: string; tool_calls?: IToolCall[]; usage?: ITokenUsage }>
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
