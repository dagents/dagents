'use client'

/**
 * Daemons 页 — daemon worker 列表（multica-inspired）。
 *
 * 两层视图：
 * 1. daemon 列表（默认）— 展示已注册的 daemon workers
 * 2. 任务队列（点击 daemon 进入）— 该 daemon 的任务列表 + 详情
 *
 * Polling: 5s 基础间隔，页面隐藏时暂停，连续失败指数退避（上限 60s）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/icon'
import { SkeletonList } from '@/components/skeleton'
import { AGENT_KINDS } from '@/lib/agents-catalog'
import {
  fetchDaemons,
  fetchDispatchTasks,
  fetchFleetStats,
  type DaemonInfo,
  type DispatchTask,
  type DispatchTaskStatus,
  type FleetStats,
} from '@/lib/daemons'
import '@/styles/daemons.css'

// ─── local CLI runtimes (auto-detected) ──────────────────────────────

/** One row of the gateway's GET /api/v1/cli-runtimes PATH scan. */
interface RuntimeDetection {
  kind: string
  binary: string
  available: boolean
  path: string | null
}

/** CLI agent kinds only (prompt/remote have no binary — nothing to detect). */
const CLI_KINDS = AGENT_KINDS.filter((m) => m.binary.length > 0)

// ─── daemon list ─────────────────────────────────────────────────────

type DaemonFilter = 'all' | 'online' | 'offline'

const DAEMON_FILTERS: ReadonlyArray<{ key: DaemonFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'online', label: '在线' },
  { key: 'offline', label: '离线' },
]

const DAEMON_STATUS_DOT: Record<string, string> = {
  online: 'dot-running',
  offline: 'dot-done',
  draining: 'dot-queued',
}

const DAEMON_STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  draining: '排空中',
}

/** Base poll interval (ms) when healthy and tab visible. */
const POLL_BASE_MS = 5000
/** Cap for exponential backoff when polls keep failing. */
const POLL_MAX_BACKOFF_MS = 60_000

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(dateStr).toLocaleDateString()
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function DaemonsView(): React.ReactElement {
  const [daemons, setDaemons] = useState<DaemonInfo[]>([])
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [filter, setFilter] = useState<DaemonFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDaemon, setSelectedDaemon] = useState<DaemonInfo | null>(null)
  const [showRegister, setShowRegister] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DaemonInfo | null>(null)
  const [runtimes, setRuntimes] = useState<RuntimeDetection[]>([])
  const [runtimesLoading, setRuntimesLoading] = useState(true)

  // Local CLI detection (gateway scans PATH). Once on mount + manual refresh —
  // unlike daemons this doesn't change on its own, no polling needed.
  const loadRuntimes = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch('/api/cli-runtimes')
      const json = (await resp.json()) as { success: boolean; data?: { runtimes: RuntimeDetection[] } }
      if (json.success && json.data) setRuntimes(json.data.runtimes)
    } catch {
      // silent — the grid still renders with unknown (未检测) status
    } finally {
      setRuntimesLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuntimes() }, [loadRuntimes])

  const backoffRef = useRef<number>(POLL_BASE_MS)
  const isVisibleRef = useRef<boolean>(true)
  const isInitialRef = useRef<boolean>(true)

  const reload = async (): Promise<void> => {
    const [d, s] = await Promise.all([
      fetchDaemons(),
      fetchFleetStats().catch(() => null),
    ])
    setDaemons(d)
    if (s) setStats(s)
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticking = false

    const load = async (): Promise<void> => {
      if (!isVisibleRef.current) return
      try {
        const [d, s] = await Promise.all([
          fetchDaemons(),
          fetchFleetStats().catch(() => null),
        ])
        if (cancelled) return
        setDaemons(d)
        if (s) setStats(s)
        // Update selected daemon's info if it's still in the list
        if (selectedDaemon) {
          const updated = d.find((x) => x.id === selectedDaemon.id)
          if (updated && updated.status !== selectedDaemon.status) {
            setSelectedDaemon(updated)
          }
        }
        backoffRef.current = POLL_BASE_MS
        if (isInitialRef.current) {
          isInitialRef.current = false
          setLoading(false)
        }
        setError((prev) => (prev === null ? prev : null))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        if (isInitialRef.current) {
          isInitialRef.current = false
          setLoading(false)
        }
        backoffRef.current = Math.min(backoffRef.current * 2, POLL_MAX_BACKOFF_MS)
      }
    }

    const tick = (): void => {
      if (cancelled || ticking) return
      ticking = true
      void load().finally(() => {
        ticking = false
        if (cancelled) return
        if (!isVisibleRef.current) return
        timer = setTimeout(tick, backoffRef.current)
      })
    }

    tick()

    const handleVisibility = (): void => {
      const wasHidden = !isVisibleRef.current
      isVisibleRef.current = document.visibilityState === 'visible'
      if (wasHidden && isVisibleRef.current && !cancelled) {
        backoffRef.current = POLL_BASE_MS
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (!ticking) tick()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDaemon])

  // ─── task detail view ──────────────────────────────────────────────
  if (selectedDaemon) {
    return (
      <DaemonTasksView
        daemon={selectedDaemon}
        onBack={() => setSelectedDaemon(null)}
      />
    )
  }

  // ─── daemon list view ──────────────────────────────────────────────
  const filtered = daemons.filter((d) => {
    if (filter === 'all') return true
    if (filter === 'online') return d.status === 'online'
    return d.status !== 'online'
  })

  const onlineCount = daemons.filter((d) => d.status === 'online').length

  return (
    <div className="daemons-view">
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs" role="tablist" aria-label="daemon 状态">
          {DAEMON_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="cnt">
                {f.key === 'all' ? daemons.length : f.key === 'online' ? onlineCount : daemons.length - onlineCount}
              </span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="result-count">
          {filtered.length} / {daemons.length} 个 daemon
        </span>
        {stats ? (
          <span className="stat-item muted">
            <span className="status-dot dot-running" />
            <span className="stat-val mono">{stats.active_tasks}</span>
            活跃任务
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setShowRegister(true)}
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          注册 Daemon
        </button>
      </div>

      {showRegister ? (
        <RegisterDaemonDialog
          onClose={() => setShowRegister(false)}
          onRegistered={() => {
            setShowRegister(false)
            void reload()
          }}
        />
      ) : null}

      {/* ─── 本机 CLI（自动检测，inline 执行）─── */}
      <section className="local-cli-section" aria-label="本机 CLI">
        <div className="local-cli-head">
          <span className="local-cli-title">本机 CLI</span>
          <span className="local-cli-sub">
            Gateway 自动检测本机 PATH — 已安装的可直接在对话中使用（inline 执行，无需 daemon）
          </span>
          <div className="grow" />
          {!runtimesLoading && runtimes.length > 0 ? (
            <span className={`status ${runtimes.some((r) => r.available) ? 'running' : 'idle'}`}>
              <span className="dot" />
              {runtimes.filter((r) => r.available).length} 个可用
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="重新检测"
            aria-label="重新检测本机 CLI"
            onClick={() => {
              setRuntimesLoading(true)
              void loadRuntimes()
            }}
          >
            <Icon name="refresh" style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div className="local-cli-grid">
          {runtimesLoading && runtimes.length === 0 ? (
            <span className="local-cli-meta">检测中…</span>
          ) : (
            CLI_KINDS.map((m) => {
              const det = runtimes.find((r) => r.kind === m.kind)
              const available = det?.available ?? false
              return (
                <div
                  key={m.kind}
                  className={`local-cli-card${available ? '' : ' unavailable'}`}
                  title={available ? det?.path ?? m.hint : `未安装 — ${m.hint}`}
                >
                  <span className={`status-dot ${available ? 'dot-running' : 'dot-done'}`} />
                  <span className="local-cli-name">{m.label}</span>
                  <span className="local-cli-meta">
                    {available ? (det?.path ?? det?.binary ?? m.binary) : '未安装'}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* ─── 远程 daemon workers ─── */}
      <div className="daemons-subhead">
        <span className="daemons-subhead-title">远程 Daemon</span>
        <span className="daemons-subhead-sub">多机分发用的 worker 进程 — 启动后自动注册，靠心跳保持在线</span>
      </div>

      <div className="daemons-list">
        {loading && daemons.length === 0 ? (
          <SkeletonList rows={4} />
        ) : daemons.length === 0 ? (
          <div className="daemons-empty">
            <Icon name="info" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
            <span className="daemons-empty-title">没有已注册的 daemon</span>
            <span className="daemons-empty-desc">
              Daemon 是执行 Agent 任务的 worker 进程。启动一个 daemon 后它会自动注册到这里。
            </span>
            <div className="daemons-empty-hint">
              <span className="daemons-empty-hint-label">启动 daemon：</span>
              <code className="daemons-cmd">pnpm dev:daemon</code>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText('pnpm dev:daemon').catch(() => {})
                }}
              >
                <Icon name="copy" style={{ width: 14, height: 14 }} />
                复制
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="daemons-empty">
            <Icon name="check" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
            <span className="daemons-empty-title">当前过滤器下无 daemon</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setFilter('all')}
            >
              查看全部
            </button>
          </div>
        ) : (
          filtered.map((d, i) => (
            // div[role=button] instead of a real <button> — the delete control
            // inside is a button, and HTML forbids nested buttons (hydration error).
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              className="daemon-card enter-rise"
              style={{ '--enter-i': i } as React.CSSProperties}
              onClick={() => setSelectedDaemon(d)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedDaemon(d)
                }
              }}
            >
              <div className="daemon-card-icon">
                <span className={`status-dot ${DAEMON_STATUS_DOT[d.status] ?? 'dot-done'}`} />
                <Icon name="terminal" style={{ width: 20, height: 20, color: 'var(--fg-2)' }} />
              </div>

              <div className="daemon-card-body">
                <div className="daemon-card-head">
                  <span className="daemon-card-label">{d.label}</span>
                  <span className={`daemon-badge daemon-badge-${d.status}`}>
                    {DAEMON_STATUS_LABEL[d.status] ?? d.status}
                  </span>
                </div>
                <div className="daemon-card-meta">
                  {d.capabilities.map((c, idx) => (
                    <span key={idx} className="daemon-cap">
                      {c.agentType}
                    </span>
                  ))}
                  <span className="daemon-card-id mono">{d.id.slice(0, 8)}</span>
                  {d.endpoint ? (
                    <span className="daemon-card-endpoint">{d.endpoint}</span>
                  ) : null}
                </div>
              </div>

              <div className="daemon-card-right">
                <span className="daemon-card-heartbeat">
                  {timeAgo(d.last_heartbeat_at)}
                </span>
                <button
                  type="button"
                  className="daemon-card-delete"
                  title="删除"
                  aria-label={`删除 daemon ${d.label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteTarget(d)
                  }}
                >
                  <Icon name="close" style={{ width: 14, height: 14 }} />
                </button>
                <Icon name="chevronRight" style={{ width: 16, height: 16, color: 'var(--meta)' }} />
              </div>
            </div>
          ))
        )}
      </div>

      {error ? <div className="daemons-error">{error}</div> : null}

      {deleteTarget && (
        <div className="daemon-delete-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="daemon-delete-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="daemon-delete-title">删除 Daemon</div>
            <div className="daemon-delete-desc">
              确定要删除「{deleteTarget.label}」吗？此操作不可撤销。
            </div>
            <div className="daemon-delete-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  try {
                    const resp = await fetch(`/api/dispatch/daemons/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' })
                    if (resp.ok) {
                      setDaemons((prev) => prev.filter((d) => d.id !== deleteTarget.id))
                    }
                  } catch { /* silent */ }
                  setDeleteTarget(null)
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── task detail view (shown when a daemon is selected) ──────────────

const TASK_FILTERS: ReadonlyArray<{ key: DispatchTaskStatus | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'queued', label: '排队' },
  { key: 'running', label: '运行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
]

const TASK_STATUS_DOT: Record<string, string> = {
  running: 'dot-running',
  queued: 'dot-queued',
  done: 'dot-done',
  failed: 'dot-failed',
}

const TASK_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  queued: '排队',
  done: '已完成',
  failed: '失败',
}

function DaemonTasksView({
  daemon,
  onBack,
}: {
  daemon: DaemonInfo
  onBack: () => void
}): React.ReactElement {
  const [tasks, setTasks] = useState<DispatchTask[]>([])
  const [filter, setFilter] = useState<DispatchTaskStatus | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticking = false

    const load = async (): Promise<void> => {
      try {
        const statusFilter = filter === 'all' ? undefined : filter
        const t = await fetchDispatchTasks(statusFilter)
        if (cancelled) return
        setTasks(t)
        setLoading(false)
      } catch {
        if (cancelled) return
        setLoading(false)
      }
    }

    const tick = (): void => {
      if (cancelled || ticking) return
      ticking = true
      void load().finally(() => {
        ticking = false
        if (cancelled) return
        timer = setTimeout(tick, POLL_BASE_MS)
      })
    }

    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [filter])

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null
  const running = tasks.filter((t) => t.status === 'running').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const failed = tasks.filter((t) => t.status === 'failed').length

  return (
    <div className="daemons-view">
      {/* back + daemon header */}
      <div className="daemon-detail-header">
        <button type="button" className="btn btn-ghost btn-sm daemon-back-btn" onClick={onBack}>
          <Icon name="arrow" style={{ width: 14, height: 14, transform: 'rotate(180deg)' }} />
          返回
        </button>
        <span className={`status-dot ${DAEMON_STATUS_DOT[daemon.status] ?? 'dot-done'}`} />
        <span className="daemon-detail-title">{daemon.label}</span>
        <span className={`daemon-badge daemon-badge-${daemon.status}`}>
          {DAEMON_STATUS_LABEL[daemon.status] ?? daemon.status}
        </span>
        <span className="daemon-card-id mono">{daemon.id.slice(0, 8)}</span>
      </div>

      {/* task filter tabs */}
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs" role="tablist" aria-label="任务状态">
          {TASK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="cnt">
                {f.key === 'all' ? tasks.length
                  : f.key === 'running' ? running
                  : f.key === 'queued' ? queued
                  : f.key === 'failed' ? failed
                  : 0}
              </span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="result-count">
          {tasks.length} 个任务
        </span>
      </div>

      {/* two-column: queue + detail */}
      <div className="daemons-grid">
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
              tasks.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  className={`daemons-task-card enter-rise${selectedTaskId === t.id ? ' selected' : ''}`}
                  style={{ '--enter-i': i } as React.CSSProperties}
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <div className="task-card-top">
                    <span className={`status-dot ${TASK_STATUS_DOT[t.status] ?? ''}`} />
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
            <div className="daemons-detail-empty">
              <Icon name="info" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
              <span className="daemons-empty-title">
                {tasks.length === 0 ? '暂无任务' : '选择左侧任务查看详情'}
              </span>
              <span className="daemons-empty-desc">
                {tasks.length === 0
                  ? '任务由 Agent / Flow 运行时自动派发到此队列。'
                  : '点击队列中的任务卡片查看时间线、任务信息和日志。'}
              </span>
            </div>
          ) : (
            <div className="daemons-detail-body">
              <div className="detail-head">
                <div className="detail-head-left">
                  <span className={`status-dot ${TASK_STATUS_DOT[selectedTask.status] ?? ''}`} />
                  <span className="detail-id mono">{selectedTask.id.slice(0, 8)}</span>
                  <span className={`detail-status ${selectedTask.status}`}>
                    {TASK_STATUS_LABEL[selectedTask.status] ?? selectedTask.status}
                  </span>
                </div>
                <span className="detail-type">{selectedTask.type}</span>
              </div>

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
    </div>
  )
}

// ─── register daemon dialog ─────────────────────────────────────────

/**
 * Daemon 启动命令生成器。
 *
 * daemon 进程是自注册的：`mil-daemon <serverUrl> <label> <agentType>` 启动后
 * 自己 POST /daemons/register 注册并心跳，无需提前在页面上注册（旧版对话框
 * 预注册拿 daemonId/token 再拼进启动命令是错的 — CLI 不接受这些参数）。
 *
 * 对话框只做一件事：根据用户填的 label + agent 类型生成正确的启动命令，
 * 复制到任意机器的 dagents 仓库根目录运行即可。
 */
const AGENT_TYPE_OPTIONS = [
  'claude', 'codex', 'copilot', 'qwen', 'opencode',
  'codebuddy', 'cursor', 'deveco', 'antigravity', 'openclaw',
  'pi', 'hermes', 'kimi', 'kiro', 'grok', 'qoder', 'traecli',
]

function RegisterDaemonDialog({
  onClose,
  onRegistered,
}: {
  onClose: () => void
  onRegistered: () => void
}): React.ReactElement {
  const [label, setLabel] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cmds, setCmds] = useState<string[] | null>(null)

  function toggleType(t: string): void {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    )
  }

  function handleGenerate(): void {
    setError(null)
    if (!label.trim()) {
      setError('请填写 daemon 标签')
      return
    }
    if (selectedTypes.length === 0) {
      setError('请至少选择一种 agent 类型')
      return
    }
    // CLI 一次只接受一种 agentType — 每种类型生成一条命令。
    setCmds(selectedTypes.map((t) => `pnpm --filter @dagents/daemon dev -- http://localhost:8080 ${label.trim()} ${t}`))
  }

  // Generated view — show the correct start commands
  if (cmds) {
    return createPortal(
      <div className="daemon-dialog-overlay" onClick={onClose}>
        <div className="daemon-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="daemon-dialog-header">
            <Icon name="check" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
            <span className="daemon-dialog-title">启动命令已生成</span>
          </div>
          <div className="daemon-dialog-body">
            <p className="daemon-dialog-desc">
              复制以下命令到目标机器的 dagents 仓库根目录运行。daemon 启动后会自动注册并出现在列表中（无需提前注册）：
            </p>
            {cmds.map((cmd) => (
              <div key={cmd} className="daemon-dialog-cmd-row">
                <code className="daemon-dialog-cmd">{cmd}</code>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigator.clipboard?.writeText(cmd).catch(() => {})}
                >
                  <Icon name="copy" style={{ width: 14, height: 14 }} />
                  复制
                </button>
              </div>
            ))}
            {cmds.length > 1 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigator.clipboard?.writeText(cmds.join('\n')).catch(() => {})}
              >
                <Icon name="copy" style={{ width: 14, height: 14 }} />
                全部复制
              </button>
            ) : null}
            <div className="daemon-dialog-info">
              <div className="meta-row">
                <span className="meta-label">标签</span>
                <span className="mono">{label.trim()}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Agent 类型</span>
                <span className="mono">{selectedTypes.join(', ')}</span>
              </div>
            </div>
          </div>
          <div className="daemon-dialog-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCmds(null)}>
              返回修改
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onRegistered}>
              完成
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  // Form view
  return createPortal(
    <div className="daemon-dialog-overlay" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="daemon-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="daemon-dialog-header">
          <Icon name="terminal" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
          <span className="daemon-dialog-title">注册 Daemon</span>
          <button type="button" className="btn btn-ghost btn-sm daemon-dialog-close" onClick={onClose}>
            <Icon name="close" style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <div className="daemon-dialog-body">
          <div className="daemon-dialog-field">
            <label className="daemon-dialog-label">名称</label>
            <input
              type="text"
              className="daemon-dialog-input"
              placeholder="如：dev-laptop"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="daemon-dialog-field">
            <label className="daemon-dialog-label">Agent 类型</label>
            <div className="daemon-dialog-chips">
              {AGENT_TYPE_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`daemon-dialog-chip${selectedTypes.includes(t) ? ' selected' : ''}`}
                  onClick={() => toggleType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <span className="daemon-dialog-hint">可多选 — 每种类型生成一条启动命令（一个 daemon 进程对应一种 agent）</span>
          </div>
          {error ? <div className="daemon-dialog-error">⚠️ {error}</div> : null}
        </div>
        <div className="daemon-dialog-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleGenerate}
          >
            生成启动命令
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── empty-state skeleton ─────────────────────────────────────────────
// (removed — replaced by inline empty state in detail panel)
