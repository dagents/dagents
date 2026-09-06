/**
 * 画布文档模型 —— 内存态（kit 渲染用）与持久化契约（flows.flow_data）之间的唯一桥梁。
 *
 * 持久化契约 = @dagents/workflow 的 FlowData（ReactFlow 形状），引擎按
 * `data.name` 派发。内存态的差异只在「显示层」：
 *  - node.type 收敛为 'flowNode' | 'stickyNote'（vendor 时代的 'agentflowNode'/
 *    'iteration'/'customNode' 在读入时归一）
 *  - 配置字段统一为扁平形态（读入时 data.inputs 覆盖 data.<field>，与引擎
 *    runNode 的合并序一致；写出时物化回扁平并删除 legacy inputs）
 *  - 句柄：入句柄每节点恒一个（id 'in'）；出句柄 id = 注册表 outputs 名，
 *    渲染期派生、不持久化
 *  - sourceHandle 是分支路由的执行语义 —— 原样透传，永不改写
 */

/** 普通流程节点的内存数据。 */
export interface FlowNodeData {
  /** 注册表派发键（如 'llmAgentflow'）。空串 = 未知节点（占位卡）。 */
  name: string
  label: string
  /** 模板链路在 start 节点上携带的 UI 提示（引擎忽略，列表/画布运行面板要读）。 */
  inputHint?: string
  inputExample?: string
  /** 其余键 = 节点配置字段 + 未知 passthrough（normalize-out 时一并写回）。 */
  [key: string]: unknown
}

/** 便签节点的内存数据。 */
export interface StickyNoteData {
  text: string
  /** RF 节点 data 约束（Record<string, unknown>）；unknown 键不落库。 */
  [key: string]: unknown
}

export interface CanvasNode {
  id: string
  type: 'flowNode' | 'stickyNote'
  position: { x: number; y: number }
  data: FlowNodeData | StickyNoteData
  /** 便签保留手工尺寸；流程节点由内容自适应，写出时剥离。 */
  width?: number
  height?: number
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  /** 出句柄 id = 注册表 outputs 名；执行语义键，读入时仅补缺、不改写既有值。 */
  sourceHandle?: string
  /** 入句柄恒为 'in'（写出时剥离，读入时补回）。 */
  targetHandle: string
}

export interface CanvasDocument {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

/** 单个入句柄的固定 id（NodeView 渲染、normalize 归一共同引用）。 */
export const INPUT_HANDLE_ID = 'in'

/** 无 outputs 元数据的节点默认出句柄 id（与引擎『无 sourceHandle = 恒活跃』兼容）。 */
export const DEFAULT_OUTPUT_ID = 'output'
