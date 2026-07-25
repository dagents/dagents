import { PageShell } from '@/components/page-shell'
import { DaemonsView } from '@/components/daemons-view'

/**
 * Daemons route — task queue + execution timeline + stats.
 *
 * Three-column layout ported from design/daemon-execution.html.
 */
export default function DaemonsPage(): React.ReactElement {
  return (
    <PageShell
      title="Daemons"
      subtitle="任务队列 · 执行时间线 · 统计"
      fullBleed
    >
      <DaemonsView />
    </PageShell>
  )
}
