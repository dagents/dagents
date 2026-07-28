import { PageShell } from '@/components/page-shell'
import { DaemonsView } from '@/components/daemons-view'

/**
 * Daemons route — task queue + execution timeline + stats.
 *
 * Two-column layout ported from design/daemon-execution.html.
 */
export default function DaemonsPage(): React.ReactElement {
  return (
    <PageShell fullBleed>
      <DaemonsView />
    </PageShell>
  )
}
