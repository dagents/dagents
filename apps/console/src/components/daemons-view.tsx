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
import { useI18n } from '@/i18n'
import { timeAgo, formatClock, formatClockSeconds } from '@/lib/format'
import '@/styles/daemons.css'

// ─── local CLI runtimes (auto-detected) ──────────────────────────────

/** One row of the gateway's GET /api/v1/cli-runtimes PATH scan. */
interface RuntimeDetection {
  kind: string
  binary: string
  available: boolean
  path: string | null
  /** Maintenance tier (方案 E): core / community + regression status. */
  tier?: { tier: string; regression: string; note?: string }
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

/** PX-D01：状态降为「点+词」—— 统一走 shell 的 .status 家族
 *  （online/offline/draining 均有对应 dot 配色），去彩色底徽章。 */
const DAEMON_STATUS_CLASS: Record<string, string> = {
  online: 'online',
  offline: 'offline',
  draining: 'draining',
}

/** Base poll interval (ms) when healthy and tab visible. */
const POLL_BASE_MS = 5000
/** Cap for exponential backoff when polls keep failing. */
const POLL_MAX_BACKOFF_MS = 60_000


export function DaemonsView(): React.ReactElement {
  const { t } = useI18n()
  const [daemons, setDaemons] = useState<DaemonInfo[]>([])
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [filter, setFilter] = useState<DaemonFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDaemon, setSelectedDaemon] = useState<DaemonInfo | null>(null)
  const [showRegister, setShowRegister] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DaemonInfo | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [runtimes, setRuntimes] = useState<RuntimeDetection[]>([])
  const [runtimesLoading, setRuntimesLoading] = useState(true)
  // Detection failure must NOT render as「未安装」— that would send the user
  // off to install CLIs they already have.
  const [runtimesError, setRuntimesError] = useState<string | null>(null)

  // Local CLI detection (gateway scans PATH). Once on mount + manual refresh —
  // unlike daemons this doesn't change on its own, no polling needed.
  const loadRuntimes = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch('/api/cli-runtimes')
      const json = (await resp.json()) as { success: boolean; data?: { runtimes: RuntimeDetection[] } }
      if (json.success && json.data) {
        setRuntimes(json.data.runtimes)
        setRuntimesError(null)
      } else {
        setRuntimesError(`HTTP ${resp.status}`)
      }
    } catch (err) {
      setRuntimesError(err instanceof Error ? err.message : String(err))
    } finally {
      setRuntimesLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuntimes() }, [loadRuntimes])

  const backoffRef = useRef<number>(POLL_BASE_MS)
  const isVisibleRef = useRef<boolean>(true)
  const isInitialRef = useRef<boolean>(true)
  // While the task view is mounted the parent list doesn't need polling —
  // this ref lets the poll loop stand down without restarting on every
  // selectedDaemon change.
  const taskViewOpenRef = useRef(false)
  taskViewOpenRef.current = selectedDaemon != null

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [d, s] = await Promise.all([
        fetchDaemons(),
        fetchFleetStats().catch(() => null),
      ])
      setDaemons(d)
      if (s) setStats(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticking = false

    const load = async (): Promise<void> => {
      if (!isVisibleRef.current) return
      if (taskViewOpenRef.current) return // task view owns the screen + its own poll
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
  }, [])

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
    // draining（排空中）不是离线 — 它仍连着网关
    return d.status !== 'online' && d.status !== 'draining'
  })

  const onlineCount = daemons.filter((d) => d.status === 'online').length
  const drainingCount = daemons.filter((d) => d.status === 'draining').length

  return (
    <div className="daemons-view">
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs" role="tablist" aria-label={t('daemon 状态')}>
          {DAEMON_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {t(f.label)}
              <span className="cnt">
                {f.key === 'all' ? daemons.length : f.key === 'online' ? onlineCount : daemons.length - onlineCount - drainingCount}
              </span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="result-count">
          {t('{n} / {total} 个 daemon', { n: filtered.length, total: daemons.length })}
        </span>
        {stats ? (
          <span className="stat-item muted">
            <span className="status-dot dot-running" />
            <span className="stat-val mono">{stats.active_tasks}</span>
            {t('活跃任务')}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setShowRegister(true)}
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          {t('注册 Daemon')}
        </button>
      </div>

      {error ? (
        <div className="daemons-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <span>{t('加载失败：{error}', { error })}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()}>
            {t('重试')}
          </button>
        </div>
      ) : null}

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
      <section className="local-cli-section" aria-label={t('本机 CLI')}>
        <div className="local-cli-head">
          <span className="local-cli-title">{t('本机 CLI')}</span>
          <span className="local-cli-sub">
            {t('Gateway 自动检测本机 PATH — 已安装的可直接在对话中使用（inline 执行，无需 daemon）')}
          </span>
          <div className="grow" />
          {!runtimesLoading && runtimes.length > 0 ? (
            <span className={`status ${runtimes.some((r) => r.available) ? 'running' : 'idle'}`}>
              <span className="dot" />
              {t('{n} 个可用', { n: runtimes.filter((r) => r.available).length })}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title={t('重新检测')}
            aria-label={t('重新检测本机 CLI')}
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
            <span className="local-cli-meta">{t('检测中…')}</span>
          ) : runtimesError && runtimes.length === 0 ? (
            <div className="daemons-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%' }}>
              <span>{t('CLI 检测失败：{error} — 下方「未安装」状态不可信', { error: runtimesError })}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRuntimesLoading(true); void loadRuntimes() }}>
                {t('重试')}
              </button>
            </div>
          ) : (
            CLI_KINDS.map((m) => {
              const det = runtimes.find((r) => r.kind === m.kind)
              const available = det?.available ?? false
              const isCore = det?.tier?.tier === 'core'
              const untested = det?.tier?.regression === 'docs-only'
              // tier.note 来自网关 tiers.ts 的中文单源 —— 按自然键 i18n 惯例
              // 包 t()：zh 显示原文，en 走词典（此前 EN 模式下中英混排）。
              const tierTitle = det?.tier?.note
                ? t(det.tier.note)
                : untested
                  ? t('社区适配器 — 按官方文档实现，未经真机回归')
                  : undefined
              return (
                <div
                  key={m.kind}
                  className={`local-cli-card${available ? '' : ' unavailable'}`}
                  title={[
                    available ? det?.path ?? m.hint : t('未安装 — {hint}', { hint: t(m.hint) }),
                    tierTitle,
                  ].filter(Boolean).join('\n')}
                >
                  <span className={`status-dot ${available ? 'dot-running' : 'dot-done'}`} />
                  <span className="local-cli-name">{m.label}</span>
                  {isCore && <span className="local-cli-core-badge">{t('核心')}</span>}
                  <span className="local-cli-meta">
                    {available ? (det?.path ?? det?.binary ?? m.binary) : t('未安装')}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* ─── 远程 daemon workers ─── */}
      <div className="daemons-subhead">
        <span className="daemons-subhead-title">{t('远程 Daemon')}</span>
        <span className="daemons-subhead-sub">{t('多机分发用的 worker 进程 — 启动后自动注册，靠心跳保持在线')}</span>
      </div>

      <div className="daemons-list">
        {loading && daemons.length === 0 ? (
          <SkeletonList rows={4} />
        ) : error ? null : daemons.length === 0 ? (
          <div className="daemons-empty">
            <Icon name="info" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
            <span className="daemons-empty-title">{t('没有已注册的 daemon')}</span>
            <span className="daemons-empty-desc">
              {t('Daemon 是执行 Agent 任务的 worker 进程。启动一个 daemon 后它会自动注册到这里。')}
            </span>
            <div className="daemons-empty-hint">
              <span className="daemons-empty-hint-label">{t('启动 daemon：')}</span>
              <code className="daemons-cmd">pnpm dev:daemon</code>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText('pnpm dev:daemon').catch(() => {})
                }}
              >
                <Icon name="copy" style={{ width: 14, height: 14 }} />
                {t('复制')}
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="daemons-empty">
            <Icon name="check" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
            <span className="daemons-empty-title">{t('当前过滤器下无 daemon')}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setFilter('all')}
            >
              {t('查看全部')}
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
                  <span className={`status ${DAEMON_STATUS_CLASS[d.status] ?? 'idle'}`}>
                    <span className="dot" />
                    {t(DAEMON_STATUS_LABEL[d.status] ?? d.status)}
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
                  {timeAgo(d.last_heartbeat_at, t)}
                </span>
                <button
                  type="button"
                  className="daemon-card-delete"
                  title={t('删除')}
                  aria-label={t('删除 daemon {label}', { label: d.label })}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteError(null)
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

      {deleteTarget && (
        <div
          className="daemon-delete-overlay"
          onClick={() => { if (!deleting) setDeleteTarget(null) }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !deleting) setDeleteTarget(null) }}
        >
          <div
            className="daemon-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('删除 Daemon')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="daemon-delete-title">{t('删除 Daemon')}</div>
            <div className="daemon-delete-desc">
              {t('确定要删除「{name}」吗？此操作不可撤销。', { name: deleteTarget.label })}
            </div>
            {deleteError ? <div className="daemon-dialog-error" role="alert">{deleteError}</div> : null}
            <div className="daemon-delete-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={deleting}
                ref={(el) => {
                  if (el && !el.dataset.focused) {
                    el.dataset.focused = '1'
                    el.focus()
                  }
                }}
                onClick={() => setDeleteTarget(null)}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true)
                  setDeleteError(null)
                  try {
                    const resp = await fetch(`/api/dispatch/daemons/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' })
                    if (resp.ok) {
                      // 仅在删除成功后更新列表，失败时保留原列表并提示；
                      // stats（在线数/活跃任务）一并刷新，避免页头计数失真
                      setDaemons((prev) => prev.filter((d) => d.id !== deleteTarget.id))
                      setDeleteTarget(null)
                      void reload()
                    } else {
                      const body = (await resp.json().catch(() => null)) as { error?: string } | null
                      setDeleteError(body?.error
                        ? t('删除失败（{status}）：{msg}', { status: resp.status, msg: body.error })
                        : t('删除失败（{status}）', { status: resp.status }))
                    }
                  } catch (err) {
                    setDeleteError(err instanceof Error ? err.message : String(err))
                  } finally {
                    setDeleting(false)
                  }
                }}
              >
                {t('确认删除')}
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

/** shell .status 家族的类名映射（任务状态 → .status.*） */
const TASK_STATUS_CLASS: Record<string, string> = {
  running: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
}

// ─── task events (real, from dispatch_task_events) ────────────────────

/** One row of the gateway's GET /api/v1/dispatch/tasks/:id/events. */
interface TaskEvent {
  seq: number
  kind: string
  payload: unknown
  created_at: string | null
}

/** 事件 payload 摘要：message 类型且有 content 时展示文本，否则截断 JSON。 */
function summarizeEventPayload(payload: unknown): string {
  if (
    payload != null && typeof payload === 'object' &&
    'content' in payload && typeof (payload as { content: unknown }).content === 'string'
  ) {
    return (payload as { content: string }).content
  }
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    text = String(payload)
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// ─── PX-D02：任务事件流的结构化渲染 ─────────────────────────────
// 旧版是整块 <pre> 文本（时间戳变长导致起点漂移、错误行无图标、重复行刷屏）。
// 渲染层做两件事：连续同类（kind + 摘要一致）事件折叠为一行 +「…重复 N 次」；
// 错误行（kind 含 err/fail）前置 12px ⚠ danger 图标。数据原样，仅展示折叠。

/** 折叠后的一组连续同类事件。 */
interface EventGroup {
  /** 组内首条（kind + 摘要代表整组）。 */
  ev: TaskEvent
  /** 组内条数（≥2 时显示「…重复 N 次」）。 */
  count: number
  /** 组内最后一条的时间（时间列显示它，最近的活性可见）。 */
  lastAt: string | null
}

/** 连续同类（kind + payload 摘要一致）事件折叠。 */
function groupEvents(events: TaskEvent[]): EventGroup[] {
  const groups: EventGroup[] = []
  for (const ev of events) {
    const prev = groups[groups.length - 1]
    if (prev && prev.ev.kind === ev.kind && summarizeEventPayload(prev.ev.payload) === summarizeEventPayload(ev.payload)) {
      prev.count += 1
      prev.lastAt = ev.created_at
    } else {
      groups.push({ ev, count: 1, lastAt: ev.created_at })
    }
  }
  return groups
}

/** 错误类事件判定：kind 含 err/fail（dispatch 事件流用 'error'/'failed'）。 */
function isErrorEventKind(kind: string): boolean {
  return /err|fail/i.test(kind)
}

function DaemonTasksView({
  daemon,
  onBack,
}: {
  daemon: DaemonInfo
  onBack: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<DispatchTask[]>([])
  const [filter, setFilter] = useState<DispatchTaskStatus | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskEvents, setTaskEvents] = useState<TaskEvent[] | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)

  // 选中任务变化时拉取真实的 dispatch_task_events（替换旧的伪造日志面板）
  useEffect(() => {
    if (!selectedTaskId) {
      setTaskEvents(null)
      return
    }
    let cancelled = false
    setEventsLoading(true)
    setTaskEvents(null)
    fetch(`/api/dispatch/tasks/${encodeURIComponent(selectedTaskId)}/events`, { cache: 'no-store' })
      .then(async (resp) => {
        const body = (await resp.json().catch(() => null)) as
          | { success: boolean; data?: { events: TaskEvent[] } }
          | null
        if (cancelled) return
        if (resp.ok && body?.success && body.data) setTaskEvents(body.data.events)
        else setTaskEvents([])
      })
      .catch(() => {
        if (!cancelled) setTaskEvents([])
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedTaskId])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticking = false
    let visible = true

    const onVisibility = (): void => {
      const wasHidden = !visible
      visible = document.visibilityState === 'visible'
      if (wasHidden && visible && !cancelled && !ticking) {
        if (timer) { clearTimeout(timer); timer = null }
        tick()
      }
    }

    const load = async (): Promise<void> => {
      if (!visible) return
      try {
        const statusFilter = filter === 'all' ? undefined : filter
        const t = await fetchDispatchTasks(statusFilter)
        if (cancelled) return
        setTasks(t)
        setTasksError(null)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        // A gateway failure must surface — an empty-state here reads as
        // 「暂无派发任务」which is a lie.
        setTasksError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    }

    const tick = (): void => {
      if (cancelled || ticking) return
      ticking = true
      void load().finally(() => {
        ticking = false
        if (cancelled || !visible) return
        timer = setTimeout(tick, POLL_BASE_MS)
      })
    }

    tick()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [filter])

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null
  const running = tasks.filter((t) => t.status === 'running').length
  const queued = tasks.filter((t) => t.status === 'queued').length
  const failed = tasks.filter((t) => t.status === 'failed').length
  const done = tasks.filter((t) => t.status === 'done').length

  return (
    <div className="daemons-view">
      {/* back + daemon header */}
      <div className="daemon-detail-header">
        <button type="button" className="btn btn-ghost btn-sm daemon-back-btn" onClick={onBack}>
          <Icon name="arrow" style={{ width: 14, height: 14, transform: 'rotate(180deg)' }} />
          {t('返回')}
        </button>
        <span className={`status-dot ${DAEMON_STATUS_DOT[daemon.status] ?? 'dot-done'}`} />
        <span className="daemon-detail-title">{daemon.label}</span>
        <span className={`status ${DAEMON_STATUS_CLASS[daemon.status] ?? 'idle'}`}>
          <span className="dot" />
          {t(DAEMON_STATUS_LABEL[daemon.status] ?? daemon.status)}
        </span>
        <span className="daemon-card-id mono">{daemon.id.slice(0, 8)}</span>
      </div>

      {/* task filter tabs */}
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs" role="tablist" aria-label={t('任务状态')}>
          {TASK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {t(f.label)}
              <span className="cnt">
                {f.key === 'all' ? tasks.length
                  : f.key === 'running' ? running
                  : f.key === 'queued' ? queued
                  : f.key === 'failed' ? failed
                  : done}
              </span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="result-count">
          {t('{n} 个任务', { n: tasks.length })}
        </span>
      </div>

      {/* two-column: queue + detail */}
      <div className="daemons-grid">
        <div className="daemons-queue">
          <div className="daemons-queue-head">
            {/* fetchDispatchTasks 是全局队列（/api/agents 投影，无 daemon 维度）——
                如实命名，不冒充「该 daemon 的队列」 */}
            <span title={t('当前为全平台任务视图，暂无按 daemon 过滤')}>{t('任务队列（全局）')}</span>
            <span className="daemons-count mono">{tasks.length}</span>
          </div>
          {tasksError ? (
            <div className="daemons-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', margin: '0 0 var(--space-2)' }}>
              <span>{t('任务加载失败：{error}', { error: tasksError })}</span>
            </div>
          ) : null}
          <div className="daemons-queue-list">
            {loading && tasks.length === 0 ? (
              <div className="daemons-empty">
                <Icon name="loader" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
                <span>{t('加载中…')}</span>
              </div>
            ) : tasks.length === 0 && !tasksError ? (
              <div className="daemons-empty">
                <Icon
                  name={filter === 'all' ? 'info' : 'check'}
                  style={{ width: 28, height: 28, color: 'var(--meta)' }}
                />
                <span className="daemons-empty-title">
                  {filter === 'all' ? t('暂无派发任务') : t('当前过滤器下无任务')}
                </span>
                <span className="daemons-empty-desc">
                  {filter === 'all'
                    ? t('任务由 Agent / Flow 运行时自动派发到此队列。')
                    : t('尝试切换到「全部」查看所有任务。')}
                </span>
                {filter !== 'all' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setFilter('all')}
                  >
                    {t('查看全部任务')}
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
                    {/* priority 仅在后端真实提供时展示（>0），否则不渲染 */}
                    {t.priority > 0 ? <span className="task-priority mono">P{t.priority}</span> : null}
                  </div>
                  <div className="task-card-desc">{t.description ?? t.id.slice(0, 8)}</div>
                  <div className="task-card-meta">
                    {t.flow_id ? <span className="mono">{t.flow_id.slice(0, 8)}</span> : null}
                    <span>{formatClock(t.created_at)}</span>
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
                {tasks.length === 0 ? t('暂无任务') : t('选择左侧任务查看详情')}
              </span>
              <span className="daemons-empty-desc">
                {tasks.length === 0
                  ? t('任务由 Agent / Flow 运行时自动派发到此队列。')
                  : t('点击队列中的任务卡片查看时间线、任务信息和任务事件。')}
              </span>
            </div>
          ) : (
            <div className="daemons-detail-body">
              <div className="detail-head">
                <div className="detail-head-left">
                  <span className={`status-dot ${TASK_STATUS_DOT[selectedTask.status] ?? ''}`} />
                  <span className="detail-id mono">{selectedTask.id.slice(0, 8)}</span>
                  <span className={`status ${TASK_STATUS_CLASS[selectedTask.status] ?? 'idle'}`}>
                    <span className="dot" />
                    {t(TASK_STATUS_LABEL[selectedTask.status] ?? selectedTask.status)}
                  </span>
                </div>
                <span className="detail-type">{selectedTask.type}</span>
              </div>

              <div className="detail-section">
                <div className="detail-section-head">{t('时间线')}</div>
                <div className="detail-timeline">
                  <div className={`timeline-step ${selectedTask.status === 'done' ? 'done' : selectedTask.status === 'running' ? 'running' : 'queued'}`}>
                    <span className="timeline-dot" />
                    <span className="timeline-label">{t('任务创建')}</span>
                    <span className="timeline-time mono">{new Date(selectedTask.created_at).toLocaleString()}</span>
                  </div>
                  <div className={`timeline-step ${selectedTask.status === 'running' ? 'running' : selectedTask.status === 'done' || selectedTask.status === 'failed' ? 'done' : 'queued'}`}>
                    <span className="timeline-dot" />
                    <span className="timeline-label">{t('派发到 daemon')}</span>
                  </div>
                  <div className={`timeline-step ${selectedTask.status === 'done' ? 'done' : selectedTask.status === 'failed' ? 'failed' : 'queued'}`}>
                    <span className="timeline-dot" />
                    <span className="timeline-label">{selectedTask.status === 'failed' ? t('执行失败') : t('执行完成')}</span>
                    {selectedTask.updated_at !== selectedTask.created_at ? (
                      <span className="timeline-time mono">{new Date(selectedTask.updated_at).toLocaleString()}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <div className="detail-section-head">{t('任务信息')}</div>
                <div className="detail-meta">
                  <div className="meta-row">
                    <span className="meta-label">{t('优先级')}</span>
                    <span className="mono">{selectedTask.priority > 0 ? `P${selectedTask.priority}` : '—'}</span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">Flow ID</span>
                    <span className="mono">{selectedTask.flow_id ?? '—'}</span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">{t('描述')}</span>
                    <span>{selectedTask.description ?? '—'}</span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <div className="detail-section-head">{t('任务事件')}</div>
                <div className="detail-logs">
                  {eventsLoading ? (
                    <div className="daemons-empty">
                      <Icon name="loader" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
                      <span>{t('加载中…')}</span>
                    </div>
                  ) : !taskEvents || taskEvents.length === 0 ? (
                    <div className="daemons-empty">
                      <Icon name="info" style={{ width: 28, height: 28, color: 'var(--meta)' }} />
                      <span className="daemons-empty-title">{t('暂无事件记录')}</span>
                    </div>
                  ) : (
                    /* PX-D02：时间列固定 72px 右对齐 tabular（mono）——
                       50 条事件文本起点对齐一条竖线；错误行 ⚠ 图标；
                       连续同类折叠「…重复 N 次」。 */
                    <div className="evt-list" role="log">
                      {groupEvents(taskEvents).map((g) => {
                        const error = isErrorEventKind(g.ev.kind)
                        return (
                          <div
                            key={g.ev.seq}
                            className={`evt-row${error ? ' evt-error' : ''}`}
                            title={g.count > 1 ? t('连续 {n} 条同类事件已折叠', { n: g.count }) : undefined}
                          >
                            <span className="evt-time mono">
                              {g.lastAt ? formatClockSeconds(g.lastAt) : '—'}
                            </span>
                            {/* 槽位常驻（非错误行留空 12px）—— 消息正文起点全行对齐 */}
                            <span className="evt-warn-slot">
                              {error ? (
                                <Icon name="alertTriangle" className="evt-warn" style={{ width: 12, height: 12 }} />
                              ) : null}
                            </span>
                            <span className="evt-kind mono">{g.ev.kind}</span>
                            <span className="evt-msg">{summarizeEventPayload(g.ev.payload)}</span>
                            {g.count > 1 ? (
                              <span className="evt-repeat">…{t('重复 {n} 次', { n: g.count })}</span>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
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
/** Agent 类型选项从共享目录派生（此前手抄 17 项，随时漂移）。 */
const AGENT_TYPE_OPTIONS = CLI_KINDS

/**
 * daemon 启动命令里的网关地址：本机访问就是默认 8080；从其他机器访问
 * console 时用当前 hostname 推导（此前硬编码 localhost，复制到远程机器
 * 的命令永远连不上网关）。
 */
function gatewayUrlForCommand(): string {
  if (typeof window === 'undefined') return 'http://localhost:8080'
  return window.location.hostname === 'localhost'
    ? 'http://localhost:8080'
    : `http://${window.location.hostname}:8080`
}

function RegisterDaemonDialog({
  onClose,
  onRegistered,
}: {
  onClose: () => void
  onRegistered: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [label, setLabel] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cmds, setCmds] = useState<string[] | null>(null)
  // 「已复制」确认 — 复制按钮此前点了毫无反馈。
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = (text: string, key: string): void => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(key),
      () => {},
    )
  }

  // Escape closes (document-level — the overlay never has focus, so an
  // overlay onKeyDown handler never fires).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleType(t: string): void {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    )
  }

  function handleGenerate(): void {
    setError(null)
    if (!label.trim()) {
      setError(t('请填写 daemon 标签'))
      return
    }
    if (selectedTypes.length === 0) {
      setError(t('请至少选择一种 agent 类型'))
      return
    }
    // CLI 一次只接受一种 agentType — 每种类型生成一条命令。
    const base = gatewayUrlForCommand()
    setCmds(selectedTypes.map((k) => `pnpm --filter @dagents/daemon dev -- ${base} ${label.trim()} ${k}`))
  }

  // Generated view — show the correct start commands
  if (cmds) {
    return createPortal(
      <div className="daemon-dialog-overlay" onClick={onClose}>
        <div
          className="daemon-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('启动命令已生成')}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="daemon-dialog-header">
            <Icon name="check" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
            <span className="daemon-dialog-title">{t('启动命令已生成')}</span>
          </div>
          <div className="daemon-dialog-body">
            <p className="daemon-dialog-desc">
              {t('复制以下命令到目标机器的 dagents 仓库根目录运行。daemon 启动后会自动注册并出现在列表中（无需提前注册）：')}
            </p>
            {cmds.map((cmd) => (
              <div key={cmd} className="daemon-dialog-cmd-row">
                <code className="daemon-dialog-cmd">{cmd}</code>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => copy(cmd, cmd)}
                >
                  <Icon name={copied === cmd ? 'check' : 'copy'} style={{ width: 14, height: 14 }} />
                  {copied === cmd ? t('已复制') : t('复制')}
                </button>
              </div>
            ))}
            {cmds.length > 1 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => copy(cmds.join('\n'), '__all__')}
              >
                <Icon name={copied === '__all__' ? 'check' : 'copy'} style={{ width: 14, height: 14 }} />
                {copied === '__all__' ? t('已复制') : t('全部复制')}
              </button>
            ) : null}
            <div className="daemon-dialog-info">
              <div className="meta-row">
                <span className="meta-label">{t('标签')}</span>
                <span className="mono">{label.trim()}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">{t('Agent 类型')}</span>
                <span className="mono">{selectedTypes.join(', ')}</span>
              </div>
            </div>
          </div>
          <div className="daemon-dialog-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCmds(null)}>
              {t('返回修改')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onRegistered}>
              {t('完成')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  // Form view
  return createPortal(
    <div className="daemon-dialog-overlay" onClick={onClose}>
      <div
        className="daemon-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('注册 Daemon')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="daemon-dialog-header">
          <Icon name="terminal" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
          <span className="daemon-dialog-title">{t('注册 Daemon')}</span>
          <button type="button" className="btn btn-ghost btn-sm daemon-dialog-close" onClick={onClose}>
            <Icon name="close" style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <div className="daemon-dialog-body">
          <div className="daemon-dialog-field">
            <label className="daemon-dialog-label" htmlFor="daemon-label">{t('名称')}</label>
            <input
              id="daemon-label"
              type="text"
              className="daemon-dialog-input"
              placeholder={t('如：dev-laptop')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="daemon-dialog-field">
            <span className="daemon-dialog-label" id="daemon-agent-types-label">{t('Agent 类型')}</span>
            <div className="daemon-dialog-chips" role="group" aria-labelledby="daemon-agent-types-label">
              {AGENT_TYPE_OPTIONS.map((m) => (
                <button
                  key={m.kind}
                  type="button"
                  className={`daemon-dialog-chip${selectedTypes.includes(m.kind) ? ' selected' : ''}`}
                  title={t(m.hint)}
                  onClick={() => toggleType(m.kind)}
                >
                  {t(m.label)}
                </button>
              ))}
            </div>
            <span className="daemon-dialog-hint">{t('可多选 — 每种类型生成一条启动命令（一个 daemon 进程对应一种 agent）')}</span>
          </div>
          {error ? <div className="daemon-dialog-error" role="alert">{error}</div> : null}
        </div>
        <div className="daemon-dialog-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleGenerate}
          >
            {t('生成启动命令')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── empty-state skeleton ─────────────────────────────────────────────
// (removed — replaced by inline empty state in detail panel)
