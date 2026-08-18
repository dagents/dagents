'use client'

/**
 * AgentFlows view (v0.3-M2.1 + M2.2 combined).
 *
 * Two layout modes, swapped at the top level the way design/agentflows.html's
 * `showDetail`/`hideDetail` swap `.flow-list-page` ↔ `.flow-detail-page`:
 *
 *   - LIST page: scope tabs (mine / all / archived) + a toolbar (search) + a
 *     vertical list of `.flow-card`s, each expanding to reveal its
 *     `.flow-runs` (run history — currently an honest empty state; the
 *     workflows list carries no run history yet). The per-card edit button
 *     routes to `/workflows/:id/canvas` (the workflow canvas editor).
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
 * Data: the list is fetched from `/api/workflows` (→ gateway → workflows
 * table). A flow's run history is built from the same executions the summary
 * already counted (the executions endpoint returns newest-first); expanding a
 * card does NOT re-fetch — it just reveals the rows the summary carried. The
 * detail page fetches the flow (`/api/workflows/:id`) for its DAG + the run's
 * node-level spans (`/api/workflows/runs/:runId/node-spans`) for the
 * inspector's persisted token/cost/error/trace data.
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
import { CreateFlowDialog } from '@/components/create-flow-dialog'
import { fetchRunNodeSpans, type RunNodeSpan } from '@/lib/node-spans'
import { parseFlowData, type FlowSummary, type FlowDetailView, type NodeRunStatus } from '@/lib/flows'
import '@/styles/flows.css'

const STATUS_CN: Record<NodeRunStatus, string> = {
  running: '运行',
  done: '完成',
  failed: '失败',
  queued: '排队',
  paused: '人工暂停',
  idle: '未触发',
}

/** Chinese label for a node-span status (the M6.4 domain adds `unknown`). */
const SPAN_STATUS_CN: Record<string, string> = {
  ...STATUS_CN,
  unknown: '未知',
}

/** The three scope tabs (agentflows.html:157-161). */
type Scope = 'mine' | 'all' | 'archived'

/** A single row in the gateway's `/api/v1/workflows` list response. */
interface GatewayFlowListItem {
  id: string
  name: string
  description: string | null
  status: string
  nodeCount: number
  updatedAt: string
}

/** The gateway's `/api/v1/workflows/:id` detail response (flowData is an object). */
interface GatewayFlowDetail {
  id: string
  name: string
  description: string | null
  flowData: unknown
  status: string
  createdAt: string
  updatedAt: string
}

interface FlowListResponse {
  success: boolean
  /**
   * The gateway returns `{ flows: [...] }`; component tests stub `FlowSummary[]`
   * directly. Both shapes are accepted — `mapFlowList` normalizes either onto
   * `FlowSummary[]`.
   */
  data?: FlowSummary[] | { flows: GatewayFlowListItem[] }
  error?: string
}
interface FlowDetailResponse {
  success: boolean
  /**
   * The gateway returns `{ flow: {...} }`; component tests stub `FlowDetailView`
   * directly. Both shapes are accepted — `mapFlowDetail` normalizes either onto
   * `FlowDetailView`.
   */
  data?: FlowDetailView | { flow: GatewayFlowDetail }
  error?: string
}

/**
 * Map the gateway's list response onto `FlowSummary[]`. The gateway's workflows
 * table has no type/owner/runCount/latestRunId/versionHash columns, so those are
 * defaulted (type='CHATFLOW', status='idle', owner=null, archived=false,
 * runCount=0, latestRunId=undefined) — the initial version surfaces the flow
 * identity + node count + updatedAt; the rest of the list-page fidelity fields
 * will be wired when executions are surfaced. A `FlowSummary[]` payload
 * (e.g. from a test stub) is passed through unchanged.
 */
function mapFlowList(data: FlowListResponse['data']): FlowSummary[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if ('flows' in data && Array.isArray(data.flows)) {
    return data.flows.map((f) => ({
      id: f.id,
      name: f.name,
      type: 'CHATFLOW',
      status: 'idle',
      nodeCount: f.nodeCount,
      updatedAt: f.updatedAt,
      versionHash: '',
      owner: null,
      archived: false,
      runCount: 0,
    }))
  }
  return []
}

/** 静态节点类型描述 — 镜像 packages/workflow 的 CanvasNodeMeta.description。 */
const CANVAS_NODE_DESCRIPTIONS: Record<string, string> = {
  startAgentflow: '工作流入口节点',
  agentAgentflow: '自主推理 Agent，可使用工具进行多轮推理',
  platformAgentAgentflow: '引用平台上的 Agent，使用其指令和模型配置',
  llmAgentflow: '大语言模型调用',
  toolAgentflow: '自定义工具定义，包含处理代码',
  httpAgentflow: '发起 HTTP 请求',
  conditionAgentflow: '基于条件的分支',
  conditionAgentAgentflow: '基于 LLM 的场景路由',
  iterationAgentflow: '遍历列表项',
  loopAgentflow: '循环直到条件满足',
  humanInputAgentflow: '暂停等待人工输入',
  directReplyAgentflow: '直接回复用户',
  customFunctionAgentflow: '执行自定义 JavaScript 代码',
  executeFlowAgentflow: '执行子工作流',
  retrieverAgentflow: '从向量存储检索文档',
}

/**
 * Map the gateway's detail response onto `FlowDetailView`. The gateway returns
 * the raw `flowData` object (React Flow's `{ nodes, edges, viewport }`), which
 * we parse into the DAG the detail page renders. The gateway has no executions,
 * versionHash, or latestRunId, so those are defaulted. A `FlowDetailView`
 * payload (e.g. from a test stub) is passed through unchanged.
 */
function mapFlowDetail(data: FlowDetailResponse['data']): FlowDetailView | null {
  if (!data) return null
  // Already a FlowDetailView (test stub) — pass through.
  if ('nodes' in data && 'edges' in data) return data
  if ('flow' in data) {
    const f = data.flow
    // `parseFlowData` expects a JSON string; the gateway returns flowData as a
    // parsed object, so stringify it first. A missing/malformed value degrades
    // to an empty DAG (parseFlowData handles both).
    const flowDataStr = typeof f.flowData === 'string' ? f.flowData : JSON.stringify(f.flowData ?? null)
    const dag = parseFlowData(flowDataStr)
    return {
      id: f.id,
      name: f.name,
      type: 'CHATFLOW',
      versionHash: '',
      status: 'idle',
      latestExecutionId: undefined,
      latestRunId: null,
      nodes: dag.nodes.map((n) => {
        const nodeTypeName = (n.data?.name as string) ?? ''
        const meta = CANVAS_NODE_DESCRIPTIONS[nodeTypeName]
        return {
          id: n.id,
          label: typeof n.data?.label === 'string' ? n.data.label : n.id,
          type: n.type ?? 'customNode',
          position: n.position ?? { x: 0, y: 0 },
          status: 'idle' as NodeRunStatus,
          config: n.data as Record<string, unknown> | undefined,
          description: meta,
          nodeType: nodeTypeName,
        }
      }),
      edges: dag.edges.map((e, i) => {
        const rawLabel = (e.label ?? e.data?.label) as unknown
        return {
          id: e.id ?? `e-${e.source}-${e.target}-${i}`,
          source: e.source,
          target: e.target,
          label: typeof rawLabel === 'string' ? rawLabel : undefined,
        }
      }),
      nodeMetrics: {},
      updatedAt: f.updatedAt,
    }
  }
  return null
}

export function FlowsView(): React.ReactElement {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowSummary[]>([])
  // ── list-page state (M2.1) ──────────────────────────────────────────────
  const [scope, setScope] = useState<Scope>('all')
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
  const [createOpen, setCreateOpen] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)

  /** showDetail(flowId, runId) — mirrors design/agentflows.html L432-462.
   *  Sets both ids; the detail effect fetches the flow + drives the swap.
   *  The list page's run-row click and the card's [data-action=run] button
   *  both route through here, so there's a single entry into the detail page. */
  const showDetail = useCallback((flowId: string, runId: string) => {
    setSelectedFlowId(flowId)
    setSelectedRunId(runId)
  }, [])

  /** Run a flow by POSTing to the gateway's /:id/run endpoint, then open the
   *  detail page with the returned run id so the user sees the DAG + result.
   *  The gateway executes the workflow synchronously and returns the runId via
   *  the `x-run-id` response header. */
  const runFlow = useCallback(async (flowId: string) => {
    setRunningId(flowId)
    setListError(null)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const runId = res.headers.get('x-run-id')
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) {
        setListError(json.error ?? `运行失败 (${res.status})`)
        return
      }
      if (runId) {
        showDetail(flowId, runId)
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningId(null)
    }
  }, [showDetail])

  /** 返回 AgentFlows — mirrors design `hideDetail` (L464-469): clears both. */
  const hideDetail = useCallback(() => {
    setSelectedFlowId(null)
    setSelectedRunId(null)
  }, [])

  /** Create-flow success handler — navigate to the canvas editor so the
   *  user can immediately start adding nodes to the new empty flow. */
  const handleFlowCreated = useCallback((id: string) => {
    setCreateOpen(false)
    router.push(`/workflows/${id}/canvas`)
  }, [router])

  // Fetch the flow list once on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingList(true)
      setListError(null)
      try {
        const res = await fetch('/api/workflows', { cache: 'no-store' })
        const json = (await res.json()) as FlowListResponse
        if (cancelled) return
        if (!res.ok || !json.success || !json.data) {
          setListError(json.error ?? `flows list failed (${res.status})`)
          setFlows([])
        } else {
          setFlows(mapFlowList(json.data))
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
        const res = await fetch(`/api/workflows/${encodeURIComponent(selectedFlowId)}`, { cache: 'no-store' })
        const json = (await res.json()) as FlowDetailResponse
        if (cancelled) return
        if (!res.ok || !json.success || !json.data) {
          setDetailError(json.error ?? `flow fetch failed (${res.status})`)
          setDetail(null)
        } else {
          setDetail(mapFlowDetail(json.data))
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
  // execution status rather than erroring.
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
  // `updateScopeCounts`). `mine` is always 0 today: chatflows carry no
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

  // The flows visible under the current scope + search — the design's
  // `visibleFlows()` (agentflows.html:281-296), minus the status filter
  // (removed: the workflows list carries no live run status, so status chips
  // could never match anything).
  const visibleFlows = useMemo(() => {
    const ql = query.trim().toLowerCase()
    return flows.filter((f) => {
      if (scope === 'archived') {
        if (!f.archived) return false
      } else {
        if (f.archived) return false
        if (scope === 'mine' && f.owner == null) return false
      }
      if (ql && !(f.name.toLowerCase().includes(ql) || f.id.toLowerCase().includes(ql))) return false
      return true
    })
  }, [flows, scope, query])

  const onSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId)
  }, [])

  /**
   * Merged flow: when the gateway's `mapFlowDetail` hard-codes every node
   * status to `idle` (it has no executions concept), we layer the spans from
   * the run_node_spans endpoint on top so the canvas + inspector paint the
   * correct per-node status for the active run. A node with no span stays
   * idle (it genuinely wasn't reached).
   */
  const mergedFlow = useMemo<FlowDetailView | null>(() => {
    if (!detail) return null
    if (Object.keys(spansByNode).length === 0) return detail
    const mergedNodes = detail.nodes.map((n) => {
      const span = spansByNode[n.id]
      if (!span) return n
      // Scheduler/node-span status → console node-status domain. Both share
      // `running | done | failed | paused | unknown` — map `unknown` to
      // `idle` (safer than painting a misleading state).
      const status: NodeRunStatus =
        span.status === 'unknown' ? 'idle' : (span.status as NodeRunStatus)
      return { ...n, status }
    })
    return { ...detail, nodes: mergedNodes }
  }, [detail, spansByNode])

  const selectedNode = useMemo(() => {
    if (!mergedFlow || !selectedNodeId) return null
    return mergedFlow.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [mergedFlow, selectedNodeId])

  const inDetail = Boolean(selectedFlowId && selectedRunId)

  return (
    <PageShell fullBleed>
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
            data-zero={scopeCounts.mine === 0 ? 'true' : undefined}
            onClick={() => setScope('mine')}
          >
            我的 <span className="cnt">{scopeCounts.mine}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            data-scope="all"
            data-zero={scopeCounts.all === 0 ? 'true' : undefined}
            onClick={() => setScope('all')}
          >
            全部 <span className="cnt">{scopeCounts.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'archived'}
            data-scope="archived"
            data-zero={scopeCounts.archived === 0 ? 'true' : undefined}
            onClick={() => setScope('archived')}
          >
            已归档 <span className="cnt">{scopeCounts.archived}</span>
          </button>
        </div>

        <div className="flow-toolbar">
          <div className="list-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="搜索 flow 名称或 ID…"
              aria-label="搜索 flow"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="grow" />
          <span className="result-count">
            {visibleFlows.length} / {flows.length} 个 flow
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            新建 Flow
          </button>
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
              <div className="empty-state-icon" aria-hidden="true">⚡</div>
              <div className="h">{flows.length === 0 ? '还没有 Flow' : '没有匹配的 Flow'}</div>
              <div className="d">
                {flows.length === 0
                  ? '创建你的第一个 Flow，编排 Agent 协作流程。'
                  : '试试调整筛选条件或清除搜索。'}
              </div>
              {flows.length === 0 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setCreateOpen(true)}
                >
                  <Icon name="plus" style={{ width: 14, height: 14 }} />
                  新建 Flow
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setQuery('')
                    setScope('all')
                  }}
                >
                  清除过滤器
                </button>
              )}
            </div>
          ) : (
            visibleFlows.map((f, i) => {
              const expanded = expandedId === f.id
              return (
                <div key={f.id} className={`flow-card enter-rise${expanded ? ' expanded' : ''}`} data-flow-id={f.id} style={{ '--enter-i': i } as React.CSSProperties}>
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
                      {/* workflows 列表不携带运行状态 — 渲染中性的「未触发」，
                          不伪造带状态点的 idle 指示灯 */}
                      <span className="muted" style={{ fontSize: 12 }} title="尚无运行状态数据">
                        未触发
                      </span>
                      {f.latestRunId ? (
                        <span className="chip chip-outline mono" style={{ fontSize: 10 }}>
                          {f.latestRunId}
                        </span>
                      ) : null}
                    </div>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-action="edit"
                        data-flow-id={f.id}
                        title="在画布中编辑"
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/workflows/${encodeURIComponent(f.id)}/canvas`)
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
                        disabled={runningId === f.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void runFlow(f.id)
                        }}
                      >
                        {runningId === f.id ? '运行中…' : '▶ 运行'}
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
                    {/* 列表页没有真实的 run 历史数据（不伪造「手动触发」行）—
                        运行请从卡片「▶ 运行」按钮、Flow 详情页或画布触发 */}
                    <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                      暂无运行记录 — 从 Flow 详情页或画布触发运行
                    </div>
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
          返回 Flow 列表
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
            ) : mergedFlow ? (
              <FlowDag flow={mergedFlow} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
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
                  detail={mergedFlow}
                  span={spansByNode[selectedNode.id]}
                />
              ) : (
                <FlowOverview detail={mergedFlow} />
              )}
            </div>
          </div>
        </div>
      </div>
      <CreateFlowDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleFlowCreated}
      />
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
  // Best-effort input/output text from the span's opaque `data` blob
  // (for Agent/LLM nodes that's `{ input, output: { content, … } }`).
  // We surface a single string per box, capped, falling back to "—" when
  // nothing readable is present — mirroring the design's `n.input || '—'` /
  // `n.output || '—'` (L528 / L532).
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
          <dt>节点类型</dt>
          <dd>{node.nodeType ?? node.type ?? '—'}</dd>
          {span?.traceId ? (
            <>
              <dt>trace</dt>
              <dd className="mono" style={{ fontSize: 10 }}>{span.traceId.slice(0, 16)}…</dd>
            </>
          ) : null}
        </dl>
      </div>
      {node.description ? (
        <div className="flow-insp-section">
          <div className="lbl">节点说明</div>
          <p className="muted" style={{ fontSize: 12 }}>{node.description}</p>
        </div>
      ) : null}
      {node.config && Object.keys(node.config).length > 0 ? (
        <div className="flow-insp-section">
          <div className="lbl">节点配置</div>
          <div className="io-box">{formatJson(node.config)}</div>
        </div>
      ) : null}
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
          <code className="mono"> Workflow </code>画布完成。
        </p>
      </div>
    </>
  )
}

/**
 * Sum the total tokens across models from a node span's `tokens` blob.
 * The scheduler stores the per-model usage map
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
 * io shape (`usageMetadata` nests `input_tokens`/`output_tokens`),
 * which we render as a compact summary. Absent that, the box shows "—" — the
 * design's placeholder for a node whose io wasn't recorded. This keeps the
 * io-box DOM present (the audit's fidelity gap was the missing section, not a
 * specific value) while not fabricating io that wasn't persisted.
 */
function extractIo(span: RunNodeSpan | undefined): { input: string; output: string } {
  if (!span) return { input: '—', output: '—' }
  const inputStr = span.input ? formatJson(span.input) : '—'
  const outputStr = span.output ? formatJson(span.output) : '—'
  return { input: inputStr, output: outputStr }
}

function formatJson(obj: unknown): string {
  try {
    const s = JSON.stringify(obj, null, 2)
    return s.length > 2000 ? s.slice(0, 2000) + '\n…' : s
  } catch {
    return String(obj)
  }
}

function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
