/**
 * Node contract — the interface every workflow node implements.
 *
 *抽离 from Flowise's `INode` (vendor/flowise/packages/components/src/Interface.ts)
 * but simplified: no `credential`/`asyncOptions`/`baseClasses` complexity beyond
 * what the executor and node implementers need. The `run` signature uses
 * `IExecutionContext` (our type) instead of Flowise's `ICommonObject` so node
 * code doesn't depend on Flowise's type bag.
 */

/** Input field schema — describes one input on the canvas editor. */
export interface INodeParams {
  label: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'options' | 'json' | 'code' | 'file' | 'password'
  description?: string
  rows?: number
  acceptVariable?: boolean
  options?: INodeOptionsValue[]
  default?: unknown
  required?: boolean
  placeholder?: string
  hide?: boolean
}

/** Option value for `type: 'options'` inputs. */
export interface INodeOptionsValue {
  label: string
  name: string
  description?: string
  icon?: string
}

/** Runtime node data — what the executor passes to `INode.run`. */
export interface INodeData {
  /** The node instance id (from the canvas graph). */
  id: string
  /** The node type name (e.g. 'directReplyAgentflow'). */
  name: string
  /** Input values configured on the canvas. */
  inputs?: Record<string, unknown>
  /** The full node definition (label, category, etc.) — optional for runtime. */
  node?: Record<string, unknown>
}

/** Output every node must return from `run`. */
export interface INodeOutput {
  /** The node instance id that produced this output. */
  id: string
  /** The node type name. */
  name: string
  /** The input that was passed in (for traceability). */
  input: Record<string, unknown>
  /** The output the next node consumes. */
  output: Record<string, unknown>
  /** Optional state mutations to merge into the runtime state. */
  state?: Record<string, unknown>
  /** Optional chat history entries to append (for LLM/Agent nodes in Plan B). */
  chatHistory?: unknown[]
}

/** The node interface. Every node class implements this. */
export interface INode {
  label: string
  name: string
  version: number
  type: string
  category: string
  color: string
  inputs: INodeParams[]
  /**
   * Execute the node.
   *
   * @param nodeData - The node's configured inputs + instance id.
   * @param input - The input from upstream nodes (merged if multiple).
   * @param options - Runtime context (state, chatId, sseStreamer, etc.).
   * @returns The node's output — its `output` field flows to downstream nodes.
   */
  run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput>
}

// Forward-declare IExecutionContext (defined in execution.ts) to avoid circular import.
// The import below is a type-only import, safe for ESM.
import type { IExecutionContext } from './execution.js'
