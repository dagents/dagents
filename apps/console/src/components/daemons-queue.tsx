'use client'

import { Icon } from '@/components/icon'
import type { DispatchTask } from '@/lib/daemons'

// Re-export so consumers can import the task shape from the component module
// (matches the original Task 11 import plan; single source of truth lives in
// `@/lib/daemons`).
export type { DispatchTask } from '@/lib/daemons'

interface DaemonsQueueProps {
  tasks: DispatchTask[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function DaemonsQueue({
  tasks,
  loading,
  selectedId,
  onSelect,
}: DaemonsQueueProps): React.ReactElement {
  return (
    <div className="daemons-queue">
      <div className="daemons-col-header">
        <Icon name="daemons" style={{ width: 14, height: 14 }} />
        <span>任务队列</span>
        <span className="daemons-col-count">{tasks.length}</span>
      </div>
      <div className="daemons-queue-list">
        {loading ? (
          <div className="daemons-empty">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="daemons-empty">暂无任务</div>
        ) : (
          tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`daemons-task-card${selectedId === t.id ? ' selected' : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <div className="daemons-task-card-head">
                <span className={`daemons-task-status status-${t.status}`} />
                <span className="daemons-task-type">{t.type}</span>
                <span className="daemons-task-priority">P{t.priority}</span>
              </div>
              <div className="daemons-task-desc">{t.description ?? t.id.slice(0, 8)}</div>
              <div className="daemons-task-meta">
                {t.flow_id && <span className="mono">{t.flow_id.slice(0, 8)}</span>}
                <span>{formatTime(t.created_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
