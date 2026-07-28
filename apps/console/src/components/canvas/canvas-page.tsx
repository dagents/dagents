'use client'

import { FlowCanvas } from './flow-canvas'

interface CanvasPageProps {
  flowId: string
  initialFlow: {
    id: string
    name?: string
    flowData?: {
      nodes: any[]
      edges: any[]
      viewport?: any
    }
  }
}

export function CanvasPage({ flowId, initialFlow }: CanvasPageProps): React.ReactElement {
  const handleSave = async (data: any): Promise<void> => {
    try {
      const response = await fetch(`/api/workflows/${flowId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flowData: data,
        }),
      })

      if (!response.ok) {
        throw new Error(`保存失败: ${response.status}`)
      }
    } catch (error) {
      console.error('保存工作流失败:', error)
      throw error
    }
  }

  const handleRun = (): void => {
    console.log('运行工作流:', flowId)
  }

  const initialData = initialFlow.flowData ?? {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <FlowCanvas
        flowId={flowId}
        initialData={initialData}
        onSave={handleSave}
        onRun={handleRun}
      />
    </div>
  )
}
