'use client'

import type { DispatchTask } from '@/components/daemons-queue'
import type { FleetStats } from '@/lib/daemons'
import { Icon } from '@/components/icon'

// Re-export so consumers can import the stats shape from the component module
// (matches the original Task 11 import plan; single source of truth lives in
// `@/lib/daemons`).
export type { FleetStats } from '@/lib/daemons'

interface DaemonsStatsProps {
  stats: FleetStats | null
  tasks: DispatchTask[]
}

export function DaemonsStats({ stats, tasks }: DaemonsStatsProps): React.ReactElement {
  const running = tasks.filter((t) => t.status === 'running').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const failed = tasks.filter((t) => t.status === 'failed').length

  return (
    <div className="daemons-stats">
      <div className="daemons-col-header">
        <Icon name="dashboard" style={{ width: 14, height: 14 }} />
        <span>统计</span>
      </div>
      <div className="daemons-stats-grid">
        <div className="daemons-stat">
          <div className="daemons-stat-label">在线 daemons</div>
          <div className="daemons-stat-value">{stats?.online_daemons ?? '—'}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">活跃任务</div>
          <div className="daemons-stat-value">{stats?.active_tasks ?? running}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">队列深度</div>
          <div className="daemons-stat-value">{stats?.queue_depth ?? queued}</div>
        </div>
        <div className="daemons-stat">
          <div className="daemons-stat-label">吞吐 / 分钟</div>
          <div className="daemons-stat-value">{stats?.throughput_per_min ?? '—'}</div>
        </div>
      </div>
      <div className="daemons-stats-breakdown">
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-running" />
          <span>running</span>
          <span className="mono">{running}</span>
        </div>
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-queued" />
          <span>queued</span>
          <span className="mono">{queued}</span>
        </div>
        <div className="daemons-stats-breakdown-row">
          <span className="daemons-task-status status-failed" />
          <span>failed</span>
          <span className="mono">{failed}</span>
        </div>
      </div>
    </div>
  )
}
