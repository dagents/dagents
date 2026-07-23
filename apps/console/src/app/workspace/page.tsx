import { WorkspaceView } from '@/components/workspace-view'

/**
 * Workspace 项目对话页 route (M5b.1 / P1.10.T6). Wires the M5a empty shell to
 * the live view backed by the gateway's `/api/v1/workspaces/*` read API. The
 * view is a client component (it fetches on mount + on selection); this route
 * stays a thin server component so the AppShell layout renders before
 * hydration.
 */
export default function WorkspacePage(): React.ReactElement {
  return <WorkspaceView />
}
