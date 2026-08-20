import { PageShell } from '@/components/page-shell'
import { FlowiseCanvasLoader } from '@/components/canvas/flowise-canvas-loader'
import { CanvasTopBar } from '@/components/canvas-top-bar'
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
  let flowName = 'Untitled'

  try {
    const res = await fetch(`${gatewayUrl()}/api/v1/workflows/${id}`, {
      cache: 'no-store',
    })

    if (res.ok) {
      const data = await res.json()
      if (data.success && data.data) {
        // API 返回结构是 { data: { flow: { flowData: {...}, name: '...' } } }
        // 列表页 flows-view.tsx 的 mapFlowDetail 也按此结构解析
        const flow = (
          data.data as { flow?: { flowData?: typeof flowData; name?: string } }
        ).flow
        if (flow?.flowData) {
          flowData = flow.flowData
        }
        if (flow?.name) {
          flowName = flow.name
        }
      }
    }
  } catch (error) {
    console.error('获取工作流数据失败:', error)
  }

  return (
    <PageShell fullBleed>
      {/* CanvasTopBar：流程名 + 另存为模板（不侵入 vendor 画布） */}
      <div className="ftpl-canvas-column">
        <CanvasTopBar flowId={id} flowName={flowName} />
        <div className="ftpl-canvas-body">
          <FlowiseCanvasLoader flowId={id} flowName={flowName} initialFlow={flowData} />
        </div>
      </div>
    </PageShell>
  )
}
