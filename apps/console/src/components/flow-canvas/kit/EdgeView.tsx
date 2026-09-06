/**
 * 流程边 —— 贝塞尔 + 分支标签（多锚点节点显示 True/False、循环体/出口）
 * + 运行态点亮（完成段静态绿、活动段 dash 流动）。
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from '@xyflow/react'
import { memo } from 'react'
import { getSpec } from '../registry/node-spec'
import { useRunState } from './run-state'
import type { FlowNodeData } from '../model/flow-document'

export const FlowEdgeView = memo(function FlowEdgeView(props: EdgeProps) {
  const { id, source, sourceHandleId, markerEnd } = props
  const { edgeStates } = useRunState()
  const state = edgeStates[id]

  const [path, labelX, labelY] = getBezierPath(props)

  // EdgeProps.source 是节点 id —— 类型名要从 nodeLookup 反查（getSpec 按
  // 注册名索引，直接喂 id 永远 miss，分支标签就永远不显示）。
  const sourceName = useStore((s) => {
    const node = s.nodeLookup.get(source)
    return (node?.internals.userNode as { data?: FlowNodeData } | undefined)?.data?.name ?? ''
  })
  // 分支标签：出句柄 ≥2 的节点显示锚点名（True/False、循环体/出口）
  const spec = getSpec(sourceName)
  const showLabel = spec != null && spec.outputs.length > 1 && sourceHandleId != null
  const anchorLabel = spec?.outputs.find((o) => o.id === sourceHandleId)?.label ?? sourceHandleId

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        className={`fc-edge${state ? ` edge-${state}` : ''}`}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="fc-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {anchorLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
