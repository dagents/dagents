/**
 * @dagents/workflow — Workflow engine core (Plan A).
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
export type { ExecutionStatus, IExecutedNode, IExecutionContext, ITokenUsage, PlatformAgentConfig, IChatMessage, IToolCall, IToolSchema, IAgentTool } from './types/execution.js'
export type { IServerSideEventStreamer, StreamEvent } from './types/stream.js'
export type { CanvasNodeMeta } from './nodes/node-registry-canvas.js'
export { CANVAS_NODES, getNodeMeta, getNodesByCategory, NODE_CATEGORIES } from './nodes/node-registry-canvas.js'

// Engine (Task 3+ — uncomment when modules land)
export { NodeRegistry } from './engine/node-registry.js'
export { RuntimeState } from './engine/runtime.js'
export { DagExecutor } from './engine/executor.js'
export { SseStreamer } from './engine/sse-streamer.js'

// Utils (Task 3+ — uncomment when modules landed)
export { resolveVariables } from './utils/variables.js'
export { parseFlowData, flowDataSchema } from './utils/flow-data.js'
export { findAgentReferences } from './utils/agent-refs.js'

// Flowise schema conversion for the vendored canvas editor
export { convertNodeToFlowiseSchema } from './flowise/convert-node.js'
export type { AgentOption } from './flowise/convert-node.js'

// Nodes (barrel) (Task 3+ — uncomment when modules land)
export * from './nodes/index.js'
