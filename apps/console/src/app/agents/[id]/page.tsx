import { AgentDetailView } from '@/components/agent-detail-view'

/**
 * `/agents/[id]` — agent 详情页 (v0.3-M4.1, audit §3).
 *
 * Thin server component wiring the AppShell layout to the agent-detail client
 * view. The view owns the left `.inspector` (identity + live presence + 属性 +
 * Skills + 当前任务) and the right `.overview` 4-tab panel swap (Activity /
 * Instructions / Skills / Logs), ported from design/agent-detail.html. The
 * route stays a server component so the AppShell chrome renders before
 * hydration (matching every other route: a thin `page.tsx` delegating to a
 * `*-view.tsx` client component).
 *
 * Next 15's `params` is a Promise; `await` it to read `id` before passing it
 * to the view. No fetch here — the view fetches `/api/agents/:id` +
 * `/api/agents/:id/logs` on mount (same endpoints the M5a.2 drawer used).
 */
interface AgentDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function AgentDetailPage({
  params,
}: AgentDetailPageProps): Promise<React.ReactElement> {
  const { id } = await params
  return <AgentDetailView id={id} />
}
