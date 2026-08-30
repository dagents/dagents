import { PageShell } from '@/components/page-shell'
import { FlowiseCanvasLoader } from '@/components/canvas/flowise-canvas-loader'
import { gatewayUrl } from '@/lib/config'

interface CanvasWorkflowPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ run?: string; created?: string }>
}

export default async function CanvasWorkflowPage({
  params,
  searchParams,
}: CanvasWorkflowPageProps): Promise<React.ReactElement> {
  const { id } = await params
  // ?run=<runId> — 旁观一个已有运行（如 chat @flow 触发），画布自动点亮进度
  const runParam = (await searchParams)?.run ?? null
  // ?created=1 —— 模板实例化落地（首跑引导条来源，见 FlowiseCanvas）
  const firstRunHint = (await searchParams)?.created === '1'
  const watchRunId = /^[0-9a-fA-F-]{8,64}$/.test(runParam ?? '') ? runParam : null

  let flowData = {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  let flowName = '未命名 Flow'
  // Fetch failure previously rendered an EMPTY editable canvas named
  // "Untitled" — indistinguishable from a brand-new flow, and saving it
  // would blank the real one. Now it's an explicit error state.
  let flowError: string | null = null

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
      } else {
        flowError = `HTTP ${res.status}`
      }
    } else if (res.status === 404) {
      flowError = 'not-found'
    } else {
      flowError = `HTTP ${res.status}`
    }
  } catch (error) {
    console.error('获取工作流数据失败:', error)
    flowError = error instanceof Error ? error.message : String(error)
  }

  return (
    <PageShell fullBleed>
      {flowError ? (
        <div className="not-found" style={{ gridColumn: '1 / -1' }}>
          <div className="h">{flowError === 'not-found' ? '找不到这个 Flow' : '工作流加载失败'}</div>
          <div className="d">
            {flowError === 'not-found'
              ? `id “${id}” 不存在，可能已被删除。`
              : `加载失败：${flowError}。请刷新重试。`}
          </div>
          <a className="btn btn-secondary btn-sm" href="/flows">返回 Flow 列表</a>
        </div>
      ) : (
        <div className="ftpl-canvas-column">
          {/* 单一顶栏（2026-08-30 设计收敛）：流程名/运行/保存/另存为模板
              全部在 vendor 画布自带的 agentflow-header 里 —— 此前的页面级
              CanvasTopBar 与之叠成双标题，已删。 */}
          <div className="ftpl-canvas-body">
            <FlowiseCanvasLoader flowId={id} flowName={flowName} initialFlow={flowData} watchRunId={watchRunId} firstRunHint={firstRunHint} />
          </div>
        </div>
      )}
    </PageShell>
  )
}
