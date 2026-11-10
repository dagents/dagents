import { PageShell } from '@/components/page-shell'
import { TeamView } from '@/components/team/team-view'

/**
 * /team — 公司作战室（Team Room，方向 A，2026-11-10）。
 * 实时聚合观察台（此刻 + 24h），运行历史仍按 flow 归属（FlowRunsPanel）。
 */
export default function TeamPage(): React.ReactElement {
  return (
    <PageShell fullBleed>
      <TeamView />
    </PageShell>
  )
}
