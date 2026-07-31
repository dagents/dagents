'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Agentflow } from '@dagents/agentflow'
import type { AgentFlowInstance, FlowData } from '@dagents/agentflow'
import { getNodeMeta } from '@dagents/workflow'
import './canvas.css'

interface FlowiseCanvasProps {
  flowId: string
  initialFlow: {
    nodes: any[]
    edges: any[]
    viewport?: any
  }
  onSave?: (data: any) => Promise<void>
  readOnly?: boolean
}

/**
 * 将后端存储的 flowData 转换为 Flowise Agentflow 期望的 FlowData 格式。
 *
 * 关键处理：补全 outputAnchors。从列表 API 读取的老数据可能缺少
 * outputAnchors 字段，这里根据 @dagents/workflow 注册表的 meta.outputs
 * 生成默认输出锚点，保证 Flowise 原生 AgentFlowNode 的 NodeOutputHandles
 * 能正确渲染连线端口。
 */
function convertToFlowiseFormat(initialFlow: FlowiseCanvasProps['initialFlow']): FlowData {
  const nodes = initialFlow.nodes.map((node) => {
    const name = node.data?.name || node.name || 'startAgentflow'
    const meta = getNodeMeta(name)

    // 补全 outputAnchors：老数据可能缺这个字段
    // id 用 name（如 "true"/"false"），使其与边的 sourceHandle 匹配
    let outputAnchors = node.data?.outputAnchors
    if (!outputAnchors || !Array.isArray(outputAnchors)) {
      if (meta?.outputs && Array.isArray(meta.outputs) && meta.outputs.length > 0) {
        outputAnchors = meta.outputs.map((o: any) => {
          const oName = typeof o === 'string' ? o : o.name ?? 'output'
          return {
            id: oName,
            name: oName,
            label: typeof o === 'string' ? o : o.label ?? oName,
            type: typeof o === 'string' ? 'string' : o.type ?? 'string',
          }
        })
      } else {
        outputAnchors = [
          {
            id: 'output',
            name: 'output',
            label: 'Output',
            type: 'string',
          },
        ]
      }
    }

    // 确保节点 type 被正确设置为 Flowise 原生类型
    // 后端存储的 type 可能是 'default' 或 undefined，需统一映射
    const rawType = node.type ?? ''
    const flowiseType =
      rawType === 'stickyNote' || rawType === 'iteration'
        ? rawType
        : rawType === 'agentflowNode'
          ? rawType
          : 'agentflowNode'

    return {
      ...node,
      type: flowiseType,
      data: {
        ...node.data,
        id: node.id,
        name,
        label: node.data?.label || node.label || 'Start',
        outputAnchors,
        inputs: node.data?.inputs ?? {},
        hideInput: node.data?.hideInput ?? meta?.category === 'start',
        // 注入 version，避免 Flowise NodeWarningIndicator 显示 "Node outdated" 橙色感叹号
        version: node.data?.version ?? 1,
      },
    }
  })

  const edges = initialFlow.edges.map((edge) => ({
    ...edge,
    type: edge.type || 'smoothstep',
    animated: edge.animated ?? false,
  }))

  return {
    nodes,
    edges,
    viewport: initialFlow.viewport || { x: 0, y: 0, zoom: 1 },
  }
}

export function FlowiseCanvas({
  flowId,
  initialFlow,
  onSave,
  readOnly = false,
}: FlowiseCanvasProps): React.ReactElement {
  const agentflowRef = useRef<AgentFlowInstance>(null)
  const [isSaving, setIsSaving] = useState(false)

  const initialFlowData = useMemo(
    () => convertToFlowiseFormat(initialFlow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlow],
  )

  const handleSave = useCallback(
    async (flowData: FlowData) => {
      if (!onSave) return
      setIsSaving(true)
      try {
        await onSave(flowData)
      } finally {
        setIsSaving(false)
      }
    },
    [onSave],
  )

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 520 }}>
      <Agentflow
        ref={agentflowRef}
        apiBaseUrl="/api/flowise"
        flowId={flowId}
        initialFlow={initialFlowData}
        onSave={handleSave}
        readOnly={readOnly}
        showDefaultHeader={true}
        showDefaultPalette={true}
        enableGenerator={true}
      />
    </div>
  )
}
