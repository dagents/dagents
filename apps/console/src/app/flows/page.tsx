import { FlowsView } from '@/components/flows-view'

/**
 * AgentFlows 浏览页 route (P1.10.T5).
 *
 * M5a.1 shipped this as an empty shell; M5a.3 replaces it with the full browse
 * view — flow list + read-only DAG + node status coloring + per-node run
 * metrics. The view is a client component (it fetches `/api/workflows` on
 * mount and manages selection state); this route is just the server entry that
 * renders it.
 */
export default function FlowsPage(): React.ReactElement {
  return <FlowsView />
}
