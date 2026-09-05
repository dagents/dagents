'use client'

/**
 * AgentDetailView — agent-detail 左右分栏 + 4 tabs (v0.3-M4.1, audit §3).
 *
 * Ports design/agent-detail.html (354 lines) to React. The design read its
 * data from a static `window.OD_AGENTS` fixture keyed by `?id=`; the console
 * binds to the live agents catalogue (`fetchAgentDetail` +
 * `fetchAgentLogs`, the same endpoints the M5a.2 drawer used). The page model
 * is derived purely in `lib/agent-detail.ts:derivePageModel`.
 *
 * ## Layout (design agent-detail.html:117-139)
 *
 * `.detail-layout` = CSS grid `320px minmax(0,1fr)`. Left `.inspector` (sticky;
 *  ≤1024px collapses to a stacked single column): identity head (kind-colored
 *  avatar + name + summary + live-presence availability pill), 属性 prop-rows
 *  (Agent ID / 类型 / 模型 / 运行时 / 并发 / 可见性 / 负责人 / 创建于), Skills
 *  chip rail, 当前任务 (run id + progress bar + elapsed + %). Right `.overview`
 *  = `role="tablist"` 4 tabs — Activity (default) / Instructions / Skills /
 *  Logs — with `.tab-body` swapping on click + keyboard ArrowLeft/Right/Home/
 *  End (design agent-detail.html:327-337), `aria-selected`/`tabindex` roving.
 *
 * ## Backend-contract honesty
 *
 * docs/v0.3-fidelity-audit.md §后端契约 1 lists `model` / `owner` /
 * `concurrency` / `instructions` / `progress` / `activity` as missing from
 * the dispatch `GET /agents/:id` payload (pinned to M9). The view derives
 * what it can from the real payload and renders honest `—` /
 * `（未设置提示词）` fallbacks for the rest (see `derivePageModel`) rather than
 * fabricating the design's sample values. The layout + tabs + sparkline render
 * against the real payload today; swapping the M9 fields in later only changes
 * the fallbacks.
 *
 * ## Testing seam
 *
 * The component takes an optional `nowMs` (default `Date.now()`) so the
 * 30-bucket activity derivation is deterministic under test. The fetch
 * behavior mirrors `AgentDrawer`'s: mount → Promise.all(detail, logs),
 * best-effort `cancelled` guard, loading skeleton, error card, not-found.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type AgentLogLine,
  fetchAgentDetail,
  fetchAgentLogs,
  type AgentDetail,
} from '@/lib/agents-catalog'
import {
  derivePageModel,
  availabilityClass,
  availabilityLabel,
  availabilityToDaemonStatus,
  sumBuckets,
  type AgentDetailPageModel,
} from '@/lib/agent-detail'
import { AgentActivitySparkline } from '@/components/agent-activity-sparkline'
import { useWsFrame } from '@/lib/ws-client'
import { kindLabel, AGENT_STATUS_LABEL } from '@/lib/agents-catalog'
import { fetchSkills, type SkillSummary } from '@/lib/skills'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import { formatDateTime, formatClockSeconds } from '@/lib/format'
import '@/styles/agents.css' // shared agents-domain primitives (.kind-badge)
import '@/styles/agent-detail.css'

/** Log timestamps come from the gateway as ISO strings — render in the
 *  user's LOCAL timezone (never slice the raw ISO: that shows UTC). */
function logTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : formatClockSeconds(ts)
}

type TabKey = 'activity' | 'instructions' | 'skills' | 'logs'

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'activity', label: '活动' },
  { key: 'instructions', label: '指令' },
  { key: 'skills', label: 'Skills' },
  { key: 'logs', label: '日志' },
]

export interface AgentDetailViewProps {
  /** Route param `id`. */
  id: string
  /** Override `Date.now()` for the 30-bucket derivation — tests pass a fixed
   *  timestamp so activity buckets are deterministic. */
  nowMs?: number
}

/** Poll the detail endpoint while the WS hub is unreachable, so the view still
 *  refreshes availability/status without a live socket (architecture §6.8:
 *  "WS 断线回退轮询 fetch"). 0 = polling disabled. */
const POLL_INTERVAL_MS = 5_000

export function AgentDetailView({ id, nowMs }: AgentDetailViewProps): React.ReactElement {
  const { t } = useI18n()
  const toast = useToast()
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [logs, setLogs] = useState<AgentLogLine[]>([])
  const [logsError, setLogsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('activity')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // In-flight guards for the destructive actions (no double-PATCH/DELETE,
  // and failures surface instead of silently keeping the user on the page).
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Retry tick for the page-level error card — bumps re-run the load effect.
  const [reloadTick, setReloadTick] = useState(0)
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setLogsError(null)
    setNotFound(false)
    setDetail(null)
    setLogs([])
    // Fetch detail and logs independently so a logs 502/500 does NOT block
    // the inspector + tabs from rendering. Detail failure still escalates
    // to the page-level error card (it's the agent's identity); logs
    // failure is contained to the Logs tab as a retryable inline error.
    const detailP = fetchAgentDetail(id)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        if (/\(404\)/.test(msg)) setNotFound(true)
        else setError(msg)
        setDetail(null)
      })
    const logsP = fetchAgentLogs(id)
      .then((l) => {
        if (cancelled) return
        setLogs(l)
        setLogsError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Logs are auxiliary — surface the error only inside the Logs tab.
        setLogs([])
        setLogsError(err instanceof Error ? err.message : String(err))
      })
    void Promise.all([detailP, logsP]).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [id, reloadTick])

  // WS live status: a matching `agent-updated` frame patches the in-memory
  // detail's daemon status (availability) + lifecycle status without a refetch
  // (architecture §6.8). `setDetail` is functional so the closure is stable.
  // We overwrite BOTH daemonStatus and the top-level availability —
  // derivePageModel prefers a stale REST `availability` over the derived
  // daemon value, so patching only daemonStatus left inline agents frozen at
  // their first-fetch availability forever.
  const wsId = id
  useWsFrame((frame) => {
    if (frame.type !== 'agent-updated') return
    if (frame.agentId !== wsId) return
    setDetail((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        availability: frame.availability,
        agent: {
          ...prev.agent,
          // presence → daemon_status so derivePageModel's deriveAvailability
          // re-derives consistently with the initial REST fetch.
          daemonStatus: availabilityToDaemonStatus(frame.availability),
          status: frame.status,
        },
      }
    })
  })

  // WS-down fallback: poll the detail endpoint on an interval while the socket
  // is not connected. The interval re-fetches detail + logs and merges; a 404
  // flips to the not-found card (an agent archived mid-view should not stay
  // showing stale online status). Cleared when the socket (re)connects or on
  // unmount / id change.
  // No-arg call reads { connected } only — a no-op listener would needlessly
  // subscribe to every frame and bump the socket's refcount.
  const { connected } = useWsFrame()
  useEffect(() => {
    if (connected) return // live socket owns the refresh
    if (notFound) return // nothing to poll once the agent is gone
    let cancelled = false
    const tick = (): void => {
      // Same independent-fetch pattern as the initial load: a logs failure
      // on re-poll must not nuke a known-good detail.
      const detailP = fetchAgentDetail(id)
        .then((d) => {
          if (cancelled) return
          setDetail(d)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : String(err)
          if (/\(404\)/.test(msg)) {
            setNotFound(true)
            setDetail(null)
            setLogs([])
          }
          // transient errors: leave the last known detail in place.
        })
      const logsP = fetchAgentLogs(id)
        .then((l) => {
          if (cancelled) return
          setLogs(l)
          setLogsError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // Don't escalate — keep the stale logs visible; just mark the
          // Logs tab as needing a manual retry.
          setLogsError(err instanceof Error ? err.message : String(err))
        })
      void Promise.all([detailP, logsP])
    }
    const handle = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [connected, id, notFound])

  const model = useMemo<AgentDetailPageModel | null>(() => {
    if (!detail) return null
    return derivePageModel(detail, logs, nowMs ?? Date.now())
  }, [detail, logs, nowMs])

  return (
    <div className="page">
      <div className="mb-4">
        <Link className="detail-back" href="/agents">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t('返回 Agent 列表')}
        </Link>
      </div>

      <div className="detail-layout" data-od-id="detail-layout">
        {loading ? (
          <DetailSkeleton />
        ) : notFound ? (
          <NotFound id={id} />
        ) : error ? (
          <div className="detail-error card-flat" style={{ padding: 'var(--space-4)', color: 'var(--danger)', gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span>{t('加载失败：{error}', { error })}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setReloadTick((n) => n + 1)}
            >
              <Icon name="refresh" style={{ width: 12, height: 12 }} />
              {t('重试')}
            </button>
          </div>
        ) : model ? (
          <>
            <Inspector
              model={model}
              archiving={archiving}
              onEdit={() => { router.push(`/agents/${encodeURIComponent(id)}/edit`) }}
              onArchive={async () => {
                if (archiving) return
                setArchiving(true)
                try {
                  const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ visibility: 'archived' }),
                  })
                  if (resp.ok) {
                    router.push('/agents')
                    return
                  }
                  toast.error(t('归档失败（HTTP {status}）', { status: resp.status }))
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err))
                } finally {
                  setArchiving(false)
                }
              }}
              onDelete={() => setShowDeleteConfirm(true)}
            />
            <Overview
              model={model}
              activeTab={activeTab}
              onSelectTab={setActiveTab}
              logsError={logsError}
              agentId={id}
              onSkillsSaved={(skills) => {
                setDetail((prev) => {
                  if (!prev) return prev
                  return { ...prev, agent: { ...prev.agent, skills } }
                })
              }}
              onRetryLogs={() => {
                setLogsError(null)
                void fetchAgentLogs(id)
                  .then((l) => setLogs(l))
                  .catch((err: unknown) => {
                    setLogsError(err instanceof Error ? err.message : String(err))
                  })
              }}
            />
            {showDeleteConfirm && (
              <div
                className="agent-delete-overlay"
                role="presentation"
                onClick={() => { if (!deleting) setShowDeleteConfirm(false) }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !deleting) setShowDeleteConfirm(false)
                }}
              >
                <div
                  className="agent-delete-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label={t('删除 Agent')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="agent-delete-title">{t('删除 Agent')}</div>
                  <div className="agent-delete-desc">
                    {t('确定要删除「{name}」吗？此操作不可撤销。', { name: model.name })}
                  </div>
                  <div className="agent-delete-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={deleting}
                      ref={(el) => {
                        // Focus the SAFE action first — keyboard users must not
                        // Enter-through into the destructive default.
                        if (el && !el.dataset.focused) {
                          el.dataset.focused = '1'
                          el.focus()
                        }
                      }}
                      onClick={() => setShowDeleteConfirm(false)}
                    >
                      {t('取消')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={deleting}
                      onClick={async () => {
                        if (deleting) return
                        setDeleting(true)
                        try {
                          const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
                          if (resp.ok) {
                            router.push('/agents')
                            return
                          }
                          toast.error(t('删除失败（HTTP {status}）', { status: resp.status }))
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : String(err))
                        } finally {
                          setDeleting(false)
                          setShowDeleteConfirm(false)
                        }
                      }}
                    >
                      {deleting ? t('删除中…') : t('确认删除')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Loading skeleton — the shimmer `.sk` blocks the design shows for 200ms
 *  before `render(a)`. Ported 1:1 so the loading state matches the design. */
function DetailSkeleton(): React.ReactElement {
  const { t } = useI18n()
  return (
    <>
      <aside className="inspector" aria-busy="true">
        <div className="sk" style={{ width: 56, height: 56, borderRadius: 12 }} />
        <div>
          <div className="sk" style={{ width: 140, height: 16 }} />
          <div className="sk" style={{ width: 200, height: 12, marginTop: 6 }} />
        </div>
        <div className="sk" style={{ width: '100%', height: 48 }} />
        <div className="sk" style={{ width: '100%', height: 120 }} />
      </aside>
      <section className="overview">
        <div className="tabs" role="tablist" aria-label={t('agent 详情标签页')}>
          {TABS.map((tab) => (
            <span key={tab.key} className="tab" role="tab">
              {t(tab.label)}
            </span>
          ))}
        </div>
        <div className="tab-body">
          <div className="sk" style={{ width: '60%', height: 16 }} />
          <div className="sk" style={{ width: '100%', height: 120, marginTop: 12 }} />
        </div>
      </section>
    </>
  )
}

/** Not-found state — design agent-detail.html:172-179 renderNotFound(). */
function NotFound({ id }: { id: string }): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className="not-found" style={{ gridColumn: '1 / -1' }}>
      <div className="h">{t('找不到这个 Agent')}</div>
      <div className="d">
        {t('id “{id}” 不存在，可能已被归档或删除。', { id })}
      </div>
      <Link className="btn btn-secondary btn-sm" href="/agents">
        {t('返回 Agent 列表')}
      </Link>
    </div>
  )
}

interface InspectorProps {
  model: AgentDetailPageModel
  archiving?: boolean
  onEdit?: () => void
  onArchive?: () => void
  onDelete?: () => void
}

function Inspector({ model, archiving, onEdit, onArchive, onDelete }: InspectorProps): React.ReactElement {
  const { t } = useI18n()
  return (
    <aside className="inspector" id="inspector" data-od-id="inspector">
      {/* identity card (PX-AD01): warm surface, name md/600 + kind ghost
       * badge + availability pill on the shared shell .status baseline. */}
      <div className="ins-head">
        <div className={`ins-avatar kind-${model.kind}`} aria-hidden="true">
          {(model.name.trim().charAt(0) || '?').toUpperCase()}
        </div>
        <div className="ins-head-info">
          <div className="ins-name-row">
            <div className="ins-name">{model.name}</div>
            <span className="kind-badge">{t(kindLabel(model.kind))}</span>
          </div>
          <div className="ins-desc">{model.summary}</div>
          <div className="ins-presence">
            <span className={`status ${availabilityClass(model.availability)}`}>
              <span className="dot" />
              {t(availabilityLabel(model.availability))}
            </span>
          </div>
        </div>
      </div>
      {/* Action buttons — 编辑 secondary（组内主操作）/ 归档 ghost / 删除
          收进右端、hover danger（确认弹窗在下方）。 */}
      {(onEdit || onArchive || onDelete) && (
        <div className="ins-actions">
          {onEdit && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}>
              <Icon name="pencil" style={{ width: 12, height: 12 }} />
              <span>{t('编辑')}</span>
            </button>
          )}
          {onArchive && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} disabled={archiving}>
              <Icon name={archiving ? 'loader' : 'folder'} style={{ width: 12, height: 12 }} />
              <span>{archiving ? t('归档中…') : t('归档')}</span>
            </button>
          )}
          {onDelete && (
            <button type="button" className="btn btn-ghost btn-sm ins-action-danger" onClick={onDelete}>
              <Icon name="close" style={{ width: 12, height: 12 }} />
              <span>{t('删除')}</span>
            </button>
          )}
        </div>
      )}
      <div>
        <div className="ins-section-label">{t('属性')}</div>
        <PropRow label="Agent ID" mono value={model.id} />
        <PropRow label={t('类型')} value={t(kindLabel(model.kind))} pick />
        <PropRow label={t('模型')} value={model.model} pick />
        <PropRow label={t('运行时')} mono value={model.runtime} />
        {/* Lifecycle status — same concept the list badges on every card;
         * the detail page previously only showed availability, hiding
         * running/failed state entirely. */}
        <PropRow label={t('状态')} value={t(AGENT_STATUS_LABEL[model.status] ?? model.status)} />
        <PropRow label={t('并发')} value={model.concurrency} />
        <PropRow
          label={t('可见性')}
          value={
            model.visibility === 'public' ? t('公开')
            : model.visibility === 'archived' ? t('已归档')
            : t('工作区')
          }
        />
        <PropRow label={t('负责人')} value={model.owner} />
        <PropRow label={t('创建于')} mono value={formatDateTime(model.createdAt)} />
      </div>
      <div>
        <div className="ins-section-label">Skills</div>
        <div className="skill-chips">
          {model.skills.length > 0 ? (
            model.skills.map((s) => (
              <span key={s} className="skill-chip">
                {s}
              </span>
            ))
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              {t('无')}
            </span>
          )}
        </div>
      </div>
      <div>
        <div className="ins-section-label">{t('当前任务')}</div>
        <PropRow mono value={model.currentRun ?? t('无活跃 Run')} fullWidth />
        {model.currentRun ? (
          <>
            <div className="bar mb-2">
              <span style={{ width: `${model.progress}%` }} />
            </div>
            <div className="row-between">
              <span className="meta" style={{ fontSize: 11 }}>
                {t('已用 {elapsed}', { elapsed: model.elapsed })}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--accent-hover)' }}>
                {model.progress}%
              </span>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  )
}

interface PropRowProps {
  label?: string
  value: string
  mono?: boolean
  pick?: boolean
  fullWidth?: boolean
}

function PropRow({ label, value, mono, pick, fullWidth }: PropRowProps): React.ReactElement {
  return (
    <div
      className="prop-row"
      style={fullWidth ? { gridTemplateColumns: '1fr' } : undefined}
    >
      {label ? <div className="lbl">{label}</div> : null}
      <div className={`val${mono ? ' mono' : ''}`}>
        {pick ? <span className="pick">{value}</span> : value}
      </div>
    </div>
  )
}

interface OverviewProps {
  model: AgentDetailPageModel
  activeTab: TabKey
  onSelectTab: (tab: TabKey) => void
  logsError?: string | null
  onRetryLogs?: () => void
  agentId: string
  onSkillsSaved: (skills: string[]) => void
}

function Overview({
  model,
  activeTab,
  onSelectTab,
  logsError,
  onRetryLogs,
  agentId,
  onSkillsSaved,
}: OverviewProps): React.ReactElement {
  const { t } = useI18n()
  // Fixed-length ref array for the tab buttons — one slot per tab so the
  // keyboard handler can focus the next/prev/Home/End tab. Roving tabindex:
  // the active tab is in the tab sequence (tabindex=0), the rest are -1
  // (design agent-detail.html:325).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>(Array.from({ length: TABS.length }, () => null))
  return (
    <section className="overview" data-od-id="overview">
      <div className="tabs" role="tablist" aria-label={t('agent 详情标签页')}>
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            className="tab"
            role="tab"
            aria-selected={activeTab === tab.key}
            tabIndex={activeTab === tab.key ? 0 : -1}
            data-tab={tab.key}
            onClick={() => onSelectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, i, onSelectTab, tabRefs)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {activeTab === 'activity' ? <ActivityPanel model={model} /> : null}
        {activeTab === 'instructions' ? <InstructionsPanel model={model} /> : null}
        {activeTab === 'skills' ? (
          <SkillsPanel model={model} agentId={agentId} onSkillsSaved={onSkillsSaved} />
        ) : null}
        {activeTab === 'logs' ? (
          <LogsPanel model={model} error={logsError} onRetry={onRetryLogs} />
        ) : null}
      </div>
    </section>
  )
}

/** Tablist keyboard navigation — ArrowLeft/Right wrap, Home/End jump
 *  (design agent-detail.html:327-337). Focus follows the activated tab so the
 *  roving tabindex is observable. */
function onTabKeyDown(
  e: React.KeyboardEvent<HTMLButtonElement>,
  i: number,
  onSelectTab: (t: TabKey) => void,
  refs: React.RefObject<(HTMLButtonElement | null)[]>,
): void {
  const count = TABS.length
  let nextIdx: number | null = null
  if (e.key === 'ArrowRight') nextIdx = (i + 1) % count
  else if (e.key === 'ArrowLeft') nextIdx = (i - 1 + count) % count
  else if (e.key === 'Home') nextIdx = 0
  else if (e.key === 'End') nextIdx = count - 1
  if (nextIdx == null) return
  e.preventDefault()
  onSelectTab(TABS[nextIdx]!.key)
  refs.current[nextIdx]?.focus()
}

function ActivityPanel({ model }: { model: AgentDetailPageModel }): React.ReactElement {
  const { t } = useI18n()
  const { total, fail, successRate } = sumBuckets(model.activity)
  return (
    <>
      <div className="act-kpi-row">
        <div className="act-kpi">
          <div className="v">{total}</div>
          <div className="l">{t('30 天总运行')}</div>
        </div>
        <div className="act-kpi">
          <div className="v" style={{ color: 'var(--accent-hover)' }}>
            {successRate}
            {successRate === '—' ? '' : '%'}
          </div>
          <div className="l">{t('成功率')}</div>
        </div>
        <div className="act-kpi">
          <div className="v" style={{ color: 'var(--danger)' }}>
            {fail}
          </div>
          <div className="l">{t('失败次数')}</div>
        </div>
      </div>
      <div className="ins-section-label">{t('运行趋势（30 天）')}</div>
      <AgentActivitySparkline buckets={model.activity} />
      <div className="act-recent">
        <div className="ins-section-label">{t('最近活动')}</div>
        {model.logs.length > 0 ? (
          [...model.logs].reverse().map((l, i) => (
            <div className="act-recent-item" key={`${l.ts}-${i}`}>
              <span className="mono meta" style={{ width: 64, fontSize: 11 }}>
                {logTime(l.ts)}
              </span>
              <span className={`log-lvl ${l.level}`} style={{ width: 40 }}>
                {l.level.toUpperCase()}
              </span>
              <span style={{ color: 'var(--fg-2)' }}>{l.msg}</span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ fontSize: 12, padding: 'var(--space-2) 0' }}>
            {t('暂无活动')}
          </div>
        )}
      </div>
    </>
  )
}

function InstructionsPanel({ model }: { model: AgentDetailPageModel }): React.ReactElement {
  const { t } = useI18n()
  return (
    <>
      <div className="ins-section-label">{t('系统提示词')}</div>
      <div className="instr">{model.instructions}</div>
      <div className="ins-section-label mt-6">{t('能力描述符')}</div>
      <div className="card-flat" style={{ padding: 'var(--space-4)' }}>
        <PropRow label={t('输入 schema')} mono value={model.inputSchema} />
        <PropRow label={t('输出 schema')} mono value={model.outputSchema} />
      </div>
    </>
  )
}

/**
 * Skills tab — 已挂载列表 + 本地技能库导入。
 *
 * 本地目录来自 gateway 的运行时注册表（`~/.agents/skills` +
 * `DAGENTS_SKILL_DIRS`，跨客户端约定）。勾选后 PATCH 保存到 agent.skills
 * （仅存名称引用；技能本体始终以文件系统为真相源，目录里删掉即失效）。
 */
function SkillsPanel({
  model,
  agentId,
  onSkillsSaved,
}: {
  model: AgentDetailPageModel
  agentId: string
  onSkillsSaved: (skills: string[]) => void
}): React.ReactElement {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<SkillSummary[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(model.skills)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const savedHideRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(savedHideRef.current), [])

  // 面板随 tab 挂载/卸载，目录在挂载时拉一次（gateway 侧有 60s TTL 缓存）。
  useEffect(() => {
    let cancelled = false
    fetchSkills()
      .then(({ skills }) => {
        if (!cancelled) setCatalog(Array.isArray(skills) ? skills : [])
      })
      .catch((err: unknown) => {
        if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const catalogByName = useMemo(() => {
    const m = new Map<string, SkillSummary>()
    for (const s of catalog ?? []) m.set(s.name, s)
    return m
  }, [catalog])

  const dirty = useMemo(() => {
    const a = [...selected].sort()
    const b = [...model.skills].sort()
    return a.length !== b.length || a.some((v, i) => v !== b[i])
  }, [selected, model.skills])

  const toggle = (name: string): void => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: selected }),
      })
      if (!res.ok) throw new Error(t('保存失败（HTTP {status}）', { status: res.status }))
      onSkillsSaved(selected)
      setSavedAt(Date.now())
      // The "已保存" marker is a transient confirmation — clear it after 2s
      // so it can't sit there contradicting a later dirty state.
      window.clearTimeout(savedHideRef.current)
      savedHideRef.current = window.setTimeout(() => setSavedAt(0), 2000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="row-between">
        <div className="ins-section-label">{t('已挂载 Skills（{n}）', { n: selected.length })}</div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          {savedAt ? (
            <span className="meta" style={{ fontSize: 11, color: 'var(--success, #16a34a)' }}>
              {t('已保存')}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? t('保存中…') : t('保存挂载')}
          </button>
        </div>
      </div>
      {saveError ? (
        <div className="meta" style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }} role="alert">
          {saveError}
        </div>
      ) : null}
      <div className="skills-grid">
        {selected.length > 0 ? (
          selected.map((s) => {
            const meta = catalogByName.get(s)
            return (
              <div className="skill-card" key={s}>
                <div className="skill-card-head">
                  <div className="nm">{s}</div>
                  <button
                    type="button"
                    className="skill-remove"
                    aria-label={t('移除技能 {name}', { name: s })}
                    title={t('移除挂载')}
                    onClick={() => toggle(s)}
                  >
                    <Icon name="close" style={{ width: 12, height: 12 }} />
                  </button>
                </div>
                <div className="ds">{meta ? meta.description : t('（本地目录中未找到 — 可能已被删除）')}</div>
              </div>
            )
          })
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            {t('无挂载 Skills — 从下方本地技能库选择导入')}
          </div>
        )}
      </div>

      <div className="ins-section-label mt-6">{t('本地技能库')}</div>
      {catalogError ? (
        <div className="meta" style={{ fontSize: 12, color: 'var(--danger)' }} role="alert">
          {t('本地技能目录加载失败：{error}', { error: catalogError })}
        </div>
      ) : catalog === null ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {t('加载本地技能目录…')}
        </div>
      ) : catalog.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {t('本地没有可用技能（~/.agents/skills 为空）。放入 <name>/SKILL.md 即可被发现。')}
        </div>
      ) : (
        <div className="skill-import-grid">
          {catalog.map((s) => {
            const on = selected.includes(s.name)
            return (
              <button
                key={s.name}
                type="button"
                className={`skill-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                title={s.description}
                onClick={() => toggle(s.name)}
              >
                <span className="skill-chip-check" aria-hidden="true">
                  {on ? '✓' : '+'}
                </span>
                <span className="skill-chip-name">{s.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

function LogsPanel({
  model,
  error,
  onRetry,
}: {
  model: AgentDetailPageModel
  error?: string | null
  onRetry?: () => void
}): React.ReactElement {
  const { t } = useI18n()
  return (
    <>
      <div className="ins-section-label">{t('最近日志')}</div>
      {error ? (
        <div
          className="card-flat"
          style={{
            padding: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
            color: 'var(--danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
          }}
          role="alert"
        >
          <span>{t('日志加载失败：{error}', { error })}</span>
          {onRetry ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={onRetry}
            >
              {t('重试')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="log">
        {model.logs.length > 0 ? (
          [...model.logs].reverse().map((l, i) => (
            <div className="log-line" key={`${l.ts}-${i}`}>
              <span className="log-ts">{logTime(l.ts)}</span>
              <span className={`log-lvl ${l.level}`}>{l.level.toUpperCase()}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))
        ) : (
          <div className="log-line">
            <span className="log-msg muted">{error ? t('等待重试…') : t('暂无日志')}</span>
          </div>
        )}
      </div>
      <div className="ins-section-label mt-6">{t('区域与资源')}</div>
      <div className="card-flat" style={{ padding: 'var(--space-4)' }}>
        <PropRow label={t('区域')} value={model.region} />
        <PropRow label={t('所属 daemon')} mono value={model.daemon} />
        <PropRow label={t('负载')} value={`${model.load}%`} />
        <PropRow label={t('今日成本')} mono value={model.cost} />
      </div>
    </>
  )
}
