'use client'

/**
 * Agents 管理页 — multica-inspired clean list layout.
 *
 * Design principles ported from ~/Projects/multica:
 * - 克制即高级: no KPI row, no kanban; just a clean, scannable list
 * - 层次靠灰度: text-foreground / text-muted-foreground / text-meta
 * - 字号纪律: text-sm is the primary size; text-xs for metadata
 * - Hover vs Active: hover lightens bg; active adds font-weight
 * - 间距 > 分割线: spacing carries separation, not borders
 *
 * Detail view: page-based navigation to /agents/[id], not a drawer.
 * The dedicated AgentDetailView page handles the full detail layout.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageShell } from '@/components/page-shell'
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import '@/styles/agents.css'
import {
  type AgentFilters,
  type AgentKind,
  type AgentStatus,
  type CatalogAgent,
  NO_FILTERS,
  filterAgents,
  fetchAgents,
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

const STATUS_DOT_CLASS: Record<AgentStatus, string> = {
  running: 'dot-running',
  queued: 'dot-queued',
  idle: 'dot-idle',
  failed: 'dot-failed',
  paused: 'dot-paused',
  done: 'dot-done',
}

const KIND_FILTERS: AgentKind[] = ['prompt', 'claude', 'codex', 'remote']
const STATUS_FILTERS: AgentStatus[] = ['running', 'queued', 'idle', 'failed']

type Scope = 'mine' | 'all' | 'archived'
const SCOPE_TABS: { key: Scope; label: string }[] = [
  { key: 'mine', label: '我的' },
  { key: 'all', label: '全部' },
  { key: 'archived', label: '已归档' },
]

type SortField = 'name' | 'load'

function isArchived(a: CatalogAgent): boolean {
  return a.status === 'failed' || a.status === 'paused'
}

function compareAgents(a: CatalogAgent, b: CatalogAgent, field: SortField): number {
  if (field === 'name') return a.name.localeCompare(b.name)
  if (a.load !== b.load) return a.load - b.load
  return a.name.localeCompare(b.name)
}

function glyphClass(kind: AgentKind): string {
  return `agent-glyph kind-${kind}`
}

export function AgentsView(): React.ReactElement {
  const router = useRouter()
  const [agents, setAgents] = useState<CatalogAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<AgentFilters>(NO_FILTERS)
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<{ field: SortField; dir: 'asc' | 'desc' }>({
    field: 'name',
    dir: 'asc',
  })
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { agents: rows } = await fetchAgents()
      setAgents(rows)
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

  const scopeCounts = useMemo(() => {
    const c = { mine: 0, all: 0, archived: 0 }
    for (const a of agents) {
      if (isArchived(a)) c.archived++
      else c.all++
    }
    return c
  }, [agents])

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
    return [...filtered].sort((a, b) => compareAgents(a, b, sort.field) * dir)
  }, [scoped, filters, sort])

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

  const handleCreated = useCallback(
    (id: string) => {
      setCreateOpen(false)
      router.push(`/agents/${id}`)
    },
    [router],
  )

  const onRowClick = useCallback(
    (id: string) => {
      router.push(`/agents/${id}`)
    },
    [router],
  )

  return (
    <PageShell
      actions={
        <>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCreateOpen(true)}
          >
            + 新建 Agent
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load()}
          >
            刷新
          </button>
        </>
      }
    >
      {/* scope tabs */}
      <div className="scope-tabs" role="tablist" aria-label="agent 范围">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={scope === t.key}
            data-scope={t.key}
            onClick={() => setScope(t.key)}
          >
            {t.label}
            <span className="cnt">{scopeCounts[t.key]}</span>
          </button>
        ))}
      </div>

      {/* toolbar */}
      <div className="agents-toolbar">
        <div className="filter-group">
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              className="filter-chip"
              aria-pressed={filters.kind === k}
              onClick={() => toggleFilter('kind', k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="filter-group">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className="filter-chip"
              aria-pressed={filters.status === s}
              onClick={() => toggleFilter('status', s)}
            >
              {STATUS_LABEL[s]}
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
        <span className="result-count">
          {visibleSorted.length} / {scoped.length}
        </span>
      </div>

      {error ? (
        <div className="agents-error">
          加载失败：{error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {/* list */}
      <div className="agents-list">
        {loading && agents.length === 0 ? (
          <div className="agents-empty">加载中…</div>
        ) : visibleSorted.length === 0 && !error ? (
          <div className="agents-empty">暂无 agent</div>
        ) : (
          <>
            {/* header */}
            <div className="agents-list-header">
              <button
                type="button"
                className={`list-header-cell sortable${sort.field === 'name' ? ' active' : ''}`}
                data-dir={sort.field === 'name' ? sort.dir : 'asc'}
                onClick={() => onSortClick('name')}
              >
                Agent
              </button>
              <span className="list-header-cell">类型</span>
              <span className="list-header-cell">状态</span>
              <span className="list-header-cell">当前 run</span>
              <button
                type="button"
                className={`list-header-cell sortable${sort.field === 'load' ? ' active' : ''}`}
                data-dir={sort.field === 'load' ? sort.dir : 'asc'}
                onClick={() => onSortClick('load')}
              >
                负载
              </button>
              <span className="list-header-cell">成本</span>
            </div>
            {/* rows */}
            {visibleSorted.map((a) => (
              <div
                key={a.id}
                className="agents-row"
                role="button"
                tabIndex={0}
                onClick={() => onRowClick(a.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onRowClick(a.id)
                  }
                }}
              >
                <div className="cell-name">
                  <div className={glyphClass(a.kind)}>{KIND_GLYPH[a.kind]}</div>
                  <div className="name-info">
                    <span className="name">{a.name}</span>
                    <span className="id">{a.id.slice(0, 8)}</span>
                  </div>
                </div>
                <div className="cell-kind">
                  <span className="kind-label">{KIND_LABEL[a.kind]}</span>
                </div>
                <div className="cell-status">
                  <span className={`status-dot ${STATUS_DOT_CLASS[a.status]}`} />
                  <span className="status-label">{STATUS_LABEL[a.status]}</span>
                </div>
                <div className="cell-run mono">{a.run ?? '—'}</div>
                <div className="cell-load">
                  <div className="load-bar">
                    <span
                      className={`load-fill${a.load > 85 ? ' danger' : a.load > 70 ? ' warn' : ''}`}
                      style={{ width: `${a.load}%` }}
                    />
                  </div>
                  <span className="load-val mono">{a.load}%</span>
                </div>
                <div className="cell-cost mono">{a.cost}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* create dialog */}
      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </PageShell>
  )
}
