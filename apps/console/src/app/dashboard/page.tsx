import { DashboardView } from '@/components/dashboard-view'

/**
 * 资源看板 route (M6.3 / P1.11.T4). Wires the M5a.1 empty shell to the live
 * dashboard view backed by the M6.5 fleet-stats aggregation API. The view is a
 * client component (it fetches on mount + on window change); this route stays a
 * thin server component so the AppShell layout renders before hydration.
 */
export default function DashboardPage(): React.ReactElement {
  return <DashboardView />
}
