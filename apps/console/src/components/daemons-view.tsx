'use client'

/**
 * Daemons 页 — multica-inspired clean layout.
 *
 * Design principles ported from ~/Projects/multica:
 * - 克制即高级: clean two-column layout (queue + detail), no heavy stats panel
 * - 层次靠灰度: status dots + muted text carry the visual hierarchy
 * - 字号纪律: text-sm primary, text-xs for metadata
 * - 间距 > 分割线: spacing separates sections, not borders
 */

import { useEffect, useState } from 'react'
import type { DispatchTask } from '@/lib/daemons'
import { fetchDispatchTasks, fetchFleetStats, type FleetStats } from '@/lib/daemons'
import '@/styles/daemons.css'

type Filter = 'all' | 'queued' | 'running' | 'done' | 'failed'

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'queued', label: '排队' },
  { key: 'running', label: '运行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
]

const STATUS_DOT: Record<string, string> = {
  running: 'dot-running',
  queued: 'dot-queued',
  done: 'dot-done',
  failed: 'dot-failed',
}

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  queued: '排队',
  done: '已完成',
  failed: '失败',
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function DaemonsView(): React.ReactElement {
  const [tasks, setTasks] = useState<DispatchTask[]>([])
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const status = filter === 'all' ? undefined : filter
        const [t, s] = await Promise.all([
          fetchDispatchTasks(status),
          fetchFleetStats().catch(() => null),
        ])
        if (cancelled) return
        setTasks(t)
        if (s) setStats(s)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [filter])

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null

  const running = tasks.filter((t) => t.status === 'running').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const failed = tasks.filter((t) => t.status === 'failed').length

  return (
    <div className="daemons-view">
      {/* header bar: filter pills + stats inline */}
      <div className="daemons-header">
        <div className="daemons-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`daemons-filter${filter === f.key ? ' active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="daemons-stats-inline">
          <span className="stat-item">
            <span className="status-dot dot-running" />
            <span className="stat-val mono">{stats?.active_tasks ?? running}</span>
              运行
          </span>
          <span className="stat-item">
            <span className="status-dot dot-queued" />
            <span className="stat-val mono">{stats?.queue_depth ?? queued}</span>
              排队
          </span>
          <span className="stat-item">
            <span className="status-dot dot-failed" />
            <span className="stat-val mono">{failed}</span>
              失败
          </span>
          <span className="stat-item muted">
            <span className="stat-val mono">{stats?.online_daemons ?? '—'}</span>
              daemons
          </span>
        </div>
      </div>

      {/* two-column: queue + detail */}
      <div className="daemons-grid">
        {/* queue */}
        <div className="daemons-queue">
          <div className="daemons-queue-head">
            <span>任务队列</span>
            <span className="daemons-count mono">{tasks.length}</span>
          </div>
          <div className="daemons-queue-list">
            {loading && tasks.length === 0 ? (
              <div className="daemons-empty">加载中…</div>
            ) : tasks.length === 0 ? (
              <div className="daemons-empty">暂无任务</div>
            ) : (
              tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`daemons-task-card${selectedTaskId === t.id ? ' selected' : ''}`}
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <div className="task-card-top">
                    <span className={`status-dot ${STATUS_DOT[t.status] ?? ''}`} />
                    <span className="task-type">{t.type}</span>
                    <span className="task-priority mono">P{t.priority}</span>
                  </div>
                  <div className="task-card-desc">{t.description ?? t.id.slice(0, 8)}</div>
                  <div className="task-card-meta">
                    {t.flow_id ? <span className="mono">{t.flow_id.slice(0, 8)}</span> : null}
                    <span>{formatTime(t.created_at)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* detail panel */}
        <div className="daemons-detail">
          {!selectedTask ? (
            <div className="daemons-empty">选择左侧任务查看详情</div>
          ) : (
            <div className="daemons-detail-body">
              <div className="detail-head">
                <div className="detail-head-left">
                  <span className={`status-dot ${STATUS_DOT[selectedTask.status] ?? ''}`} />
                  <span className="detail-id mono">{selectedTask.id.slice(0, 8)}</span>
                  <span className={`detail-status ${selectedTask.status}`}>
                    {STATUS_LABEL[selectedTask.status] ?? selectedTask.status}
                  </span>
                </div>
                <span className="detail-type">{selectedTask.type}</span>
              </div>

              {/* timeline */}
              <div className="detail-timeline">
                <div className={`timeline-step ${selectedTask.status === 'done' ? 'done' : selectedTask.status === 'running' ? 'running' : 'queued'}`}>
                  <span className="timeline-dot" />
                  <span className="timeline-label">任务创建</span>
                  <span className="timeline-time mono">{new Date(selectedTask.created_at).toLocaleString()}</span>
                </div>
                <div className={`timeline-step ${selectedTask.status === 'running' ? 'running' : selectedTask.status === 'done' || selectedTask.status === 'failed' ? 'done' : 'queued'}`}>
                  <span className="timeline-dot" />
                  <span className="timeline-label">派发到 daemon</span>
                </div>
                <div className={`timeline-step ${selectedTask.status === 'done' ? 'done' : selectedTask.status === 'failed' ? 'failed' : 'queued'}`}>
                  <span className="timeline-dot" />
                  <span className="timeline-label">{selectedTask.status === 'failed' ? '执行失败' : '执行完成'}</span>
                  {selectedTask.updated_at !== selectedTask.created_at ? (
                    <span className="timeline-time mono">{new Date(selectedTask.updated_at).toLocaleString()}</span>
                  ) : null}
                </div>
              </div>

              {/* meta */}
              <div className="detail-meta">
                <div className="meta-row">
                  <span className="meta-label">优先级</span>
                  <span className="mono">P{selectedTask.priority}</span>
                </div>
                <div className="meta-row">
                  <span className="meta-label">Flow ID</span>
                  <span className="mono">{selectedTask.flow_id ?? '—'}</span>
                </div>
                <div className="meta-row">
                  <span className="meta-label">描述</span>
                  <span>{selectedTask.description ?? '—'}</span>
                </div>
              </div>

              {/* logs */}
              <div className="detail-logs">
                <div className="detail-logs-head">日志</div>
                <pre className="detail-logs-body">
{`[task ${selectedTask.id.slice(0, 8)}] type=${selectedTask.type} priority=${selectedTask.priority}
[task ${selectedTask.id.slice(0, 8)}] status=${selectedTask.status}
[task ${selectedTask.id.slice(0, 8)}] flow=${selectedTask.flow_id ?? 'none'}`}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {error ? <div className="daemons-error">{error}</div> : null}
    </div>
  )
}
