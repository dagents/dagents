/**
 * Canvas Kit 门面 —— 外部（页面客户端）只允许从这里 import。
 * 内部结构见 docs/canvas-replacement-architecture.md §3。
 */

export { FlowEditor, type FlowEditorHandle, type FlowEditorProps, type HeaderSlotProps } from './flow-editor'
export { normalizeDocument, serializeDocument, outputAnchorsFor } from './model/normalize'
export type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  FlowNodeData,
  StickyNoteData,
} from './model/flow-document'
export { INPUT_HANDLE_ID, DEFAULT_OUTPUT_ID } from './model/flow-document'
export { getSpec, NODE_SPECS, specGroups, anchorsOf } from './registry/node-spec'
export { connectionAllowed, wouldCreateCycle } from './kit/connection-rules'
export type { NodeRunStatus, RunState } from './kit/run-state'
export { EMPTY_RUN_STATE } from './kit/run-state'
