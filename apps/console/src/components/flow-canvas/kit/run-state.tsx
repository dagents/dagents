/**
 * 运行态注入 —— 单向数据流：run/ 模块（轮询 node-spans）产出
 * Record<nodeId, status> 与 Record<edgeId, 'done'|'active'>，经此 context
 * 下发到 NodeView/EdgeView 渲染。绝不进 nodes 状态（不污染脏标记、不落库）。
 */

import { createContext, useContext } from 'react'

/** 与 console SPAN_STATUS_MAP 对齐的显示态。 */
export type NodeRunStatus = 'running' | 'done' | 'failed' | 'waiting'

export interface RunState {
  nodeStates: Record<string, { status: NodeRunStatus; error?: string }>
  edgeStates: Record<string, 'done' | 'active'>
}

export const EMPTY_RUN_STATE: RunState = { nodeStates: {}, edgeStates: {} }

const RunStateContext = createContext<RunState>(EMPTY_RUN_STATE)

export const RunStateProvider = RunStateContext.Provider

export function useRunState(): RunState {
  return useContext(RunStateContext)
}
