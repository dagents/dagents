export type NodeStatus = 'idle' | 'running' | 'done' | 'failed' | 'queued' | 'skipped'

export interface FlowNodeData {
  name: string
  label: string
  /** 运行态 — 由 flow-canvas 注入,CustomNode 据此着色边框/状态点 */
  status?: NodeStatus
  /** 运行耗时(ms),运行/完成时显示 */
  durationMs?: number
  [key: string]: unknown
}

export interface CanvasProps {
  flowId: string
  initialData: {
    nodes: any[]
    edges: any[]
    viewport?: any
  }
  onSave?: (data: any) => Promise<void>
  onRun?: () => void
  readOnly?: boolean
}

export const STATUS_COLORS: Record<NodeStatus, string> = {
  idle: 'var(--meta)',
  running: 'var(--accent)',
  done: 'var(--success, #10b981)',
  failed: 'var(--danger, #ef4444)',
  queued: 'var(--warn, #f59e0b)',
  skipped: 'var(--info, #3b82f6)',
}

export const STATUS_LABELS: Record<NodeStatus, string> = {
  idle: '待运行',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  queued: '排队中',
  skipped: '跳过',
}
