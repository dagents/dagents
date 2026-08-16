/**
 * Execution types — runtime state and result shapes.
 *
 * `IExecutionContext` replaces Flowise's `ICommonObject` bag — it's a typed
 * container for everything a node needs at runtime (state, chatId, SSE streamer,
 * the current node graph for self-referencing nodes like ExecuteFlow).
 */

import type { IServerSideEventStreamer } from './stream.js'

/** Execution status for a node or the overall flow run. */
export type ExecutionStatus = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

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
  /** The component nodes map (for ExecuteFlow self-reference — Plan B). */
  componentNodes?: Record<string, unknown>
  /** The runtime state container (deprecated alias — use `state` directly). */
  agentflowRuntime?: { state: Record<string, unknown> }
  /** LLM client for LLM and Agent nodes. */
  llmClient?: {
    chat(params: {
      model: string
      messages: IChatMessage[]
      temperature?: number
      /** Function tools the model may call (OpenAI tool format). */
      tools?: IToolSchema[]
    }): Promise<{ text: string; tool_calls?: IToolCall[]; usage?: ITokenUsage }>
    /**
     * Streamed variant of `chat` — yields incremental deltas. Optional: when
     * absent (or when the node isn't streamable) nodes fall back to `chat`.
     */
    chatStream?(params: {
      model: string
      messages: IChatMessage[]
      temperature?: number
    }): AsyncIterable<IChatStreamChunk>
  }
  /** Tool registry for Agent / Platform Agent nodes' tool-calling loop. */
  toolRegistry?: Record<string, IAgentTool>
  /**
   * History retriever for the Retriever node — keyword search over persisted
   * conversation history (or any document source the host wires in). Keeps
   * the workflow package storage-free.
   */
  historyRetriever?: (
    query: string,
    topK: number,
  ) => Promise<Array<{ role: string; content: string; createdAt?: string }>>
  /** Platform agent fetcher — resolves an agentId to its config (instructions, model, etc.). */
  agentFetcher?: (agentId: string) => Promise<PlatformAgentConfig | null>
  /** Human input resolver for HumanInputNode. */
  humanInputResolver?: (prompt: string, inputType: string, options?: unknown[]) => Promise<string>
  /** Flow executor for ExecuteFlowNode. */
  flowExecutor?: (flowId: string, input: unknown) => Promise<Record<string, unknown>>
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
