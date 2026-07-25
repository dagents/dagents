/**
 * @mil/workflow — Workflow engine core (Plan A).
 *
 * Provides the DAG execution engine and node contract for the Chat-First
 * workflow system. Replaces the Flowise agentflow engine dependency.
 *
 * Plan A scope: types + linear DAG executor + 8 simple nodes.
 * Plan B (separate): Start/LLM/Agent nodes + branch/loop execution.
 * Plan C (separate): API routes + frontend switch + Flowise cleanup.
 */

// Types — exported for node implementers
export type { INode, INodeData, INodeParams, INodeOutput, INodeOptionsValue } from './types/node.js'
export type { FlowNode, FlowEdge, FlowData } from './types/flow.js'
export type { ExecutionStatus, IExecutedNode, IExecutionContext } from './types/execution.js'
export type { IServerSideEventStreamer, StreamEvent } from './types/stream.js'

// Engine (Task 3+ — uncomment when modules land)
export { NodeRegistry } from './engine/node-registry.js'
export { RuntimeState } from './engine/runtime.js'
export { DagExecutor } from './engine/executor.js'
export { SseStreamer } from './engine/sse-streamer.js'

// Utils (Task 3+ — uncomment when modules land)
export { resolveVariables } from './utils/variables.js'

// Nodes (barrel) (Task 3+ — uncomment when modules land)
export * from './nodes/index.js'
