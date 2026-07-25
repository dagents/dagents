/**
 * Flow graph types — the structure of a workflow definition.
 *
 * Mirrors ReactFlow's node/edge shape (what Flowise's canvas produces) so
 * the existing flow_data JSON from chatflows can be loaded without transformation.
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
}

/** The complete flow definition — what's stored in the `flows` table's flow_data. */
export interface FlowData {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Optional viewport (canvas metadata). */
  viewport?: { x: number; y: number; zoom: number }
}
