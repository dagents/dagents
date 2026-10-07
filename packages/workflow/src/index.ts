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
export type {
  ExecutionStatus,
  IExecutedNode,
  IExecutionContext,
  ITokenUsage,
  PlatformAgentConfig,
  IChatMessage,
  IToolCall,
  IToolSchema,
  IAgentTool,
  IChatStreamChunk,
  IStreamDelta,
  IStreamActivityKind,
} from './types/execution.js'
export type { IServerSideEventStreamer, StreamEvent } from './types/stream.js'
export type { CanvasNodeMeta } from './nodes/node-registry-canvas.js'
export {
  CANVAS_NODES,
  getNodeMeta,
  getNodesByCategory,
  NODE_CATEGORIES,
} from './nodes/node-registry-canvas.js'

// Engine (Task 3+ — uncomment when modules land)
export { NodeRegistry } from './engine/node-registry.js'
export { RuntimeState } from './engine/runtime.js'
export { DagExecutor } from './engine/executor.js'
export type { ExecutionResult } from './engine/executor.js'
export type {
  ResumeOptions,
  IterationProgress,
  RunCheckpointSnapshot,
  JournalDecision,
  JournalFacade,
} from './engine/executor.js'
export { HumanInputPendingError, SeedHashMismatchError } from './engine/errors.js'
export { SseStreamer } from './engine/sse-streamer.js'

// Utils (Task 3+ — uncomment when modules landed)
export { resolveVariables } from './utils/variables.js'
// 2026-10-07 可恢复性地基：inputHash 单源（引擎种子校验与 gateway 暖缓存/
// resume 校验共用，不得出现第二套 hash——PRD R2 风险条款）
export { canonicalJson, computeInputHash, NON_DETERMINISTIC_KEYS } from './utils/input-hash.js'
export { parseFlowData, flowDataSchema } from './utils/flow-data.js'
export { findAgentReferences } from './utils/agent-refs.js'
export { validateFlowTopology, resolveNodeType } from './utils/validate-topology.js'
export type { TopologyError, TopologyWarning, TopologyResult } from './utils/validate-topology.js'
export { applyAutoLayout, DEFAULT_AUTO_LAYOUT_STEPS } from './utils/auto-layout.js'
export type { AutoLayoutSteps } from './utils/auto-layout.js'
export {
  assertPublicHttpUrl,
  isPrivateHttpHost,
  privateHttpAllowed,
} from './nodes/http/ssrf-guard.js'

// Nodes (barrel) (Task 3+ — uncomment when modules land)
export * from './nodes/index.js'
