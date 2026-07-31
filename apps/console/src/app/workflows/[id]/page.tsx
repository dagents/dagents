import { redirect } from 'next/navigation'

interface WorkflowDetailPageProps {
  params: Promise<{ id: string }>
}

/**
 * /workflows/[id] 详情页 — 目前直接重定向到画布编辑器。
 * 后续可在此添加概览/运行历史/指标等概览视图。
 */
export default async function WorkflowDetailPage({
  params,
}: WorkflowDetailPageProps): Promise<never> {
  const { id } = await params
  redirect(`/workflows/${id}/canvas`)
}
