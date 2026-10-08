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
  ControlledExecRequest,
  ControlledExecResult,
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
export {
  HumanInputPendingError,
  SeedHashMismatchError,
  NodeRejectedError,
} from './engine/errors.js'
// 2026-10-07 R2 暖缓存预演单源（design-recover §3.7(b)3）：gateway 的
// buildWarmCacheSeed 沿谱系链逐节点解析 resolved 输入——活动边判定/多入边
// 合并/配置归一/模板预演必须与引擎 runWaves 真实调度完全同源，口径漂移即
// inputHash 漂移（误杀/漏杀种子）。
export {
  shouldExecuteEdge,
  mergeInputs,
  mergedNodeInputs,
  previewResolved,
} from './engine/executor.js'
export {
  buildTrialSubgraph,
  buildTrialSeedRuntime,
  TRIAL_VIRTUAL_START_ID,
} from './utils/trial-subgraph.js'
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
// R4 声明式权限闭环（2026-10-07）：读/验/判/投影唯一实现——引擎守卫 /
// console 确认面 / gateway preflight 全部 import 此处（AC-R4-4 同源常量）
export {
  readNodePermission,
  parsePermissionValue,
  isValidDomainEntry,
  isValidCommandEntry,
  isDomainAllowed,
  httpDomainPolicy,
  assertAllowedHttpDomain,
  extractFlowPermissions,
  validatePermissionDeclarations,
  PERMISSION_FIELDS,
  MAX_DOMAINS_PER_NODE,
  MAX_COMMANDS_PER_NODE,
  MAX_DOMAIN_ENTRY_LEN,
  MAX_COMMAND_ENTRY_LEN,
} from './utils/flow-permissions.js'
export type {
  NodePermissionState,
  PermissionField,
  HttpDomainPolicy,
  FlowPermissionProjection,
  FlowCommandNodeSummary,
  FlowDomainNodeSummary,
} from './utils/flow-permissions.js'
export { applyAutoLayout, DEFAULT_AUTO_LAYOUT_STEPS } from './utils/auto-layout.js'
export type { AutoLayoutSteps } from './utils/auto-layout.js'
export {
  assertPublicHttpUrl,
  isPrivateHttpHost,
  privateHttpAllowed,
} from './nodes/http/ssrf-guard.js'

// Nodes (barrel) (Task 3+ — uncomment when modules land)
export * from './nodes/index.js'
