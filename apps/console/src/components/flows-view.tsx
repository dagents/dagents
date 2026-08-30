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
import { FlowTemplateGallery } from '@/components/flow-template-gallery'
import { GenerateFlowDialog } from '@/components/generate-flow-dialog'
import { FlowsEmptyHero } from '@/components/flows-empty-hero'
import { FlowRunDialog } from '@/components/flow-run-dialog'
import { FlowRunsPanel } from '@/components/flow-runs-panel'
import { SkeletonList } from '@/components/skeleton'
import { useToast } from '@/components/toast'
import { fetchRunNodeSpans, type RunNodeSpan } from '@/lib/node-spans'
import { fetchDirectories, type Directory } from '@/lib/directories'
import {
  parseFlowData,
  NODE_STATUS_CN as STATUS_CN,
  SPAN_STATUS_CN,
  type FlowSummary,
  type FlowDetailView,
  type NodeRunStatus,
} from '@/lib/flows'
import { formatDateTime, formatClockSeconds, formatTokens, formatDuration, truncateMiddle } from '@/lib/format'
import { useI18n } from '@/i18n'
import '@/styles/flows.css'

/** Log/ts strings are ISO from the gateway — render LOCAL time (never slice
 *  the raw ISO: that shows UTC and drifts by the timezone offset). */
function isoTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : formatClockSeconds(ts)
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

export function FlowsView({ home = false }: { home?: boolean }): React.ReactElement {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
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
  const [templateOpen, setTemplateOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  // 运行输入对话框（对齐画布运行面板）：点「运行」先收集输入 + 项目目录，
  // 再异步发起。此前直接 POST 同步端点 —— 响应要等整个流程跑完才返回。
  const [runDialogFlow, setRunDialogFlow] = useState<{ id: string; name: string } | null>(null)
  const [runDirectories, setRunDirectories] = useState<Directory[]>([])
  const [runDirId, setRunDirId] = useState('')
  // Inline delete confirmation per card (like the sidebar's chat delete).
  const [deletingFlowId, setDeletingFlowId] = useState<string | null>(null)
  const [deletingFlowPending, setDeletingFlowPending] = useState(false)
  // Retry ticks — bump re-run the corresponding load effect.
  const [reloadListTick, setReloadListTick] = useState(0)
  const [reloadDetailTick, setReloadDetailTick] = useState(0)
  // 卡片运行历史面板的刷新 tick：发起运行成功后 bump（新 run 立即可见）。
  const [runsTick, setRunsTick] = useState(0)

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
   *  异步模式（?async=1）：网关先落一行 running、后台执行、**立即**返回
   *  runId —— 同步等待会把 HTTP 响应压到整个流程跑完（CLI Agent 动辄
   *  几分钟），期间页面无跳转无进度，用户感知「点了没反应」。进度由
   *  详情页的 spans 轮询承接（见下方 activeRunId effect）。输入作为
   *  `{{$start.input}}` 传入；directoryId 决定 CLI Agent 的工作目录。
   *  Failures land in the top banner — the list itself stays rendered. */
  const runFlow = useCallback(async (flowId: string, input: string, directoryId: string) => {
    setRunningId(flowId)
    setListError(null)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}/run?async=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(input.trim() ? { input: input.trim() } : {}),
          ...(directoryId ? { directoryId } : {}),
        }),
      })
      const json = (await res.json().catch(() => null)) as {
        success?: boolean
        data?: { runId?: string }
        error?: string
      } | null
      if (!res.ok || !json?.success) {
        setListError(json?.error ?? t('运行失败（HTTP {status}）', { status: res.status }))
        return
      }
      const runId = json.data?.runId ?? res.headers.get('x-run-id')
      if (runId) {
        // 新 run 立即出现在卡片运行历史里（面板挂 3s 轮询直到终态）
        setRunsTick((n) => n + 1)
        showDetail(flowId, runId)
      } else {
        // Success but no run id — don't leave the user at a dead end.
        toast.warning(t('运行已提交，但未能获取运行 ID'))
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningId(null)
    }
  }, [showDetail, t, toast])

  // 运行目录懒加载：首次打开运行对话框时拉取目录清单；记忆键与画布运行
  // 面板共用（dagents.canvas.runDir）—— 同一个「运行目录」概念，用户设
  // 一次两边生效。
  useEffect(() => {
    if (!runDialogFlow || runDirectories.length > 0) return
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setRunDirectories(dirs)
        const stored = window.localStorage.getItem('dagents.canvas.runDir')
        if (stored && dirs.some((d) => d.id === stored)) setRunDirId(stored)
        else if (dirs.length > 0) setRunDirId((cur) => cur || dirs[0]!.id)
      } catch {
        // 目录加载失败 → 对话框显示「无目录 — Agent 在网关目录运行」
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runDialogFlow, runDirectories.length])

  /** 返回 AgentFlows — mirrors design `hideDetail` (L464-469): clears both,
   *  and scrubs the `#flow=…&run=…` hash so a refresh/share doesn't reopen
   *  the detail page. */
  const hideDetail = useCallback(() => {
    setSelectedFlowId(null)
    setSelectedRunId(null)
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  /** Delete a flow (with the inline confirmation the card renders). */
  const confirmDeleteFlow = useCallback(async (flowId: string) => {
    if (deletingFlowPending) return
    setDeletingFlowPending(true)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}`, { method: 'DELETE' })
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
      if (!res.ok || json.success === false) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      setFlows((prev) => prev.filter((f) => f.id !== flowId))
      toast.success(t('Flow 已删除'))
    } catch (err) {
      toast.error(t('删除 Flow 失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setDeletingFlowPending(false)
      setDeletingFlowId(null)
    }
  }, [deletingFlowPending, toast, t])

  /** Create-flow success handler — navigate to the canvas editor so the
   *  user can immediately start adding nodes to the new empty flow. */
  const handleFlowCreated = useCallback((id: string) => {
    setCreateOpen(false)
    router.push(`/workflows/${id}/canvas`)
  }, [router])

  // Fetch the flow list on mount / retry.
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
          setListError(json.error ?? t('Flow 列表加载失败（HTTP {status}）', { status: res.status }))
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
  }, [reloadListTick, t])

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
          setDetailError(json.error ?? t('Flow 详情加载失败（HTTP {status}）', { status: res.status }))
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
  }, [selectedFlowId, reloadDetailTick, t])

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
    let timer = 0
    let emptyPolls = 0
    let stablePolls = 0
    let sawLive = false
    const stop = (): void => {
      window.clearInterval(timer)
    }
    // 终态收尾：刷新详情/列表（runCount、latestRunId 落位）+ 打扰性反馈。
    // 只有本挂载期间真的观察到过活动状态（sawLive）才 toast —— 打开旧
    // 运行详情的定稿轮询保持安静。
    const finalize = (status: string, spans: RunNodeSpan[]): void => {
      stop()
      if (!sawLive) return
      setReloadDetailTick((n) => n + 1)
      setReloadListTick((n) => n + 1)
      if (status === 'completed') {
        toast.success(t('运行完成'))
      } else if (status === 'cancelled') {
        toast.warning(t('已取消'))
      } else {
        const failed = spans.find((s) => s.status === 'failed')
        toast.error(
          failed?.error
            ? t('运行失败：{reason}', { reason: String(failed.error).slice(0, 120) })
            : t('运行失败 — 详见红色节点的错误信息'),
          8000,
        )
      }
    }
    const tick = async (): Promise<void> => {
      // 单次拉取失败降级为空 map（下方启发式负责停轮询），不崩详情页。
      const { spans, runStatus } = await fetchRunNodeSpans(activeRunId).catch(() => ({
        spans: [] as RunNodeSpan[],
        runStatus: null as string | null,
      }))
      if (cancelled) return
      const byNode: Record<string, RunNodeSpan> = {}
      for (const s of spans) byNode[s.nodeId] = s
      setSpansByNode(byNode)
      if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
        finalize(runStatus, spans)
        return
      }
      if (runStatus) sawLive = true // runs 行仍是 running —— 活动运行
      // 无 runs 行的旧运行 / 查询失败：启发式收尾（与画布旁观模式同款）
      if (!runStatus) {
        if (spans.length === 0) {
          emptyPolls += 1
          if (emptyPolls >= 8) stop() // ~10s 无任何 span —— 放弃轮询
        } else if (!spans.some((s) => s.status === 'running')) {
          stablePolls += 1
          if (stablePolls >= 4) stop()
        } else {
          stablePolls = 0
        }
      }
    }
    void tick()
    timer = window.setInterval(() => void tick(), 1200)
    return () => {
      cancelled = true
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 运行节点跟随（2026-08-30 流式可见性）：轮询到新的 running 节点时把
  // inspector 切过去 —— 运行中的 partial 输出直接流在 inspector 里，不再
  // 停在首个节点上错过全部动作。每个节点只跟随一次（用户手动点别的节点
  // 后，下一个节点开始时才重新接管）；全部终态后停在最后的节点。
  const followedRunningRef = useRef<string | null>(null)
  useEffect(() => {
    const running = Object.values(spansByNode).find((s) => s.status === 'running')
    if (!running || running.nodeId === followedRunningRef.current) return
    followedRunningRef.current = running.nodeId
    setSelectedNodeId(running.nodeId)
  }, [spansByNode])

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
        <div className="scope-tabs mb-6" role="tablist" aria-label={t('flow 范围')}>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'mine'}
            data-scope="mine"
            data-zero={scopeCounts.mine === 0 ? 'true' : undefined}
            onClick={() => setScope('mine')}
          >
            {t('我的')} <span className="cnt">{scopeCounts.mine}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            data-scope="all"
            data-zero={scopeCounts.all === 0 ? 'true' : undefined}
            onClick={() => setScope('all')}
          >
            {t('全部')} <span className="cnt">{scopeCounts.all}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'archived'}
            data-scope="archived"
            data-zero={scopeCounts.archived === 0 ? 'true' : undefined}
            onClick={() => setScope('archived')}
          >
            {t('已归档')} <span className="cnt">{scopeCounts.archived}</span>
          </button>
        </div>

        <div className="flow-toolbar">
          <div className="list-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder={t('搜索 flow 名称或 ID…')}
              aria-label={t('搜索 flow')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="grow" />
          {!listError ? (
            <span className="result-count">
              {t('{n} / {total} 个 flow', { n: visibleFlows.length, total: flows.length })}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setTemplateOpen(true)}
          >
            <Icon name="zap" style={{ width: 14, height: 14 }} />
            {t('从模板创建')}
          </button>
          {/* 一句话生成（PRD F7）—— 与画布/聊天共用 flow-generator 单一服务 */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setGenerateOpen(true)}
          >
            <Icon name="bot" style={{ width: 14, height: 14 }} />
            {t('一句话生成')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            {t('新建 Flow')}
          </button>
        </div>

        {/* Error banner — transient failures (e.g. a run that failed) surface
            here WITHOUT blanking the list below. */}
        {listError && flows.length > 0 ? (
          <div
            className="agents-error"
            role="alert"
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}
          >
            <span style={{ color: 'var(--danger)' }}>{listError}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setListError(null)}>
              {t('关闭')}
            </button>
          </div>
        ) : null}

        <div className="flow-cards">
          {loadingList ? (
            <SkeletonList rows={5} variant="card" />
          ) : listError && flows.length === 0 ? (
            /* Initial load failed and there is nothing to show — full-state
             * error with retry. (A failure with a rendered list shows as the
             * banner above instead of blanking it.) */
            <div className="empty-state">
              <div className="h" style={{ color: 'var(--danger)' }}>{listError}</div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setReloadListTick((n) => n + 1)}
              >
                <Icon name="refresh" style={{ width: 12, height: 12 }} />
                {t('重试')}
              </button>
            </div>
          ) : visibleFlows.length === 0 ? (
            home && flows.length === 0 ? (
              /* Workflow-First 首页空态（PRD F1）：三入口 + 模板横滑卡。
               * 仅「真没有任何 Flow」时展示；筛选无结果仍走旧空态。 */
              <FlowsEmptyHero
                onTemplate={() => setTemplateOpen(true)}
                onGenerate={() => setGenerateOpen(true)}
                onCreate={() => setCreateOpen(true)}
              />
            ) : (
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">⚡</div>
              <div className="h">{flows.length === 0 ? t('还没有 Flow') : t('没有匹配的 Flow')}</div>
              <div className="d">
                {flows.length === 0
                  ? t('创建你的第一个 Flow，编排 Agent 协作流程。')
                  : t('试试调整筛选条件或清除搜索。')}
              </div>
              {flows.length === 0 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setCreateOpen(true)}
                >
                  <Icon name="plus" style={{ width: 14, height: 14 }} />
                  {t('新建 Flow')}
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
                  {t('清除过滤器')}
                </button>
              )}
            </div>
            )
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
                    aria-label={t('展开 flow {name} 的运行记录', { name: f.name })}
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
                        <span className="mono" title={f.id}>{f.id.slice(0, 8)}</span>
                        {f.versionHash ? <span>{`sha ${f.versionHash.slice(0, 7)}`}</span> : null}
                        {/* EN 复数：n=1 用单数词条（词典无复数基建，按可见场景单值处理） */}
                        <span>{f.nodeCount === 1 ? t('1 节点') : t('{n} 节点', { n: f.nodeCount })}</span>
                        {f.runCount === 1 ? (
                          <span>{t('1 次运行')}</span>
                        ) : f.runCount > 1 ? (
                          <span>{t('{n} 次运行', { n: f.runCount })}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flow-card-meta">
                      {/* workflows 列表不携带运行状态 — 渲染中性的「未触发」，
                          不伪造带状态点的 idle 指示灯 */}
                      <span className="muted" style={{ fontSize: 12 }} title={t('尚无运行状态数据')}>
                        {t('未触发')}
                      </span>
                      {f.latestRunId ? (
                        <span className="chip chip-outline mono" style={{ fontSize: 10 }} title={f.latestRunId}>
                          {truncateMiddle(f.latestRunId, 8)}
                        </span>
                      ) : null}
                    </div>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-action="edit"
                        data-flow-id={f.id}
                        title={t('在画布中编辑')}
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/workflows/${encodeURIComponent(f.id)}/canvas`)
                        }}
                      >
                        {t('编辑画布')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-accent btn-sm"
                        data-action="run"
                        data-flow-id={f.id}
                        title={t('运行此 flow')}
                        disabled={runningId === f.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          // 先开输入面板（输入 + 项目目录），提交才发起异步运行
                          setRunDialogFlow({ id: f.id, name: f.name })
                        }}
                      >
                        {runningId === f.id ? t('运行中…') : t('运行')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title={t('删除此 Flow')}
                        disabled={deletingFlowPending && deletingFlowId === f.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeletingFlowId(deletingFlowId === f.id ? null : f.id)
                        }}
                      >
                        <Icon name={deletingFlowPending && deletingFlowId === f.id ? 'loader' : 'close'} style={{ width: 12, height: 12 }} />
                        <span>{t('删除')}</span>
                      </button>
                    </div>
                  </div>
                  {deletingFlowId === f.id ? (
                    <div
                      className="chat-nav-chat-delete-confirm"
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-4)' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span>{t('删除 Flow「{name}」？此操作不可撤销。', { name: f.name })}</span>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={deletingFlowPending}
                        onClick={() => void confirmDeleteFlow(f.id)}
                      >
                        {deletingFlowPending ? t('删除中…') : t('删除')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={deletingFlowPending}
                        onClick={() => setDeletingFlowId(null)}
                      >
                        {t('取消')}
                      </button>
                    </div>
                  ) : null}
                  <div className="flow-runs">
                    {/* 单 Flow 运行历史（2026-08-30 打通：原为静态提示行）。
                     * 发起运行后 runsTick bump → 面板重拉新 run；running 行
                     * 由面板自身 3s 轮询收尾。 */}
                    <FlowRunsPanel flowId={f.id} refreshTick={runsTick} />
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
          aria-label={t('返回 AgentFlows 列表')}
        >
          <Icon name="arrow" style={{ width: 14, height: 14, transform: 'rotate(180deg)' }} />
          {t('返回 Flow 列表')}
        </button>

        <div className="flow-layout">
          <div className="flow-canvas-wrap">
            <div className="flow-canvas-head">
              <div className="title">
                {detail ? `${detail.name} — ${truncateMiddle(selectedRunId ?? detail.latestExecutionId ?? '—', 8)}` : loadingDetail ? t('加载中…') : '—'}
              </div>
              {detail ? (
                <>
                  <span className="ver">
                    {detail.type}
                    {detail.versionHash ? ` · sha ${detail.versionHash.slice(0, 7)}` : ''}
                  </span>
                  <span className={`status ${detail.status}`}>
                    <span className="dot" />
                    {t(STATUS_CN[detail.status])}
                  </span>
                  {/* 在画布中旁观此运行（节点徽章 + 连线点亮实时/回放） */}
                  <a
                    className="btn btn-accent btn-sm"
                    href={`/workflows/${selectedFlowId}/canvas?run=${activeRunId}`}
                    title={t('在画布中查看此运行的节点级进度')}
                  >
                    {t('画布查看')}
                  </a>
                </>
              ) : null}
            </div>
            {detailError ? (
              <div className="muted" style={{ padding: 'var(--space-6)', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <span>{detailError}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setReloadDetailTick((n) => n + 1)}
                >
                  <Icon name="refresh" style={{ width: 12, height: 12 }} />
                  {t('重试')}
                </button>
              </div>
            ) : mergedFlow ? (
              <FlowDag flow={mergedFlow} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
            ) : (
              <div className="muted" style={{ padding: 'var(--space-6)' }}>
                {loadingDetail ? t('加载 DAG…') : '—'}
              </div>
            )}
            <div className="legend-flow">
              <span className="li"><span className="sw running" />{t('运行')}</span>
              <span className="li"><span className="sw done" />{t('完成')}</span>
              <span className="li"><span className="sw queued" />{t('排队')}</span>
              <span className="li"><span className="sw failed" />{t('失败')}</span>
              <span className="li"><span className="sw paused" />{t('人工暂停')}</span>
              <span className="li"><span className="sw idle" />{t('未触发')}</span>
              <span className="li" style={{ marginLeft: 'auto', color: 'var(--meta)' }}>{t('滚轮缩放 · 拖拽平移')}</span>
            </div>
          </div>

          <div className="flow-inspector">
            <div className="flow-insp-head">
              <div className="type">{selectedNode ? t('{type} 节点', { type: selectedNode.type }) : t('Flow 概览')}</div>
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

      {/* 流程模板中心（docs/flow-templates.md）：内置 / 团队场景 / 我的模板 */}
      <FlowTemplateGallery
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
      />
      <GenerateFlowDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreated={(flowId) => {
          setReloadListTick((n) => n + 1)
          router.push(`/workflows/${flowId}/canvas`)
        }}
      />

      {/* 运行输入对话框（对齐画布运行面板）：提交即关（画布同款），POST
       * 失败落在顶部 banner —— 详情页接管进度轮询。 */}
      {runDialogFlow ? (
        <FlowRunDialog
          flowName={runDialogFlow.name}
          directories={runDirectories}
          dirId={runDirId}
          onDirChange={(id) => {
            setRunDirId(id)
            try {
              window.localStorage.setItem('dagents.canvas.runDir', id)
            } catch {
              /* 私隐模式等场景忽略 */
            }
          }}
          onCancel={() => setRunDialogFlow(null)}
          onSubmit={(input) => {
            const target = runDialogFlow
            setRunDialogFlow(null)
            void runFlow(target.id, input, runDirId)
          }}
        />
      ) : null}
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
  const { t } = useI18n()
  const node = detail?.nodes.find((n) => n.id === nodeId) ?? null
  const metrics = detail?.nodeMetrics[nodeId]

  if (!node) {
    return (
      <div className="flow-insp-section">
        <p className="muted" style={{ fontSize: 12 }}>{t('节点不存在。')}</p>
      </div>
    )
  }

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
        <div className="lbl">{t('状态')}</div>
        <dl className="run-meta">
          <dt>{t('节点状态')}</dt>
          <dd>
            <span className={`status ${node.status}`}>
              <span className="dot" />
              {t(STATUS_CN[node.status])}
            </span>
          </dd>
          {span ? (
            <>
              <dt>{t('落库状态')}</dt>
              <dd>
                <span className={`status ${span.status}`}>
                  <span className="dot" />
                  {t(SPAN_STATUS_CN[span.status] ?? span.status)}
                </span>
              </dd>
            </>
          ) : null}
          <dt>{t('所属 run')}</dt>
          <dd>{runId ? truncateMiddle(runId, 8) : (metrics?.executionId ? truncateMiddle(metrics.executionId, 8) : '—')}</dd>
          <dt>{t('所属 flow')}</dt>
          <dd>{detail?.id ? truncateMiddle(detail.id, 8) : '—'}</dd>
          <dt>{t('节点类型')}</dt>
          <dd>{node.nodeType ?? node.type ?? '—'}</dd>
          {span?.traceId ? (
            <>
              <dt>trace</dt>
              <dd className="mono" style={{ fontSize: 10 }}>{truncateMiddle(span.traceId, 8)}</dd>
            </>
          ) : null}
        </dl>
      </div>
      {node.description ? (
        <div className="flow-insp-section">
          <div className="lbl">{t('节点说明')}</div>
          <p className="muted" style={{ fontSize: 12 }}>{t(node.description)}</p>
        </div>
      ) : null}
      {node.config && Object.keys(node.config).length > 0 ? (
        <div className="flow-insp-section">
          <div className="lbl">{t('节点配置')}</div>
          <div className="io-box">{formatJson(node.config)}</div>
        </div>
      ) : null}
      <div className="flow-insp-section">
        <div className="lbl">{t('输入')}</div>
        <div className="io-box">{input}</div>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">{t('输出')}</div>
        <div className="io-box">{output}</div>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">{t('预算与计量')}</div>
        <dl className="run-meta">
          <dt>{t('预算上限')}</dt>
          <dd>—</dd>
          <dt>{t('已用 tokens')}</dt>
          <dd>{tokenTotal != null ? formatTokens(tokenTotal) : '—'}</dd>
          <dt>{t('已用成本')}</dt>
          <dd>{span?.cost != null ? `$${span.cost.toFixed(4)}` : '—'}</dd>
          <dt>{t('耗时')}</dt>
          <dd>{span?.durationMs != null ? formatDuration(span.durationMs) : '—'}</dd>
          <dt>{t('超时')}</dt>
          <dd>—</dd>
        </dl>
        {span?.error ? (
          <p className="muted" style={{ fontSize: 11, marginTop: 'var(--space-2)', color: 'var(--danger)' }}>
            {t('节点错误：{msg}', { msg: span.error.slice(0, 200) })}
          </p>
        ) : null}
        {!span ? (
          <p className="muted" style={{ fontSize: 11, marginTop: 'var(--space-2)' }}>
            {t('节点级 token/成本/耗时来自 M6.4 节点级 trace 落库；该 run 暂无落库 span。')}
          </p>
        ) : null}
      </div>
      <div className="flow-insp-section">
        <div className="lbl">{t('日志')}</div>
            {metrics && metrics.logs.length > 0 ? (
          <div className="log" style={{ maxHeight: 220 }}>
            {metrics.logs.map((l, i) => (
              <div className="log-line" key={i}>
                <span className="log-ts">{isoTime(l.ts)}</span>
                <span className={`log-lvl ${l.level}`}>{l.level.toUpperCase()}</span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>{t('暂无日志')}</div>
        )}
      </div>
    </>
  )
}

/** Right-column inspector when no node is selected — the flow's overall state. */
function FlowOverview({ detail }: { detail: FlowDetailView | null }): React.ReactElement {
  const { t } = useI18n()
  if (!detail) {
    return (
      <div className="flow-insp-section">
        <p className="muted" style={{ fontSize: 12 }}>{t('选择一个 flow 查看概览。')}</p>
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
        <div className="lbl">{t('Flow 状态')}</div>
        <dl className="run-meta">
          <dt>{t('整体状态')}</dt>
          <dd>
            <span className={`status ${detail.status}`}>
              <span className="dot" />
              {t(STATUS_CN[detail.status])}
            </span>
          </dd>
          <dt>{t('节点数')}</dt>
          <dd>{detail.nodes.length}</dd>
          <dt>{t('最近 run')}</dt>
          <dd>{detail.latestExecutionId ? truncateMiddle(detail.latestExecutionId, 8) : '—'}</dd>
          <dt>{t('更新时间')}</dt>
          <dd>{formatDateTime(detail.updatedAt)}</dd>
        </dl>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">{t('节点状态分布')}</div>
        <dl className="run-meta">
          {(Object.keys(STATUS_CN) as NodeRunStatus[]).map((s) => (
            <span key={s} style={{ display: 'contents' }}>
              <dt>{t(STATUS_CN[s])}</dt>
              <dd>{byStatus[s] ?? 0}</dd>
            </span>
          ))}
        </dl>
      </div>
      <div className="flow-insp-section">
        <div className="lbl">{t('提示')}</div>
        <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
          {t('点击 DAG 中的节点查看其状态与日志。画布只读浏览；编排请到 Workflow 画布完成。')}
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

function formatJson(obj: unknown): string {
  try {
    const s = JSON.stringify(obj, null, 2)
    return s.length > 2000 ? s.slice(0, 2000) + '\n…' : s
  } catch {
    return String(obj)
  }
}

/**
 * Best-effort extraction of a node's input/output text for the inspector's
 * io-boxes (design L526-533). Output follows the 结果面板 v2 哲学：span 落库
 * 的 `{text, content}` 双键直接解包正文直出（流式 partial 与终态全文同款，
 * 2026-08-30），否则 JSON 格式化；没有记录时显示 "—" —— design 的占位符。
 * This keeps the io-box DOM present (the audit's fidelity gap was the missing
 * section, not a specific value) while not fabricating io that wasn't persisted.
 */
function extractIo(span: RunNodeSpan | undefined): { input: string; output: string } {
  if (!span) return { input: '—', output: '—' }
  const inputStr = span.input ? formatJson(span.input) : '—'
  const outputStr = span.output ? unwrapSpanText(span.output) : '—'
  return { input: inputStr, output: outputStr }
}

/** `{text}|{content}` 解包为正文（>2000 截断），其余回落 JSON。 */
function unwrapSpanText(v: unknown): string {
  if (typeof v === 'string') {
    return v.length > 2000 ? v.slice(0, 2000) + '\n…' : v
  }
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const text = rec.text ?? rec.content
    if (typeof text === 'string' && text.length > 0) {
      return text.length > 2000 ? text.slice(0, 2000) + '\n…' : text
    }
    return formatJson(v)
  }
  return formatJson(v)
}

