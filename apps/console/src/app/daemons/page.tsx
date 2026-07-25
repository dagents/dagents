import { PageShell } from '@/components/page-shell'

/**
 * Daemons route — task queue + execution timeline + stats.
 *
 * Placeholder page; full implementation will use design/daemon-execution.html
 * three-column layout (task queue / execution timeline / statistics).
 */

export default function DaemonsPage(): React.ReactElement {
  return (
    <PageShell
      title="Daemons"
      subtitle="任务队列 · 执行时间线 · 统计"
    >
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--muted)' }}>
        Daemons 模块开发中
      </div>
    </PageShell>
  )
}
