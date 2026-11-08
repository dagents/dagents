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

/**
 * 节点级权限声明（R4 声明式权限闭环，2026-10-07）——随节点 data 走，
 * data 保持 passthrough（不收紧 FlowNode.data：声明是节点类型专属约定，
 * 收紧会误伤其余 10 类节点的 data 字段）。此类型是编译期文档 + 共享词面
 * （'allowedCommands'/'allowedDomains' 字符串字面量），防引擎守卫 / console
 * 预扫 / gateway preflight 三处消费点手抄字段名漂移。读/验/判/投影的单源
 * 实现在 @dagents/workflow utils/flow-permissions.ts。
 */
export interface NodePermissionDeclarations {
  /** customFunction：受控命令通道白名单（裸命令名数组）；缺席 = 通道不存在。 */
  allowedCommands?: string[]
  /** http：请求与重定向目标域名清单（hostname 精确匹配）；缺席按网关策略裁决。 */
  allowedDomains?: string[]
}
