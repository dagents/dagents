/**
 * Flow graph types —— 唯一归属已移至 @dagents/contracts（db 的
 * flow_data 列形状与引擎共用同一类型源，2026-09-17）。此处 re-export
 * 保持 `types/flow.js` 的既有 import 路径兼容。
 */
export type { FlowNode, FlowEdge, FlowData } from '@dagents/contracts'
