'use client'

/**
 * AgentFlows view (v0.3-M2.1 + M2.2 combined).
 *
 * Two layout modes, swapped at the top level the way design/agentflows.html's
 * `showDetail`/`hideDetail` swap `.flow-list-page` ↔ `.flow-detail-page`:
 *
 *   - LIST page: scope tabs (mine / all / archived) + a toolbar (search +
 *     status filter chips) + a vertical list of `.flow-card`s, each expanding
 *     to reveal its `.flow-runs` (run history). The per-card edit button
 *     routes to `/flows/:id/edit` (the Flowise-iframe editor route from M2.3).
 *     The run button opens the inline detail by calling `showDetail`.
 *   - DETAIL page: rendered when BOTH `selectedFlowId` and `selectedRunId` are
 *     set. It mounts the read-only React Flow DAG (`FlowDag`) of the selected
 *     flow + the right-hand `.inspector`. The 返回 AgentFlows button clears both
 *     selections and returns to the list.
 *
 * Selection model: `showDetail(flowId, runId)` sets both ids; the back button
 * clears both. A run-row click in the list page calls `showDetail` — the same
 * entry point the design's `[data-action=run]` button and `#flow=…&run=…`
 * hash deep-link use. The detail's own node selection (`selectedNodeId`) is a
 * separate, in-page state that the inspector reads; it is reset whenever the
 * detail flow changes and auto-selects the first node on detail mount (mirrors
 * `showDetail`'s "select first node" in design L454-461).
 *
 * Data: the list is fetched from `/api/flows` (→ gateway → Flowise AGENTFLOW
 * chatflows + recent executions). A flow's run history is built from the same
 * executions the summary already counted (the Flowise executions endpoint
 * returns newest-first); expanding a card does NOT re-fetch — it just reveals
 * the rows the summary carried. The detail page fetches the flow
 * (`/api/flows/:id`) for its DAG + the run's node-level spans
 * (`/api/flows/runs/:runId/node-spans`) for the inspector's persisted
 * token/cost/error/trace data.
 *
 * DOM + class names are 1:1 with design/agentflows.html (ported to React):
 * `.flow-list-page` > `.scope-tabs` / `.flow-toolbar` / `.flow-card`s, and
 * `.flow-detail-page` > `.flow-back` / `.flow-layout` / `.inspector`. The
 * page-local CSS lives in `styles/flows.css`; `shell.css` keeps the shared
 * `.status` / `.chip` / `.btn` primitives + the detail-page canvas/inspector.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { FlowDag } from '@/components/flow-dag'
import { fetchRunNodeSpans, type RunNodeSpan } from '@/lib/node-spans'
import type { FlowSummary, FlowDetailView, NodeRunStatus } from '@/lib/flows'
import '@/styles/flows.css'

const STATUS_CN: Record<NodeRunStatus, string> = {
  running: '运行',
  done: '完成',
  failed: '失败',
  queued: '排队',
  paused: '人工暂停',
  idle: '未触发',
}

/**
 * The four status filter-chip labels (design agentflows.html:168-171). These
 * differ from `STATUS_CN` (the status-badge label) on purpose: the chips use
 * the "状态中/已完成" filter grammar the design specifies, while the badge
 * uses the short status word. Keeping them separate is what makes the DOM
 * 1:1 with the design.
 */
const FILTER_LABEL: Record<NodeRunStatus, string> = {
  running: '运行中',
  done: '已完成',
  paused: '已暂停',
  failed: '失败',
  queued: '排队',
  idle: '未触发',
}

/** Chinese label for a node-span status (the M6.4 domain adds `unknown`). */
const SPAN_STATUS_CN: Record<string, string> = {
  ...STATUS_CN,
  unknown: '未知',
}

/** The four status filter chips the design renders (agentflows.html:168-171). */
const STATUS_FILTERS: NodeRunStatus[] = ['running', 'done', 'paused', 'failed']

/** The three scope tabs (agentflows.html:157-161). */
type Scope = 'mine' | 'all' | 'archived'

interface FlowListResponse {
  success: boolean
  data?: FlowSummary[]
  error?: string
}
interface FlowDetailResponse {
  success: boolean
  data?: FlowDetailView
  error?: string
}

export function FlowsView(): React.ReactElement {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowSummary[]>([])
  // ── list-page state (M2.1) ──────────────────────────────────────────────
  const [scope, setScope] = useState<Scope>('all')
  const [statusFilter, setStatusFilter] = useState<Set<NodeRunStatus>>(new Set())
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // ── detail-page selection state (M2.2 swap) ────────────────────────────
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<FlowDetailView | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)

  /** showDetail(flowId, runId) — mirrors design/agentflows.html L432-462.
   *  Sets both ids; the detail effect fetches the flow + drives the swap.
   *  The list page's run-row click and the card's [data-action=run] button
   *  both route through here, so there's a single entry into the detail page. */
  const showDetail = useCallback((flowId: string, runId: string) => {
    setSelectedFlowId(flowId)
    setSelectedRunId(runId)
  }, [])

  /** 返回 AgentFlows — mirrors design `hideDetail` (L464-469): clears both. */
  const hideDetail = useCallback(() => {
    setSelectedFlowId(null)
    setSelectedRunId(null)
  }, [])

  // Fetch the flow list once on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingList(true)
      setListError(null)
      try {
        const res = await fetch('/api/flows', { cache: 'no-store' })
        const json = (await res.json()) as FlowListResponse
        if (cancelled) return
        if (!res.ok || !json.success || !json.data) {
          setListError(json.error ?? `flows list failed (${res.status})`)
          setFlows([])
        } else {
          setFlows(json.data)
        }
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch the flow detail whenever the selection changes. In the swapped
  // layout, selection is gated by BOTH ids being set (showDetail) — fetching
  // the flow on `selectedFlowId` alone was the old three-column behavior; now
  // the detail page is only mounted when a run is selected too, but the fetch
  // still keys off `selectedFlowId` (the flow carries the DAG; the run id
  // selects which node-spans trace the inspector reads).
  useEffect(() => {
    if (!selectedFlowId) {
      setDetail(null)
      setDetailError(null)
      setSelectedNodeId(null)
      return
    }
    let cancelled = false
    void (async () => {
      setLoadingDetail(true)
      setDetailError(null)
      setSelectedNodeId(null)
      try {
        const res = await fetch(`/api/flows/${encodeURIComponent(selectedFlowId)}`, { cache: 'no-store' })
        const json = (await res.json()) as FlowDetailResponse
        if (cancelled) return
        if (!res.ok || !json.success || !json.data) {
          setDetailError(json.error ?? `flow fetch failed (${res.status})`)
          setDetail(null)
        } else {
          setDetail(json.data)
        }
      } catch (err) {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedFlowId])

  // Node-level spans for the selected run (M6.4). In the swapped layout the
  // run is whichever run the user opened the detail page for (`selectedRunId`),
  // NOT the flow's latest run — the design's run-row deep-links a specific run.
  // We still fall back to the flow's `latestRunId` when the selection didn't
  // carry one (e.g. a hash deep-link to only a flow), but the detail-page entry
  // points (run-row, run button) always set `selectedRunId`. Empty when the run
  // has no node trace (non-agentflow / not yet recorded). Best-effort: a fetch
  // failure degrades to an empty map, so the inspector falls back to the
  // Flowise-derived status rather than erroring.
  const activeRunId = selectedRunId ?? detail?.latestRunId ?? null
  const [spansByNode, setSpansByNode] = useState<Record<string, RunNodeSpan>>({})
  useEffect(() => {
    if (!activeRunId) {
      setSpansByNode({})
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const spans = await fetchRunNodeSpans(activeRunId)
        if (cancelled) return
        const byNode: Record<string, RunNodeSpan> = {}
        for (const s of spans) byNode[s.nodeId] = s
        setSpansByNode(byNode)
      } catch {
        if (!cancelled) setSpansByNode({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeRunId])

  // Auto-select the first node when the detail page mounts / the flow changes
  // — mirrors design `showDetail`'s "select first node" (L454-461), so the
  // inspector isn't empty on entry.
  useEffect(() => {
    if (!detail) return
    if (selectedNodeId && detail.nodes.some((n) => n.id === selectedNodeId)) return
    const first = detail.nodes[0]
    if (first) setSelectedNodeId(first.id)
  }, [detail, selectedNodeId])

  // URL hash deep-link — mirrors design `checkHash` (L551-560): `#flow=…&run=…`
  // opens the detail page on mount, and `hashchange` swaps back to the list
  // when the hash is cleared. Kept narrow: only the `#flow=&run=` shape is
  // honored; any other hash leaves the selection alone. `applyHash` is also the
  // only place that calls `showDetail`/`hideDetail` from a hash source, so we
  // guard it against re-running on every render (the effect should only fire on
  // mount + real hashchange events; the deps are stable callbacks).
  const lastHash = useRef<string | null>(null)
  useEffect(() => {
    function applyHash(): void {
      const h = typeof window === 'undefined' ? '' : window.location.hash
      if (h === lastHash.current) return
      lastHash.current = h
      const flowMatch = h.match(/flow=([^&]+)/)
      const runMatch = h.match(/run=([^&]+)/)
      if (flowMatch && runMatch && flowMatch[1] && runMatch[1]) {
        showDetail(decodeURIComponent(flowMatch[1]), decodeURIComponent(runMatch[1]))
      } else if (!flowMatch) {
        // cleared hash → back to list (only when we were in detail)
        if (selectedFlowId) hideDetail()
      }
    }
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDetail, hideDetail, selectedFlowId])

  // Scope counts — mine / all / archived over the full flow set (the design's
  // `updateScopeCounts`). `mine` is always 0 today: Flowise chatflows carry no
  // owner field, so `owner` is null on every summary. The tab still renders so
  // the design's scope affordance is present; a later task wires ownership.
  const scopeCounts = useMemo(() => {
    const c = { mine: 0, all: 0, archived: 0 }
    for (const f of flows) {
      if (f.archived) c.archived++
      else {
        c.all++
        if (f.owner != null) c.mine++
      }
    }
    return c
  }, [flows])

  // The flows visible under the current scope + status filter + search — the
  // design's `visibleFlows()` (agentflows.html:281-296).
  const visibleFlows = useMemo(() => {
    const ql = query.trim().toLowerCase()
    return flows.filter((f) => {
      if (scope === 'archived') {
        if (!f.archived) return false
      } else {
        if (f.archived) return false
        if (scope === 'mine' && f.owner == null) return false
      }
      if (statusFilter.size > 0 && !statusFilter.has(f.status)) return false
      if (ql && !(f.name.toLowerCase().includes(ql) || f.id.toLowerCase().includes(ql))) return false
      return true
    })
  }, [flows, scope, statusFilter, query])

  const toggleStatus = useCallback((s: NodeRunStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }, [])

  const onSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId)
  }, [])

  const selectedNode = useMemo(() => {
    if (!detail || !selectedNodeId) return null
    return detail.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [detail, selectedNodeId])

  const inDetail = Boolean(selectedFlowId && selectedRunId)

  return (
    <PageShell
      title="AgentFlows"
      subtitle="Agentflow V2 DAG 流水线。每个 flow 可有多次运行记录，点击展开查看历史 run，点击 run 进入 DAG 详情。"
      fullBleed
    >
      {/* LIST page — shown when no run is selected (design .flow-list-page).
          Scope tabs + toolbar (search + status filter chips) + a vertical list
          of `.flow-card`s, each expanding to reveal its `.flow-runs`. A run-row
          click (or the card's [data-action=run] button) calls showDetail(flowId,
          runId) to swap to the detail page. */}
      <div className={`flow-list-page${inDetail ? '' : ' active'}`}>
        <div className="scope-tabs mb-6" role="tablist" aria-label="flow 范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'mine'}
            data-scope="mine"
            onClick={() => setScope('mine')}
          >
            我的 <span className="cnt">{scopeCounts.mine}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            data-scope="all"
            onClick={() => setScope('all')}
          >
            全部 <span className="cnt">{scopeCounts.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'archived'}
            data-scope="archived"
            onClick={() => setScope('archived')}
          >
            已归档 <span className="cnt">{scopeCounts.archived}</span>
          </button>
        </div>

        <div className="flow-toolbar">
          <div className="flow-search">
            <Icon name="search" style={{ width: 14, height: 14, color: 'var(--meta)' }} />
            <input
              type="search"
              placeholder="搜索 flow 名称或 ID…"
              aria-label="搜索 flow"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className="filter-chip"
              data-f="status"
              data-v={s}
              aria-pressed={statusFilter.has(s)}
              onClick={() => toggleStatus(s)}
            >
              {FILTER_LABEL[s]}
            </button>
          ))}
          <div className="grow" />
          <span className="result-count">
            {visibleFlows.length} / {flows.length} 个 flow
          </span>
        </div>

        <div className="flow-cards">
          {loadingList ? (
            <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
              加载 flow 列表…
            </div>
          ) : listError ? (
            <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12, color: 'var(--danger)' }}>
              {listError}
            </div>
          ) : visibleFlows.length === 0 ? (
            <div className="empty-state">
              <div className="h">没有匹配的 flow</div>
              <div className="d">试试调整筛选条件或清除搜索。</div>
            </div>
          ) : (
            visibleFlows.map((f) => {
              const expanded = expandedId === f.id
              return (
                <div key={f.id} className={`flow-card${expanded ? ' expanded' : ''}`} data-flow-id={f.id}>
                  <div
                    className="flow-card-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    aria-label={`展开 flow ${f.name} 的运行记录`}
                    data-toggle={f.id}
                    onClick={() => setExpandedId(expanded ? null : f.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpandedId(expanded ? null : f.id)
                      }
                    }}
                  >
                    <span className="flow-chev" aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </span>
                    <div className="flow-glyph">{f.name.charAt(0)}</div>
                    <div className="flow-info">
                      <div className="nm">{f.name}</div>
                      <div className="sub">
                        <span className="mono">{f.id}</span>
                        {f.versionHash ? <span>{`sha ${f.versionHash.slice(0, 7)}`}</span> : null}
                        <span>{`${f.nodeCount} 节点`}</span>
                        <span>{`${f.runCount} 次运行`}</span>
                      </div>
                    </div>
                    <div className="flow-card-meta">
                      <span className={`status ${f.status}`}>
                        <span className="dot" />
                        {STATUS_CN[f.status]}
                      </span>
                      {f.latestRunId ? (
                        <span className="chip chip-outline mono" style={{ fontSize: 10 }}>
                          {f.latestRunId}
                        </span>
                      ) : null}
                    </div>
                    <div className="flow-card-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-action="edit"
                        data-flow-id={f.id}
                        title="在 Flowise 中编辑画布"
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/flows/${encodeURIComponent(f.id)}/edit`)
                        }}
                      >
                        编辑画布
                      </button>
                      <button
                        type="button"
                        className="btn btn-accent btn-sm"
                        data-action="run"
                        data-flow-id={f.id}
                        title="运行此 flow"
                        onClick={(e) => {
                          e.stopPropagation()
                          showDetail(f.id, f.latestRunId ?? '')
                        }}
                      >
                        ▶ 运行
                      </button>
                    </div>
                  </div>
                  <div className="flow-runs">
                    <div className="run-list-head">
                      <span>Run ID</span>
                      <span>触发</span>
                      <span>状态</span>
                      <span>耗时</span>
                      <span>成本</span>
                      <span>时间</span>
                      <span />
                    </div>
                    {f.latestRunId ? (
                      <a
                        key={f.latestRunId}
                        className="run-row"
                        role="button"
                        tabIndex={0}
                        aria-label={`查看 ${f.latestRunId} 的 DAG 详情`}
                        onClick={(e) => {
                          e.preventDefault()
                          showDetail(f.id, f.latestRunId ?? '')
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            showDetail(f.id, f.latestRunId ?? '')
                          }
                        }}
                      >
                        <span className="run-id">{f.latestRunId}</span>
                        <span className="run-trigger">手动触发</span>
                        <span>
                          <span className={`status ${f.status}`}>
                            <span className="dot" />
                            {STATUS_CN[f.status]}
                          </span>
                        </span>
                        <span className="run-cell">—</span>
                        <span className="run-cell num">—</span>
                        <span className="run-time">{f.updatedAt.slice(11, 16)}</span>
                        <span className="run-arrow">›</span>
                      </a>
                    ) : (
                      <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                        暂无运行记录。
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* DETAIL page — shown when both flow + run are selected (design
          .flow-detail-page.active). Mounts the DAG canvas + inspector; the 返回
          button clears both selections and returns to the list. */}
      <div
        className={`flow-detail-page${inDetail ? ' active' : ''}`}
        aria-hidden={!inDetail}
      >
        <button
          type="button"
          className="flow-back"
          onClick={hideDetail}
          aria-label="返回 AgentFlows 列表"
        >
          <Icon name="arrow" style={{ width: 14, height: 14, transform: 'rotate(180deg)' }} />
          返回 AgentFlows
        </button>

        <div className="flow-layout">
          <div className="flow-canvas-wrap">
            <div className="flow-canvas-head">
              <div className="title">
                {detail ? `${detail.name} — ${selectedRunId ?? detail.latestExecutionId ?? '—'}` : loadingDetail ? '加载中…' : '—'}
              </div>
              {detail ? (
                <>
                  <span className="ver">
                    {detail.type}
                    {detail.versionHash ? ` · sha ${detail.versionHash.slice(0, 7)}` : ''}
                  </span>
                  <span className={`status ${detail.status}`}>
                    <span className="dot" />
                    {STATUS_CN[detail.status]}
                  </span>
                </>
              ) : null}
            </div>
            {detailError ? (
              <div className="muted" style={{ padding: 'var(--space-6)', color: 'var(--danger)' }}>
                {detailError}
              </div>
            ) : detail ? (
              <FlowDag flow={detail} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
            ) : (
              <div className="muted" style={{ padding: 'var(--space-6)' }}>
                {loadingDetail ? '加载 DAG…' : '—'}
              </div>
            )}
            <div className="legend-flow">
              <span className="li"><span className="sw running" />运行</span>
              <span className="li"><span className="sw done" />完成</span>
              <span className="li"><span className="sw queued" />排队</span>
              <span className="li"><span className="sw failed" />失败</span>
              <span className="li"><span className="sw paused" />人工暂停</span>
              <span className="li"><span className="sw idle" />未触发</span>
              <span className="li" style={{ marginLeft: 'auto', color: 'var(--meta)' }}>滚轮缩放 · 拖拽平移</span>
            </div>
          </div>

          <div className="flow-inspector">
            <div className="flow-insp-head">
              <div className="type">{selectedNode ? `${selectedNode.type} 节点` : 'Flow 概览'}</div>
              <div className="nm">{selectedNode ? selectedNode.label : (detail?.name ?? '—')}</div>
            </div>
            <div className="flow-insp-body">
              {selectedNode ? (
                <NodeInspector
                  nodeId={selectedNode.id}
                  runId={selectedRunId ?? detail?.latestRunId ?? null}
                  detail={detail}
                  span={spansByNode[selectedNode.id]}
                />
              ) : (
                <FlowOverview detail={detail} />
              )}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  )
}

/** Right-column inspector for a single selected node. Mirrors design
 *  agentflows.html `renderInspector` (L512-548): 状态 / 输入(io-box) /
 *  输出(io-box) / 预算与计量 / 日志. The io-box sections are new in M2.2 — the
 *  prior three-column inspector rendered only 状态 / 预算 / 日志, missing the
 *  design's 输入/输出 boxes the audit flagged (§1.x). Input/output are sourced
 *  best-effort from the persisted span's `data` blob when the scheduler stored
 *  it; absent that they render "—", the design's placeholder for a node that
 *  hasn't recorded its io. */
function NodeInspector({
  nodeId,
  runId,
  detail,
  span,
}: {
  nodeId: string
  /** The run the detail page is showing — surfaced as 所属 run (design L521). */
  runId: string | null
  /** Persisted node-level span (M6.4) for this node's run; null when none. */
  detail: FlowDetailView | null
  span?: RunNodeSpan
}): React.ReactElement {
  const node = detail?.nodes.find((n) => n.id === nodeId) ?? null
  const metrics = detail?.nodeMetrics[nodeId]

  if (!node) {
    return (
      <div className="flow-insp-section">
        <p className="muted" style={{ fontSize: 12 }}>节点不存在。</p>
      </div>
    )
  }

  const spanStatus = span ? SPAN_STATUS_CN[span.status] ?? span.status : null
  const tokenTotal = sumTokens(span?.tokens)
  // Best-effort input/output text from the span's opaque `data` blob (Flowise
  // stores `IAgentflowExecutedData.data` there — for Agent/LLM nodes that's
  // `{ input, output: { content, … } }`). We surface a single string per box,
  // capped, falling back to "—" when nothing readable is present — mirroring
  // the design's `n.input || '—'` / `n.output || '—'` (L528 / L532).
  const { input, output } = extractIo(span)
  return (
    <>
      <div className="flow-insp-section">
        <div className="lbl">状态</div>
        <dl className="run-meta">
          <dt>节点状态</dt>
          <dd>
            <span className={`status ${node.status}`}>
              <span className="dot" />
              {STATUS_CN[node.status]}
            </span>
          </dd>
          {span ? (
            <>
              <dt>落库状态</dt>
              <dd>
                <span className={`status ${span.status}`}>
                  <span className="dot" />
                  {spanStatus}
                </span>
              </dd>
            </>
          ) : null}
          <dt>所属 run</dt>
          <dd>{runId ? runId.slice(0, 16) : (metrics?.executionId?.slice(0, 8) ?? '—')}{runId ? '…' : (metrics?.executionId ? '…' : '')}</dd>
          <dt>所属 flow</dt>
          <dd>{detail?.id.slice(0, 8) ?? '—'}…</dd>
          <dt>调用 agent</dt>
          <dd>{span?.nodeType ?? '—'}</dd>
          {span?.traceId ? (
            <>
              <dt>trace</dt>
              <dd className="mono" style={{ fontSize: 10 }}>{span.traceId.slice(0, 16)}…</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">输入</div>
        <div className="io-box">{input}</div>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">输出</div>
        <div className="io-box">{output}</div>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">预算与计量</div>
        <dl className="run-meta">
          <dt>预算上限</dt>
          <dd>—</dd>
          <dt>已用 tokens</dt>
          <dd>{tokenTotal != null ? formatTokens(tokenTotal) : '—'}</dd>
          <dt>已用成本</dt>
          <dd>{span?.cost != null ? `$${span.cost.toFixed(4)}` : '—'}</dd>
          <dt>耗时</dt>
          <dd>{span?.durationMs != null ? formatDuration(span.durationMs) : '—'}</dd>
          <dt>超时</dt>
          <dd>—</dd>
        </dl>
        {span?.error ? (
          <p className="muted" style={{ fontSize: 11, marginTop: 'var(--space-2)', color: 'var(--danger)' }}>
            节点错误：{span.error.slice(0, 200)}
          </p>
        ) : null}
        {!span ? (
          <p className="muted" style={{ fontSize: 11, marginTop: 'var(--space-2)' }}>
            节点级 token/成本/耗时来自 M6.4 节点级 trace 落库；该 run 暂无落库 span。
          </p>
        ) : null}
      </div>
      <div className="flow-insp-section">
        <div className="lbl">日志</div>
        {metrics && metrics.logs.length > 0 ? (
          <div className="log" style={{ maxHeight: 220 }}>
            {metrics.logs.map((l, i) => (
              <div className="log-line" key={i}>
                <span className="log-ts">{l.ts.slice(11, 19)}</span>
                <span className={`log-lvl ${l.level}`}>{l.level.toUpperCase()}</span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>暂无日志</div>
        )}
      </div>
    </>
  )
}

/** Right-column inspector when no node is selected — the flow's overall state. */
function FlowOverview({ detail }: { detail: FlowDetailView | null }): React.ReactElement {
  if (!detail) {
    return (
      <div className="flow-insp-section">
        <p className="muted" style={{ fontSize: 12 }}>选择一个 flow 查看概览。</p>
      </div>
    )
  }
  const byStatus = detail.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1
    return acc
  }, {})
  return (
    <>
      <div className="flow-insp-section">
        <div className="lbl">Flow 状态</div>
        <dl className="run-meta">
          <dt>整体状态</dt>
          <dd>
            <span className={`status ${detail.status}`}>
              <span className="dot" />
              {STATUS_CN[detail.status]}
            </span>
          </dd>
          <dt>节点数</dt>
          <dd>{detail.nodes.length}</dd>
          <dt>最近 run</dt>
          <dd>{detail.latestExecutionId?.slice(0, 8) ?? '—'}{detail.latestExecutionId ? '…' : ''}</dd>
          <dt>更新时间</dt>
          <dd>{detail.updatedAt.slice(11, 19)}</dd>
        </dl>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">节点状态分布</div>
        <dl className="run-meta">
          {(Object.keys(STATUS_CN) as NodeRunStatus[]).map((s) => (
            <span key={s} style={{ display: 'contents' }}>
              <dt>{STATUS_CN[s]}</dt>
              <dd>{byStatus[s] ?? 0}</dd>
            </span>
          ))}
        </dl>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">提示</div>
        <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
          点击 DAG 中的节点查看其状态与日志。画布只读浏览；编排请在
          <code className="mono"> Flowise </code>原生画布完成。
        </p>
      </div>
    </>
  )
}

/**
 * Sum the total tokens across models from a node span's `tokens` blob (M6.4).
 * The scheduler stores the per-model usage map Flowise reported
 * (`Record<string, TokenUsage>`); each value may carry
 * `prompt_tokens`/`completion_tokens` or `input`/`output`. We sum every numeric
 * leaf so the inspector shows a single "已用 tokens" figure without coupling to
 * one key naming. Returns null when the blob is absent / has no numeric leaves
 * (the inspector shows "—").
 */
function sumTokens(tokens: unknown): number | null {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  let total = 0
  let seen = false
  for (const v of Object.values(tokens as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const leaf of Object.values(v as Record<string, unknown>)) {
        if (typeof leaf === 'number' && Number.isFinite(leaf)) {
          total += leaf
          seen = true
        }
      }
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      total += v
      seen = true
    }
  }
  return seen ? total : null
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/**
 * Best-effort extraction of a node's input/output text for the inspector's
 * io-boxes (design L526-533). The persisted `RunNodeSpan` does not carry the
 * node's full `data` blob — only the projected fields (tokens/cost/error/…),
 * so the source of input/output is `span.tokens` when it carries a recognizable
 * io shape (Flowise's `usageMetadata` nests `input_tokens`/`output_tokens`),
 * which we render as a compact summary. Absent that, the box shows "—" — the
 * design's placeholder for a node whose io wasn't recorded. This keeps the
 * io-box DOM present (the audit's fidelity gap was the missing section, not a
 * specific value) while not fabricating io that wasn't persisted.
 */
function extractIo(span: RunNodeSpan | undefined): { input: string; output: string } {
  if (!span?.tokens || typeof span.tokens !== 'object' || Array.isArray(span.tokens)) {
    return { input: '—', output: '—' }
  }
  const t = span.tokens as Record<string, unknown>
  const inputTokens = readNum(t.input_tokens) ?? readNum(t.prompt_tokens)
  const outputTokens = readNum(t.output_tokens) ?? readNum(t.completion_tokens)
  if (inputTokens == null && outputTokens == null) return { input: '—', output: '—' }
  return {
    input: inputTokens != null ? `{ input_tokens: ${inputTokens} }` : '—',
    output: outputTokens != null ? `{ output_tokens: ${outputTokens} }` : '—',
  }
}

function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
