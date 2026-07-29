'use client'

/**
 * Daemons 页 — multica-inspired clean layout.
 *
 * Design principles ported from ~/Projects/multica:
 * - 克制即高级: clean two-column layout (queue + detail), no heavy stats panel
 * - 层次靠灰度: status dots + muted text carry the visual hierarchy
 * - 字号纪律: text-sm primary, text-xs for metadata
 * - 间距 > 分割线: spacing separates sections, not borders
 *
 * Polling posture: initial load shows skeleton; subsequent polls are silent
 * (no loading flicker). Polling pauses when the tab is hidden and backs off
 * exponentially on consecutive errors (capped at 60s) so a dead dispatch
 * server cannot hammer the gateway.
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
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

/** Base poll interval (ms) when healthy and tab visible. */
const POLL_BASE_MS = 5000
/** Cap for exponential backoff when polls keep failing. */
const POLL_MAX_BACKOFF_MS = 60_000

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

  // Refs kept out of state to avoid re-renders on every tick:
  // - backoff: current delay (doubles on error, resets to base on success)
  // - isVisible: whether the tab is focused (pauses polling when hidden)
  // - isInitial: drives the loading skeleton (only first successful paint)
  const backoffRef = useRef<number>(POLL_BASE_MS)
  const isVisibleRef = useRef<boolean>(true)
  const isInitialRef = useRef<boolean>(true)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Guard against re-entrant ticks. Without this, a visibility-triggered
    // `tick()` that fires while a previous load is still in flight would
    // start a second timer chain, doubling the poll rate.
    let ticking = false

    const load = async (): Promise<void> => {
      // Skip the network call entirely when the tab is hidden — the user
      // cannot see the data anyway, and pausing here is what stops the
      // "infinite polling" symptom at its root.
      if (!isVisibleRef.current) return
      try {
        const status = filter === 'all' ? undefined : filter
        const [t, s] = await Promise.all([
          fetchDispatchTasks(status),
          fetchFleetStats().catch(() => null),
        ])
        if (cancelled) return
        setTasks(t)
        if (s) setStats(s)
        // Reset backoff on success; only the very first paint toggles loading off.
        backoffRef.current = POLL_BASE_MS
        if (isInitialRef.current) {
          isInitialRef.current = false
          setLoading(false)
        }
        // Clear any prior error on a successful poll. Functional update avoids
        // capturing `error` in the closure (which would never see new values
        // because `error` is deliberately excluded from the deps array).
        setError((prev) => (prev === null ? prev : null))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        if (isInitialRef.current) {
          isInitialRef.current = false
          setLoading(false)
        }
        // Exponential backoff on failure so a dead dispatch server cannot
        // hammer the gateway (max 60s between attempts).
        backoffRef.current = Math.min(backoffRef.current * 2, POLL_MAX_BACKOFF_MS)
      }
    }

    // Single timer-chain loop: load → wait(backoff) → load → ...
    // Only one timer is ever pending at a time (cleared on unmount and on
    // visibility restart), so React 18 StrictMode double-mount cannot create
    // overlapping loops — the cleanup's `cancelled = true` + `clearTimeout`
    // kills the first loop before the second starts.
    const tick = (): void => {
      if (cancelled || ticking) return
      ticking = true
      void load().finally(() => {
        ticking = false
        if (cancelled) return
        // Don't schedule the next tick while the tab is hidden; the visibility
        // handler will restart the loop when the user returns.
        if (!isVisibleRef.current) return
        timer = setTimeout(tick, backoffRef.current)
      })
    }

    // Start the initial load immediately.
    tick()

    const handleVisibility = (): void => {
      const wasHidden = !isVisibleRef.current
      isVisibleRef.current = document.visibilityState === 'visible'
      // When the tab becomes visible again, restart the polling loop
      // immediately so the user sees fresh data without waiting.
      if (wasHidden && isVisibleRef.current && !cancelled) {
        backoffRef.current = POLL_BASE_MS
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        // If a load is in flight (ticking=true), its `.finally()` will see
        // isVisibleRef=true and schedule the next tick itself — no need to
        // call tick() here. Only start a new tick if the loop was idle.
        if (!ticking) tick()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    // `error` is intentionally excluded — referencing it inside `load` would
    // re-create the closure (and reset the polling loop) on every transient
    // failure, defeating the backoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              className="filter-chip"
              aria-pressed={filter === f.key}
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
              <div className="daemons-empty">
                <Icon name="loader" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
                <span>加载中…</span>
              </div>
            ) : tasks.length === 0 ? (
              <div className="daemons-empty">
                <Icon
                  name={filter === 'all' ? 'info' : 'check'}
                  style={{ width: 28, height: 28, color: 'var(--meta)' }}
                />
                <span className="daemons-empty-title">
                  {filter === 'all' ? '暂无派发任务' : '当前过滤器下无任务'}
                </span>
                <span className="daemons-empty-desc">
                  {filter === 'all'
                    ? '任务由 Agent / Flow 运行时自动派发到此队列。'
                    : '尝试切换到「全部」查看所有任务。'}
                </span>
                {filter !== 'all' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setFilter('all')}
                  >
                    查看全部任务
                  </button>
                ) : null}
              </div>
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
            <DaemonsDetailSkeleton />
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
              <div className="detail-section">
                <div className="detail-section-head">时间线</div>
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
              </div>

              {/* meta */}
              <div className="detail-section">
                <div className="detail-section-head">任务信息</div>
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
              </div>

              {/* logs */}
              <div className="detail-section">
                <div className="detail-section-head">日志</div>
                <div className="detail-logs">
                  <pre className="detail-logs-body">
{`[task ${selectedTask.id.slice(0, 8)}] type=${selectedTask.type} priority=${selectedTask.priority}
[task ${selectedTask.id.slice(0, 8)}] status=${selectedTask.status}
[task ${selectedTask.id.slice(0, 8)}] flow=${selectedTask.flow_id ?? 'none'}`}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {error ? <div className="daemons-error">{error}</div> : null}
    </div>
  )
}

// ─── Empty-state skeleton ─────────────────────────────────────────────
//
// When no task is selected, the detail panel shows a structured skeleton
// that mirrors the 4-panel information architecture (head / timeline /
// meta / logs). This makes the page's shape visible before selection —
// the user can see where the timeline, task info, and logs will appear —
// instead of a single line of placeholder text. The skeleton is purely
// decorative (aria-hidden) since sighted users see the visual hint and
// screen-reader users hear the empty-state label below.

function DaemonsDetailSkeleton(): React.ReactElement {
  return (
    <div className="daemons-detail-skeleton" aria-hidden="true">
      <div className="daemons-detail-empty-label" role="status" aria-live="polite">
        <Icon name="info" style={{ width: 20, height: 20, color: 'var(--meta)' }} />
        <span>选择左侧任务查看详情</span>
      </div>

      {/* head skeleton */}
      <div className="skel-head">
        <div className="skel-line skel-w-12" />
        <div className="skel-line skel-w-16" />
        <div className="skel-line skel-w-8" />
      </div>

      {/* timeline skeleton */}
      <div className="detail-section">
        <div className="detail-section-head">时间线</div>
        <div className="detail-timeline">
          {[0, 1, 2].map((i) => (
            <div className="timeline-step queued" key={i}>
              <span className="timeline-dot" />
              <span className="skel-line skel-w-24" />
            </div>
          ))}
        </div>
      </div>

      {/* meta skeleton */}
      <div className="detail-section">
        <div className="detail-section-head">任务信息</div>
        <div className="detail-meta">
          {[0, 1, 2].map((i) => (
            <div className="meta-row" key={i}>
              <span className="skel-line skel-w-10" />
              <span className="skel-line skel-w-20" />
            </div>
          ))}
        </div>
      </div>

      {/* logs skeleton */}
      <div className="detail-section">
        <div className="detail-section-head">日志</div>
        <div className="detail-logs">
          <div className="detail-logs-skel">
            <div className="skel-line skel-w-full" />
            <div className="skel-line skel-w-full" />
            <div className="skel-line skel-w-3q" />
          </div>
        </div>
      </div>
    </div>
  )
}
