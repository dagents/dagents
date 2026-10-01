import { AgentsView } from '@/components/agents-view'

/**
 * Agents 管理页 route (M5a.2 / P1.10.T4).
 *
 * The route is a thin server component that renders the client `AgentsView`,
 * which owns its own `PageShell` (title/subtitle/actions) the same way
 * `ChatView` does — so this file stays free of layout concerns. Its one job
 * beyond rendering: forwarding the ?tab= deep link (plaza = Agent 广场) as
 * the client component's initial tab.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}): Promise<React.ReactElement> {
  const { tab } = await searchParams
  return <AgentsView initialTab={tab === 'plaza' ? 'plaza' : 'agents'} />
}
