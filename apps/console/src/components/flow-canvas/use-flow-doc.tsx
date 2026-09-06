/**
 * 文档动作上下文 —— kit 子组件（便签等）回写文档的通道。
 * 真正的状态所有权在 flow-editor 组合根（useFlowEditorCore）。
 */

import { createContext, useContext } from 'react'

export interface FlowDocActions {
  updateNodeData(id: string, patch: Record<string, unknown>): void
  duplicateNode(id: string): void
  deleteNode(id: string): void
  /** 工具条「编辑」→ 打开检查器（与双击同通道）。 */
  openInspector(id: string): void
  /** 只读模式（旁观运行）下子组件禁写。 */
  writable: boolean
}

const FlowDocActionsContext = createContext<FlowDocActions | null>(null)

export const FlowDocActionsProvider = FlowDocActionsContext.Provider

export function useFlowDocActions(): FlowDocActions {
  const ctx = useContext(FlowDocActionsContext)
  if (!ctx) throw new Error('useFlowDocActions must be used within FlowDocActionsProvider')
  return ctx
}
