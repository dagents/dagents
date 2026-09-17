/**
 * Flow graph types — the structure of a workflow definition.
 *
 * 2026-09-17 起为类型唯一归属（此前 workflow 与 db 的 flow_data 形状
 * 各自手抄一份、零编译期联动 —— 节点字段改名 = 老数据静默读不到）。
 * workflow 包 re-export 保持既有 import 路径兼容；db 的 flow.entity
 * 列形状由此类型标注。
 */
/** A node in the flow graph (canvas position + type + data). */
export interface FlowNode {
  id: string
  /** Position on the canvas (not used by executor, but preserved for round-trip). */
  position?: { x: number; y: number }
  /** The node type (e.g. 'directReplyAgentflow'). */
  type?: string
  /** The node's configured data — matches INodeData.inputs shape. */
  data: Record<string, unknown>
  /** Width/height (canvas metadata, not used by executor). */
  width?: number
  height?: number
  /** Whether the node is selected (canvas state). */
  selected?: boolean
}

/** An edge connecting two nodes. */
export interface FlowEdge {
  id: string
  /** Source node id. */
  source: string
  /** Target node id. */
  target: string
  /** Output handle on the source node (for multi-output nodes). */
  sourceHandle?: string | null
  /** Input handle on the target node (for multi-input nodes). */
  targetHandle?: string | null
  type?: string
  animated?: boolean
  /** Optional edge label (canvas display). */
  label?: string
  /** Additional canvas metadata (e.g. nested label). */
  data?: Record<string, unknown>
}

/** The complete flow definition — what's stored in the `flows` table's flow_data. */
export interface FlowData {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Optional viewport (canvas metadata). */
  viewport?: { x: number; y: number; zoom: number }
}
