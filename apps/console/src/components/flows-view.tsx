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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { CreateFlowDialog } from '@/components/create-flow-dialog'
import { FlowTemplateGallery } from '@/components/flow-template-gallery'
import { GenerateFlowDialog } from '@/components/generate-flow-dialog'
import { FlowsEmptyHero } from '@/components/flows-empty-hero'
import { FlowRunDialog } from '@/components/flow-run-dialog'
import { FlowRunsPanel } from '@/components/flow-runs-panel'
import { SkeletonList } from '@/components/skeleton'
import { useToast } from '@/components/toast'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { type FlowSummary } from '@/lib/flows'
import { truncateMiddle } from '@/lib/format'
import { useI18n } from '@/i18n'
import '@/styles/flows.css'

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



export function FlowsView({ home = false }: { home?: boolean }): React.ReactElement {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const [flows, setFlows] = useState<FlowSummary[]>([])
  // ── list-page state (M2.1) ──────────────────────────────────────────────
  const [scope, setScope] = useState<Scope>('all')
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
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
  // 卡片运行历史面板的刷新 tick：发起运行成功后 bump（新 run 立即可见）。
  const [runsTick, setRunsTick] = useState(0)

  /** Run a flow by POSTing to the gateway's /:id/run endpoint, then jump to
   *  the canvas watch view (`?run=`) so the user sees live progress. 异步模式
   *  （?async=1）：网关先落一行 running、后台执行、**立即**返回 runId ——
   *  同步等待会把 HTTP 响应压到整个流程跑完（CLI Agent 动辄几分钟），
   *  期间页面无跳转无进度，用户感知「点了没反应」。一次运行一个家：
   *  发起落点与历史行、chat 入口一致，都是画布旁观（2026-08-30 三方
   *  协商 —— 详情页退役）。输入作为 `{{$start.input}}` 传入；directoryId
   *  决定 CLI Agent 的工作目录。Failures land in the top banner. */
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
        setRunsTick((n) => n + 1)
        // 画布旁观接管：徽章/连线/live tail（原详情页已退役）
        router.push(`/workflows/${flowId}/canvas?run=${runId}`)
      } else {
        // Success but no run id — don't leave the user at a dead end.
        toast.warning(t('运行已提交，但未能获取运行 ID'))
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningId(null)
    }
  }, [router, t, toast])

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

  return (
    <PageShell fullBleed>
      {/* LIST page（2026-08-30 三方协商后为唯一形态：详情页退役，一次运行
          一个家 = 画布旁观 —— 发起运行/历史行/chat 入口统一跳 ?run=）。 */}
      <div className="flow-list-page active">
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
