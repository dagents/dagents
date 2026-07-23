import { PageShell } from '@/components/page-shell'
import { FlowEditorFrame } from '@/components/flow-editor-frame'

/**
 * `/flows/[id]/edit` — 嵌入式 Flowise 画布编辑器 (M2.3, audit §1.5).
 *
 * design/agentflows.html:350 的 `<button data-action="edit">编辑画布</button>`
 * 此前是占位 alert；本路由把它接到 Flowise 原生画布编辑页：通过 iframe 嵌入
 * `flowiseEditorUrl()/canvas/<id>`，用户在 AppShell 内即可拖拽节点、编辑连线，
 * 不离开控制台。CSP 放行靠 M0.3 配的 `IFRAME_ORIGINS=http://localhost:3000`
 * （Flowise `XSS.ts:getIframeSecurityHeaders()` 读它发 `frame-ancestors`），无需改 fork。
 *
 * 默认渲染 iframe（嵌入态）；`?external=1` 时降级为「在新标签打开」外链卡片，
 * 用于 CSP 未放行的预览环境或希望用整页画布的场景。
 *
 * 是 async server component：Next 15 的 `params` / `searchParams` 都是 Promise，
 * `await` 取值后透传给纯展示组件 FlowEditorFrame。不在此 fetch flow 名——
 * 验收只需 iframe src 含 `/canvas/<id>`，flow 名是锦上添花，留待后续 M2.x 接入。
 */

interface EditPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function EditFlowPage({
  params,
  searchParams,
}: EditPageProps): Promise<React.ReactElement> {
  const { id } = await params
  const query = await searchParams
  const external = query.external === '1'

  return (
    <PageShell
      title="编辑画布"
      subtitle="Flowise 原生画布编辑器，节点可拖拽、连线可编辑。"
      fullBleed
    >
      <FlowEditorFrame chatflowId={id} external={external} />
    </PageShell>
  )
}
