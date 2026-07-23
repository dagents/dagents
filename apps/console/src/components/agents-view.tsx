'use client'

/**
 * Agents 管理页 (M5a.2 / P1.10.T4).
 *
 * Replaces the M5a.1 empty shell with a real, filterable agents page backed by
 * live `agent_daemons` / `dispatch_tasks` data, plus a detail drawer showing
 * the capability descriptor, current run, resource sparkline, and log stream.
 *
 * Data flow: this client component fetches `/api/agents` (→ gateway → dispatch
 * `GET /agents`) on mount, derives the KPI row + list/kanban from the result,
 * and fetches `/api/agents/:id` + `/api/agents/:id/logs` when a row is opened.
 *
 * The DOM + class names mirror design/agents.html (ported to React); page-local
 * styles live in styles/agents.css. Shell.css provides the shared component
 * classes (.kpi-row/.toolbar/.chip/.segmented/.drawer/.kv/.bar/.status/.log).
 *
 * v0.3-M5.1 design-fidelity delta: scope tabs (mine / all / archived) +
 * result-count `N / total` + sortable list headers (`data-sort` /
 * `data-active`), ported from agents.html:169-172, 228-239, 463-476. The
 * filter chips also gained `data-f` / `data-v` (matching the design's
 * menu-driven model) on top of the existing `aria-pressed` toggle.
 *
 * Out of scope (M5b): the drawer foot buttons ("派发任务" / "停用") render but
 * are no-ops — dispatch invoke from the console UI is a later task.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import '@/styles/agents.css'
import {
  type AgentDetail,
  type AgentFilters,
  type AgentKind,
  type AgentLogLine,
  type AgentStatus,
  type CatalogAgent,
  NO_FILTERS,
  deriveKpis,
  filterAgents,
  fetchAgents,
  fetchAgentDetail,
  fetchAgentLogs,
  sumUsageTokens,
} from '@/lib/agents-catalog'

const KIND_LABEL: Record<AgentKind, string> = {
  prompt: '提示词',
  claude: 'Claude Code',
  codex: 'Codex',
  remote: 'Remote',
}
const KIND_GLYPH: Record<AgentKind, string> = { prompt: 'P', claude: 'C', codex: 'X', remote: 'R' }

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: '运行',
  queued: '排队',
  idle: '空闲',
  failed: '失败',
  paused: '人工暂停',
  done: '完成',
}

const KIND_FILTERS: AgentKind[] = ['prompt', 'claude', 'codex', 'remote']
const STATUS_FILTERS: AgentStatus[] = ['running', 'queued', 'idle', 'failed']
const ROLE_FILTERS = ['reader', 'coding', 'verify', 'orchestrator']

/** The three scope tabs (agents.html:169-172). `archived` collects the
 *  design's failed + paused rows (see `isArchived`); `mine` is always 0 today
 *  because the catalogue carries no owner — the tab still renders so the
 *  design's scope affordance is present, mirroring flows-view.tsx. */
type Scope = 'mine' | 'all' | 'archived'
const SCOPE_TABS: { key: Scope; label: string }[] = [
  { key: 'mine', label: '我的' },
  { key: 'all', label: '全部' },
  { key: 'archived', label: '已归档' },
]

/** Sortable list headers (agents.html:228-239). The catalogue has no
 *  last-active timestamp and no run-count column (M5a.2 list layout), so the
 *  design's `lastActive`/`runs` fields are dropped — the only columns the table
 *  actually exposes sort on are `name` (Agent) and `load` (负载). Both keep the
 *  design's `data-sort` affordance so the design's CSS still targets them. */
type SortField = 'name' | 'load'
const SORT_LABEL: Record<SortField, string> = {
  name: '名称',
  load: '负载',
}

/** `archived` = the design's failed/paused rows (agents.html:420-424). */
function isArchived(a: CatalogAgent): boolean {
  return a.status === 'failed' || a.status === 'paused'
}

/** Compare two agents by the active sort field (agents.html:447-461). Returns
 *  the natural (ascending) order; the caller multiplies by `dir` to flip — the
 *  design's `sortRows` follows the same `comparator * dir` pattern. */
function compareAgents(a: CatalogAgent, b: CatalogAgent, field: SortField): number {
  if (field === 'name') return a.name.localeCompare(b.name)
  // load — numeric ascending (lowest first); `desc` flips to busiest first.
  // Equal loads fall back to name (the design's tiebreaker) for stable order.
  if (a.load !== b.load) return a.load - b.load
  return a.name.localeCompare(b.name)
}

const KANBAN_COLS: { key: AgentStatus; label: string; dot: string }[] = [
  { key: 'running', label: '运行中', dot: 'var(--accent)' },
  { key: 'queued', label: '排队', dot: 'var(--warn)' },
  { key: 'idle', label: '空闲', dot: 'var(--meta)' },
  { key: 'paused', label: '人工暂停', dot: 'var(--info)' },
  { key: 'failed', label: '失败', dot: 'var(--danger)' },
]

function glyphClass(kind: AgentKind): string {
  return `agent-glyph kind-${kind}`
}

interface SortableHeadProps {
  field: SortField
  label: string
  active: SortField
  dir: 'asc' | 'desc'
  onClick: (field: SortField) => void
}

/** A sortable `<th>` header button (agents.html:228-239, 471-476): carries
 *  `data-sort` so the design's CSS targets it, `data-active` when it is the
 *  field the list is currently sorted by, and `data-dir` for the current sort
 *  direction (asc/desc) so the arrow glyph can rotate to reflect it. Rendered
 *  as a `<button>` so the click target is keyboard-accessible (the design's
 *  `.h.sortable` is a div; the React port uses a button for a11y, with the same
 *  data attributes). */
function SortableHead({ field, label, active, dir, onClick }: SortableHeadProps): React.ReactElement {
  const isActive = active === field
  return (
    <button
      type="button"
      className="sortable-head"
      data-sort={field}
      data-active={isActive ? 'true' : 'false'}
      data-dir={isActive ? dir : 'asc'}
      aria-label={`${label}（${SORT_LABEL[field]}），${isActive ? `${dir === 'asc' ? '升序' : '降序'}，点击切换方向` : '点击升序排列'}`}
      onClick={() => onClick(field)}
    >
      {label}
    </button>
  )
}

/** Format an elapsed-ms duration as `4m12s` / `2m01s` / `排队 2m`. */
function formatDuration(ms: number | null, status: AgentStatus | null): string {
  if (ms == null || ms < 0) return status === 'queued' ? '排队中' : '—'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h${String(m % 60).padStart(2, '0')}m`
  }
  return `${m}m${String(s).padStart(2, '0')}s`
}

export function AgentsView(): React.ReactElement {
  const [agents, setAgents] = useState<CatalogAgent[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<AgentFilters>(NO_FILTERS)
  const [view, setView] = useState<'list' | 'kanban'>('list')
  const [openId, setOpenId] = useState<string | null>(null)
  // scope tabs (agents.html:416-418) + sortable header (agents.html:471-476).
  // `all` is the design's default scope; `load`/`desc` its default sort — the
  // design's `lastActive` has no catalogue source (no last-active timestamp,
  // no run-count column), so the default sort anchors on the 负载 column that
  // exists, reading "busiest first" under desc.
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<{ field: SortField; dir: 'asc' | 'desc' }>({
    field: 'load',
    dir: 'desc',
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { agents: rows, truncated: t } = await fetchAgents()
      setAgents(rows)
      setTruncated(t)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setAgents([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const kpis = useMemo(() => deriveKpis(agents), [agents])

  // Scope counts — mine / all / archived over the full fetched set (the
  // design's `updateScopeCounts`, agents.html:426-435). `mine` is always 0:
  // the catalogue has no owner, so the tab renders 0 like flows-view.tsx.
  const scopeCounts = useMemo(() => {
    const c = { mine: 0, all: 0, archived: 0 }
    for (const a of agents) {
      if (isArchived(a)) c.archived++
      else c.all++
    }
    return c
  }, [agents])

  // The agents visible under the current scope + filters, then sorted — the
  // design's `visibleRows()` (agents.html:463-471) + `sortRows()` (447-461).
  const scoped = useMemo(
    () =>
      agents.filter((a) => {
        if (scope === 'archived') return isArchived(a)
        if (isArchived(a)) return false
        return true
      }),
    [agents, scope],
  )
  const visibleSorted = useMemo(() => {
    const filtered = filterAgents(scoped, filters)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort(
      (a, b) => compareAgents(a, b, sort.field) * dir,
    )
  }, [scoped, filters, sort])

  /** Click a sortable header: first click selects it (asc), a repeat click
   *  flips the direction — matching agents.html:471-476's field/driver model. */
  const onSortClick = useCallback((field: SortField) => {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' },
    )
  }, [])

  const toggleFilter = useCallback(
    <K extends 'kind' | 'status' | 'role'>(key: K, value: string) => {
      setFilters((prev) => ({
        ...prev,
        [key]: prev[key] === value ? null : (value as AgentFilters[K]),
      }))
    },
    [],
  )

  return (
    <PageShell
      title="Agents"
      subtitle="提示词 agent（Flowise 原生）与异构 CLI agent（经 Agent Daemon 接入）。点击行查看能力描述符、当前 run 与资源占用。"
      actions={
        <>
          <div className="segmented view-seg" role="group" aria-label="视图">
            <button
              type="button"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              列表
            </button>
            <button
              type="button"
              aria-pressed={view === 'kanban'}
              onClick={() => setView('kanban')}
            >
              看板
            </button>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            刷新
          </button>
        </>
      }
    >
      {/* KPI row */}
      <div className="kpi-row mb-6">
        <div className="kpi">
          <div className="kpi-label">注册 agents</div>
          <div className="kpi-value">{kpis.total.toLocaleString()}</div>
          <div className="kpi-sub">{truncated ? '已截断至 500' : '全量'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">运行中</div>
          <div className="kpi-value">{kpis.running.toLocaleString()}</div>
          <div className="kpi-sub">
            {kpis.total > 0 ? `${Math.round((kpis.running / kpis.total) * 100)}% 占比` : '—'}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">平均负载</div>
          <div className="kpi-value">{kpis.total > 0 ? `${kpis.avgLoad}%` : '—'}</div>
          <div className="kpi-sub">基于当前任务</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">失败率</div>
          <div className="kpi-value">{kpis.total > 0 ? `${kpis.failedRate}%` : '—'}</div>
          <div className="kpi-sub">最近任务</div>
        </div>
      </div>

      {/* scope tabs (agents.html:169-172) */}
      <div className="scope-tabs mb-6" role="tablist" aria-label="agent 范围">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={scope === t.key}
            data-scope={t.key}
            onClick={() => setScope(t.key)}
          >
            {t.label} <span className="cnt">{scopeCounts[t.key]}</span>
          </button>
        ))}
      </div>

      {/* filters */}
      <div className="toolbar">
        <div className="filter-group">
          <span className="filter-label">类型</span>
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              className="filter-chip"
              data-f="kind"
              data-v={k}
              aria-pressed={filters.kind === k}
              onClick={() => toggleFilter('kind', k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-label">状态</span>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className="filter-chip"
              data-f="status"
              data-v={s}
              aria-pressed={filters.status === s}
              onClick={() => toggleFilter('status', s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-label">角色</span>
          {ROLE_FILTERS.map((r) => (
            <button
              key={r}
              type="button"
              className="filter-chip"
              data-f="role"
              data-v={r}
              aria-pressed={filters.role === r}
              onClick={() => toggleFilter('role', r)}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input agents-search"
          placeholder="搜索 name / id / kind…"
          aria-label="搜索 agents"
          value={filters.q}
          onChange={(e) => setFilters((p) => ({ ...p, q: e.target.value }))}
        />
        <div className="grow" />
        <span className="result-count" data-testid="result-count">
          {visibleSorted.length} / {scoped.length}
        </span>
      </div>

      {error ? (
        <div className="card-flat" style={{ padding: 'var(--space-4)', color: 'var(--danger)' }}>
          加载失败：{error}。点 <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>刷新</button> 重试。
        </div>
      ) : null}

      {/* views */}
      <div className="view-toggle" data-view={view}>
        <div className="table-wrap">
          {loading && agents.length === 0 ? (
            <div className="muted" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
              加载中…
            </div>
          ) : visibleSorted.length === 0 && !error ? (
            <div className="muted" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
              暂无 agent
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: '28%' }} aria-sort={sort.field === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <SortableHead
                      field="name"
                      label="Agent"
                      active={sort.field}
                      dir={sort.dir}
                      onClick={onSortClick}
                    />
                  </th>
                  <th>类型</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>当前 run</th>
                  <th>区域</th>
                  <th aria-sort={sort.field === 'load' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <SortableHead
                      field="load"
                      label="负载"
                      active={sort.field}
                      dir={sort.dir}
                      onClick={onSortClick}
                    />
                  </th>
                  <th>今日成本</th>
                  <th aria-label="打开详情" />
                </tr>
              </thead>
              <tbody>
                {visibleSorted.map((a) => (
                  <tr
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenId(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenId(a.id)
                      }
                    }}
                  >
                    <td>
                      <div className="agent-cell">
                        <div className={glyphClass(a.kind)}>{KIND_GLYPH[a.kind]}</div>
                        <div>
                          <div className="agent-name">{a.name}</div>
                          <div className="agent-id">{a.id.slice(0, 8)}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="chip chip-outline">{KIND_LABEL[a.kind]}</span>
                    </td>
                    <td>
                      <div className="agent-tags">
                        {a.roles.length > 0 ? (
                          a.roles.map((r) => (
                            <span key={r} className="chip chip-tag">
                              {r}
                            </span>
                          ))
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`status ${a.status}`}>
                        <span className="dot" />
                        {STATUS_LABEL[a.status]}
                      </span>
                    </td>
                    <td className="mono">{a.run ?? '—'}</td>
                    <td className="muted">{a.region}</td>
                    <td>
                      <div className="row gap-2">
                        <div
                          className={`bar ${a.load > 85 ? 'danger' : a.load > 70 ? 'warn' : ''}`}
                          style={{ width: 48 }}
                        >
                          <span style={{ width: `${a.load}%` }} />
                        </div>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {a.load}%
                        </span>
                      </div>
                    </td>
                    <td className="num">{a.cost}</td>
                    <td>
                      <span style={{ color: 'var(--meta)' }}>›</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="kanban">
          {KANBAN_COLS.map((col) => {
            const cards = visibleSorted.filter((a) => a.status === col.key)
            return (
              <div className="kanban-col" key={col.key}>
                <div className="kanban-head">
                  <span className="t">
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: col.dot,
                        display: 'inline-block',
                      }}
                    />
                    {col.label}
                  </span>
                  <span className="cnt">{cards.length}</span>
                </div>
                {cards.map((a) => (
                  <div
                    key={a.id}
                    className="kanban-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenId(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenId(a.id)
                      }
                    }}
                  >
                    <div className="top">
                      <div
                        className={glyphClass(a.kind)}
                        style={{ width: 24, height: 24, fontSize: 10 }}
                      >
                        {KIND_GLYPH[a.kind]}
                      </div>
                      <div className="nm">{a.name}</div>
                    </div>
                    <div className="meta">
                      <span>{KIND_LABEL[a.kind]}</span>
                      <span className="mono">{a.region}</span>
                    </div>
                    <div className="meta mt-2">
                      <span className={`status ${a.status}`}>
                        <span className="dot" />
                        {STATUS_LABEL[a.status]}
                      </span>
                      <span className="mono">{a.cost}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {/* drawer */}
      <AgentDrawer agentId={openId} onClose={() => setOpenId(null)} />
    </PageShell>
  )
}

interface AgentDrawerProps {
  agentId: string | null
  onClose: () => void
}

function AgentDrawer({ agentId, onClose }: AgentDrawerProps): React.ReactElement | null {
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [logs, setLogs] = useState<AgentLogLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape. Bound at the drawer level so it only fires while open.
  useEffect(() => {
    if (!agentId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agentId, onClose])

  useEffect(() => {
    if (!agentId) {
      setDetail(null)
      setLogs([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchAgentDetail(agentId), fetchAgentLogs(agentId)])
      .then(([d, l]) => {
        if (cancelled) return
        setDetail(d)
        setLogs(l)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setDetail(null)
        setLogs([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (!agentId) return null

  const agent = detail?.agent
  const glyph = agent ? glyphClass(agent.kind) : 'agent-glyph'
  const glyphChar = agent ? KIND_GLYPH[agent.kind] : ''

  return (
    <>
      <div
        className={`drawer-backdrop ${agentId ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`drawer ${agentId ? 'open' : ''}`} aria-label="Agent 详情">
        <div className="drawer-head">
          <div className={glyph}>{glyphChar}</div>
          <div className="title">{agent?.name ?? '加载中…'}</div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">
          {loading ? (
            <div className="muted" style={{ padding: 'var(--space-4)' }}>
              加载中…
            </div>
          ) : error ? (
            <div style={{ padding: 'var(--space-4)', color: 'var(--danger)' }}>
              加载失败：{error}
            </div>
          ) : agent ? (
            <DrawerBody detail={detail!} logs={logs} />
          ) : null}
        </div>
        <div className="drawer-foot">
          <button type="button" className="btn btn-danger btn-sm" disabled>
            停用
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled>
            查看 run
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled title="派发经 dispatch 接入（M5b）">
            派发任务
          </button>
        </div>
      </aside>
    </>
  )
}

interface DrawerBodyProps {
  detail: AgentDetail
  logs: AgentLogLine[]
}

function DrawerBody({ detail, logs }: DrawerBodyProps): React.ReactElement {
  const { agent, tasks, runs } = detail
  const cap = agent.capability
  const recentDurations = tasks
    .map((t) => t.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0)
  const sparkPath = buildSparklinePath(recentDurations)
  const todayTokens = tasks.reduce((s, t) => s + sumUsageTokens(t.usage), 0)

  return (
    <>
      <div className="section-label">元数据</div>
      <dl className="kv mb-6">
        <dt>Agent ID</dt>
        <dd className="mono">{agent.id}</dd>
        <dt>类型</dt>
        <dd>{KIND_LABEL[agent.kind]}</dd>
        <dt>角色标签</dt>
        <dd>{agent.roles.length > 0 ? agent.roles.join(' · ') : '—'}</dd>
        <dt>所属 daemon</dt>
        <dd className="mono">{agent.daemon}</dd>
        <dt>区域</dt>
        <dd>{agent.region}</dd>
        <dt>状态</dt>
        <dd>
          <span className={`status ${agent.status}`}>
            <span className="dot" />
            {STATUS_LABEL[agent.status]}
          </span>
        </dd>
      </dl>

      <div className="section-label">能力描述符</div>
      <div className="card-flat mb-6" style={{ padding: 'var(--space-4)' }}>
        <div className="row-between mb-2">
          <span className="muted" style={{ fontSize: 12 }}>
            输入 schema
          </span>
          <span className="mono" style={{ fontSize: 11 }}>
            {cap.inputSchema ?? '—'}
          </span>
        </div>
        <div className="row-between mb-2">
          <span className="muted" style={{ fontSize: 12 }}>
            输出 schema
          </span>
          <span className="mono" style={{ fontSize: 11 }}>
            {cap.outputSchema ?? '—'}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {cap.summary ?? '无描述'}
        </div>
      </div>

      <div className="section-label">当前任务</div>
      <div className="card-flat mb-6" style={{ padding: 'var(--space-4)' }}>
        <div className="row-between mb-2">
          <span style={{ fontWeight: 500 }}>{agent.run ?? '无活跃 run'}</span>
          <span className="chip chip-outline">
            {agent.latestTaskStatus ?? '—'}
          </span>
        </div>
        <div className="bar mb-2">
          <span style={{ width: `${agent.status === 'running' ? Math.min(100, Math.round((agent.elapsedMs ?? 0) / 60000) * 10 + 10) : agent.status === 'failed' ? 100 : 0}%` }} />
        </div>
        <div className="row-between">
          <span className="meta" style={{ fontSize: 11 }}>
            已用 {formatDuration(agent.elapsedMs, agent.status)}
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-hover)' }}>
            {agent.latestTaskStatus ?? '—'}
          </span>
        </div>
      </div>

      <div className="section-label">资源占用（最近 {tasks.length} 个任务）</div>
      <svg
        className="mini-spark mb-6"
        viewBox="0 0 240 36"
        preserveAspectRatio="none"
        aria-label="资源占用迷你图"
      >
        {sparkPath ? (
          <path d={sparkPath} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
        ) : (
          <text x="120" y="22" textAnchor="middle" fontSize="11" fill="var(--meta)">
            无历史数据
          </text>
        )}
      </svg>
      <div className="muted mb-6" style={{ fontSize: 11 }}>
        最近 token 用量 {todayTokens.toLocaleString()} · 任务 {tasks.length} · 绑定 run {runs.length}
      </div>

      <div className="section-label">最近日志</div>
      <div className="log">
        {logs.length === 0 ? (
          <div className="log-line">
            <span className="log-msg muted">暂无日志</span>
          </div>
        ) : (
          [...logs].reverse().map((l, i) => (
            <div className="log-line" key={`${l.ts}-${i}`}>
              <span className="log-ts">{l.ts.slice(11, 19)}</span>
              <span className={`log-lvl ${l.level}`}>{l.level.toUpperCase()}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}

/**
 * Build an SVG sparkline path from recent task durations (ms). Maps each
 * duration to a y in [4, 30] (taller = longer), spaced evenly across x.
 * Returns null when there are fewer than 2 points (can't draw a line).
 */
function buildSparklinePath(durationsMs: number[]): string | null {
  if (durationsMs.length < 2) return null
  const max = Math.max(...durationsMs, 1)
  const step = (240 - 4) / (durationsMs.length - 1)
  const pts = durationsMs.map((d, i) => {
    const x = 2 + i * step
    const ratio = Math.min(d / max, 1)
    const y = 30 - ratio * 26
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  })
  return pts.join(' ')
}
