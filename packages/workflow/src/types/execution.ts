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
      messages: Array<{ role: string; content: string }>
      temperature?: number
    }): Promise<{ text: string }>
  }
  /** Tool registry for Agent nodes. */
  toolRegistry?: Record<string, unknown>
  /** Human input resolver for HumanInputNode. */
  humanInputResolver?: (prompt: string, inputType: string, options?: unknown[]) => Promise<string>
  /** Flow executor for ExecuteFlowNode. */
  flowExecutor?: (flowId: string, input: unknown) => Promise<Record<string, unknown>>
}
