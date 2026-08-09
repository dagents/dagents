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
import { Icon } from '@/components/icon'
import { CreateAgentDialog } from '@/components/create-agent-dialog'
import '@/styles/agents.css'
import {
  type AgentFilters,
  type AgentKind,
  type AgentStatus,
  type CatalogAgent,
  AGENT_KINDS,
  NO_FILTERS,
  filterAgents,
  fetchAgents,
  kindLabel,
  kindGlyph,
} from '@/lib/agents-catalog'

// Status display maps are still view-local (no shared source yet).
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

// Filter chips show the 主流 (mainstream) CLI kinds — the 6 most common —
// so the toolbar stays scannable. Less-common kinds (国产/ACP/特殊) are
// still selectable via the create dialog and searchable by name/id/kind;
// an unknown kind normalises to `remote`, which has its own chip.
const KIND_FILTERS: AgentKind[] = AGENT_KINDS
  .filter((m) => m.group === '主流')
  .map((m) => m.kind)
  .concat(['remote'])
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
      c.all++
      if (isArchived(a)) c.archived++
      else c.mine++
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
    <PageShell fullBleed>
      {/* scope tabs + actions on the same row */}
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs" role="tablist" aria-label="agent 范围">
          {SCOPE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={scope === t.key}
              data-scope={t.key}
              data-zero={scopeCounts[t.key] === 0 ? 'true' : undefined}
              onClick={() => setScope(t.key)}
            >
              {t.label}
              <span className="cnt">{scopeCounts[t.key]}</span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="result-count">
          {visibleSorted.length} / {scoped.length} 个 agent
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void load()}
        >
          刷新
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          新建 Agent
        </button>
      </div>

      {/* toolbar — search + filter chips */}
      <div className="agents-toolbar">
        <div className="agents-search">
          <Icon name="search" style={{ width: 14, height: 14, color: 'var(--meta)' }} />
          <input
            type="search"
            placeholder="搜索名称 / ID / 类型…"
            aria-label="搜索 agents"
            value={filters.q}
            onChange={(e) => setFilters((p) => ({ ...p, q: e.target.value }))}
          />
        </div>
        {KIND_FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            className="filter-chip"
            aria-pressed={filters.kind === k}
            onClick={() => toggleFilter('kind', k)}
          >
            {kindLabel(k)}
          </button>
        ))}
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
        <div className="grow" />
      </div>

      {error ? (
        <div className="agents-error">
          加载失败：{error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {/* card list — mirrors flow-card visual language */}
      <div className="agent-cards">
        {loading && agents.length === 0 ? (
          <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
            加载 agent 列表…
          </div>
        ) : visibleSorted.length === 0 && !error ? (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">🤖</div>
            <div className="h">{agents.length === 0 ? '还没有 Agent' : '没有匹配的 Agent'}</div>
            <div className="d">
              {agents.length === 0
                ? '创建你的第一个 Agent，定义它的提示词、工具和模型。'
                : '试试调整筛选条件或清除搜索。'}
            </div>
            {agents.length === 0 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreateOpen(true)}
              >
                <Icon name="plus" style={{ width: 14, height: 14 }} />
                新建 Agent
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFilters(NO_FILTERS)}
              >
                清除过滤器
              </button>
            )}
          </div>
        ) : (
          visibleSorted.map((a, i) => (
            <div
              key={a.id}
              className="agent-card enter-rise"
              style={{ '--enter-i': i } as React.CSSProperties}
              role="button"
              tabIndex={0}
              aria-label={`查看 agent ${a.name} 详情`}
              onClick={() => onRowClick(a.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onRowClick(a.id)
                }
              }}
            >
              <div className="agent-card-head">
                <div className={glyphClass(a.kind)}>{kindGlyph(a.kind)}</div>
                <div className="agent-info">
                  <div className="nm">{a.name}</div>
                  <div className="sub">
                    <span className="mono">{a.id.slice(0, 8)}</span>
                    <span>{kindLabel(a.kind)}</span>
                    {a.run ? <span className="mono">{a.run}</span> : null}
                  </div>
                </div>
                <div className="agent-card-meta">
                  <span className={`agent-status ${a.status}`}>
                    <span className={`status-dot ${STATUS_DOT_CLASS[a.status]}`} />
                    {STATUS_LABEL[a.status]}
                  </span>
                  <div className="agent-load">
                    <div className="load-bar">
                      <span
                        className={`load-fill${a.load > 85 ? ' danger' : a.load > 70 ? ' warn' : ''}`}
                        style={{ width: `${a.load}%` }}
                      />
                    </div>
                    <span className="load-val mono">{a.load}%</span>
                  </div>
                  {a.cost !== '—' ? (
                    <span className="chip chip-outline mono" style={{ fontSize: 10 }}>
                      {a.cost}
                    </span>
                  ) : null}
                </div>
                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    title="查看详情"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRowClick(a.id)
                    }}
                  >
                    查看详情
                  </button>
                </div>
              </div>
            </div>
          ))
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
