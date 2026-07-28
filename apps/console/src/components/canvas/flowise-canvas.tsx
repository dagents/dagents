'use client'

import { useCallback, useRef, useState } from 'react'
import { Agentflow } from '@dagents/agentflow'
import type { AgentFlowInstance, FlowData } from '@dagents/agentflow'

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

function convertToFlowiseFormat(initialFlow: FlowiseCanvasProps['initialFlow']): FlowData {
  const nodes = initialFlow.nodes.map((node) => ({
    id: node.id,
    type: 'agentflow',
    position: node.position || { x: 0, y: 0 },
    data: {
      ...node.data,
      name: node.data?.name || node.name || 'startAgentflow',
      label: node.data?.label || node.label || 'Start',
    },
  }))

  const edges = initialFlow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: edge.type || 'smoothstep',
    animated: edge.animated ?? false,
  }))

  return {
    nodes,
    edges,
    viewport: initialFlow.viewport || { x: 0, y: 0, zoom: 1 },
  }
}

export function FlowiseCanvas({ flowId, initialFlow, onSave, readOnly = false }: FlowiseCanvasProps): React.ReactElement {
  const agentflowRef = useRef<AgentFlowInstance>(null)
  const [isSaving, setIsSaving] = useState(false)

  const initialFlowData = convertToFlowiseFormat(initialFlow)

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
