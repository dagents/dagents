import { PageShell } from '@/components/page-shell'
import { FlowiseCanvas } from '@/components/canvas/flowise-canvas'
import { gatewayUrl } from '@/lib/config'

interface CanvasWorkflowPageProps {
  params: Promise<{ id: string }>
}

export default async function CanvasWorkflowPage({
  params,
}: CanvasWorkflowPageProps): Promise<React.ReactElement> {
  const { id } = await params

  let flowData = {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }

  try {
    const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
      cache: 'no-store',
    })

    if (res.ok) {
      const data = await res.json()
      if (data.success && data.data) {
        // API 返回结构是 { data: { flow: { flowData: {...} } } }
        // 列表页 flows-view.tsx 的 mapFlowDetail 也按此结构解析
        const flow = (data.data as { flow?: { flowData?: typeof flowData } }).flow
        if (flow?.flowData) {
          flowData = flow.flowData
        }
      }
    }
  } catch (error) {
    console.error('获取工作流数据失败:', error)
  }

  return (
    <PageShell fullBleed>
      <FlowiseCanvas flowId={id} initialFlow={flowData} />
    </PageShell>
  )
}
