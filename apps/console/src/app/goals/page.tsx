import { PageShell } from '@/components/page-shell'
import { GoalsView } from '@/components/goals/goals-view'

/**
 * /goals — 目标看板（Goal Board，方向 C，2026-11-10）。
 */
export default function GoalsPage(): React.ReactElement {
  return (
    <PageShell fullBleed>
      <GoalsView />
    </PageShell>
  )
}
