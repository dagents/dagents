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
import { kindLabel, kindGlyph } from '@/lib/agents-catalog'
import '@/styles/agent-detail.css'

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
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [logs, setLogs] = useState<AgentLogLine[]>([])
  const [logsError, setLogsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('activity')

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
  }, [id])

  // WS live status: a matching `agent-updated` frame patches the in-memory
  // detail's daemon status (availability) + lifecycle status without a refetch
  // (architecture §6.8). `setDetail` is functional so the closure is stable.
  const wsId = id
  useWsFrame((frame) => {
    if (frame.type !== 'agent-updated') return
    if (frame.agentId !== wsId) return
    setDetail((prev) => {
      if (!prev) return prev
      return {
        ...prev,
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
  const { connected } = useWsFrame(() => {})
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
          返回 Agent 列表
        </Link>
      </div>

      <div className="detail-layout" data-od-id="detail-layout">
        {loading ? (
          <DetailSkeleton />
        ) : notFound ? (
          <NotFound id={id} />
        ) : error ? (
          <div className="detail-error card-flat" style={{ padding: 'var(--space-4)', color: 'var(--danger)', gridColumn: '1 / -1' }}>
            加载失败：{error}
          </div>
        ) : model ? (
          <>
            <Inspector model={model} />
            <Overview
              model={model}
              activeTab={activeTab}
              onSelectTab={setActiveTab}
              logsError={logsError}
              onRetryLogs={() => {
                setLogsError(null)
                void fetchAgentLogs(id)
                  .then((l) => setLogs(l))
                  .catch((err: unknown) => {
                    setLogsError(err instanceof Error ? err.message : String(err))
                  })
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Loading skeleton — the shimmer `.sk` blocks the design shows for 200ms
 *  before `render(a)`. Ported 1:1 so the loading state matches the design. */
function DetailSkeleton(): React.ReactElement {
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
        <div className="tabs" role="tablist" aria-label="agent 详情标签页">
          {TABS.map((t) => (
            <span key={t.key} className="tab" role="tab">
              {t.label}
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
  return (
    <div className="not-found" style={{ gridColumn: '1 / -1' }}>
      <div className="h">找不到这个 Agent</div>
      <div className="d">
        id &ldquo;{id}&rdquo; 不存在，可能已被归档或删除。
      </div>
      <Link className="btn btn-secondary btn-sm" href="/agents">
        返回 Agent 列表
      </Link>
    </div>
  )
}

interface InspectorProps {
  model: AgentDetailPageModel
}

function Inspector({ model }: InspectorProps): React.ReactElement {
  return (
    <aside className="inspector" id="inspector" data-od-id="inspector">
      <div className="ins-head">
        <div className={`ins-avatar kind-${model.kind}`} aria-hidden="true">
          {kindGlyph(model.kind)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="ins-name">{model.name}</div>
          <div className="ins-desc">{model.summary}</div>
          <div className="ins-presence">
            <span className={`status ${availabilityClass(model.availability)}`}>
              <span className="dot" />
              {availabilityLabel(model.availability)}
            </span>
          </div>
        </div>
      </div>
      <div>
        <div className="ins-section-label">属性</div>
        <PropRow label="Agent ID" mono value={model.id} />
        <PropRow label="类型" value={kindLabel(model.kind)} pick />
        <PropRow label="模型" value={model.model} pick />
        <PropRow label="运行时" mono value={model.runtime} />
        <PropRow label="并发" value={model.concurrency} />
        <PropRow
          label="可见性"
          value={model.visibility === 'public' ? '公开' : '工作区'}
        />
        <PropRow label="负责人" value={model.owner} />
        <PropRow label="创建于" mono value={model.createdAt.slice(0, 10)} />
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
              无
            </span>
          )}
        </div>
      </div>
      <div>
        <div className="ins-section-label">当前任务</div>
        <PropRow mono value={model.currentRun ?? '无活跃 Run'} fullWidth />
        {model.currentRun ? (
          <>
            <div className="bar mb-2">
              <span style={{ width: `${model.progress}%` }} />
            </div>
            <div className="row-between">
              <span className="meta" style={{ fontSize: 11 }}>
                已用 {model.elapsed}
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
}

function Overview({ model, activeTab, onSelectTab, logsError, onRetryLogs }: OverviewProps): React.ReactElement {
  // Fixed-length ref array for the tab buttons — one slot per tab so the
  // keyboard handler can focus the next/prev/Home/End tab. Roving tabindex:
  // the active tab is in the tab sequence (tabindex=0), the rest are -1
  // (design agent-detail.html:325).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>(Array.from({ length: TABS.length }, () => null))
  return (
    <section className="overview" data-od-id="overview">
      <div className="tabs" role="tablist" aria-label="agent 详情标签页">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            className="tab"
            role="tab"
            aria-selected={activeTab === t.key}
            tabIndex={activeTab === t.key ? 0 : -1}
            data-tab={t.key}
            onClick={() => onSelectTab(t.key)}
            onKeyDown={(e) => onTabKeyDown(e, i, onSelectTab, tabRefs)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {activeTab === 'activity' ? <ActivityPanel model={model} /> : null}
        {activeTab === 'instructions' ? <InstructionsPanel model={model} /> : null}
        {activeTab === 'skills' ? <SkillsPanel model={model} /> : null}
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
  const { total, fail, successRate } = sumBuckets(model.activity)
  return (
    <>
      <div className="act-kpi-row">
        <div className="act-kpi">
          <div className="v">{total}</div>
          <div className="l">30 天总运行</div>
        </div>
        <div className="act-kpi">
          <div className="v" style={{ color: 'var(--accent-hover)' }}>
            {successRate}
            {successRate === '—' ? '' : '%'}
          </div>
          <div className="l">成功率</div>
        </div>
        <div className="act-kpi">
          <div className="v" style={{ color: 'var(--danger)' }}>
            {fail}
          </div>
          <div className="l">失败次数</div>
        </div>
      </div>
      <div className="ins-section-label">运行趋势（30 天）</div>
      <AgentActivitySparkline buckets={model.activity} />
      <div className="act-axis-row">
        <span>30 天前</span>
        <span>今天</span>
      </div>
      <div className="act-recent">
        <div className="ins-section-label">最近活动</div>
        {model.logs.length > 0 ? (
          [...model.logs].reverse().map((l, i) => (
            <div className="act-recent-item" key={`${l.ts}-${i}`}>
              <span className="mono meta" style={{ width: 48, fontSize: 11 }}>
                {l.ts.slice(11, 19)}
              </span>
              <span className={`log-lvl ${l.level}`} style={{ width: 40 }}>
                {l.level.toUpperCase()}
              </span>
              <span style={{ color: 'var(--fg-2)' }}>{l.msg}</span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ fontSize: 12, padding: 'var(--space-2) 0' }}>
            暂无活动
          </div>
        )}
      </div>
    </>
  )
}

function InstructionsPanel({ model }: { model: AgentDetailPageModel }): React.ReactElement {
  return (
    <>
      <div className="ins-section-label">系统提示词</div>
      <div className="instr">{model.instructions}</div>
      <div className="ins-section-label mt-6">能力描述符</div>
      <div className="card-flat" style={{ padding: 'var(--space-4)' }}>
        <PropRow label="输入 schema" mono value={model.inputSchema} />
        <PropRow label="输出 schema" mono value={model.outputSchema} />
      </div>
    </>
  )
}

function SkillsPanel({ model }: { model: AgentDetailPageModel }): React.ReactElement {
  return (
    <>
      <div className="ins-section-label">已挂载 Skills（{model.skills.length}）</div>
      <div className="skills-grid">
        {model.skills.length > 0 ? (
          model.skills.map((s) => (
            <div className="skill-card" key={s}>
              <div className="nm">{s}</div>
              <div className="ds">—</div>
            </div>
          ))
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            无挂载 Skills
          </div>
        )}
      </div>
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
  return (
    <>
      <div className="ins-section-label">最近日志</div>
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
          <span>日志加载失败：{error}</span>
          {onRetry ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={onRetry}
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="log">
        {model.logs.length > 0 ? (
          [...model.logs].reverse().map((l, i) => (
            <div className="log-line" key={`${l.ts}-${i}`}>
              <span className="log-ts">{l.ts.slice(11, 19)}</span>
              <span className={`log-lvl ${l.level}`}>{l.level.toUpperCase()}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))
        ) : (
          <div className="log-line">
            <span className="log-msg muted">{error ? '等待重试…' : '暂无日志'}</span>
          </div>
        )}
      </div>
      <div className="ins-section-label mt-6">区域与资源</div>
      <div className="card-flat" style={{ padding: 'var(--space-4)' }}>
        <PropRow label="区域" value={model.region} />
        <PropRow label="所属 daemon" mono value={model.daemon} />
        <PropRow label="负载" value={`${model.load}%`} />
        <PropRow label="今日成本" mono value={model.cost} />
      </div>
    </>
  )
}
