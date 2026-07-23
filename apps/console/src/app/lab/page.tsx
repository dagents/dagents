import { LabView } from '@/components/lab-view'

/**
 * Lab 多 agent 聊天室 route (M5b.2 / P1.10.T7). Wires the M5a empty shell to
 * the live view backed by the gateway's `/api/v1/lab/*` API. The view is a
 * client component (it fetches on mount + on selection); this route stays a
 * thin server component so the AppShell layout renders before hydration.
 */
export default function LabPage(): React.ReactElement {
  return <LabView />
}
