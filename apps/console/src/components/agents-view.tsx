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
import { AgentPlaza } from '@/components/agent-plaza'
import { SkeletonList } from '@/components/skeleton'
import { useI18n } from '@/i18n'
import '@/styles/agents.css'
import {
  type AgentFilters,
  type AgentKind,
  type AgentStatus,
  type CatalogAgent,
  AGENT_KINDS,
  AGENT_STATUS_LABEL,
  NO_FILTERS,
  filterAgents,
  fetchAgents,
  kindLabel,
} from '@/lib/agents-catalog'

// Filter chips show the 主流 (mainstream) CLI kinds — the 6 most common —
// so the toolbar stays scannable. Less-common kinds (国产/ACP/特殊) are
// still selectable via the create dialog and searchable by name/id/kind;
// an unknown kind normalises to `remote`, which has its own chip.
const KIND_FILTERS: AgentKind[] = AGENT_KINDS.filter((m) => m.group === '主流')
  .map((m) => m.kind)
  .concat(['remote'])
const STATUS_FILTERS: AgentStatus[] = ['running', 'queued', 'idle', 'failed']

type Scope = 'mine' | 'all' | 'archived'
const SCOPE_TABS: { key: Scope; label: string }[] = [
  { key: 'mine', label: '我的' },
  { key: 'all', label: '全部' },
  { key: 'archived', label: '已归档' },
]

/** 页级 tab（docs/agent-plaza.md D4）：「我的 Agents」列表 / 「Agent 广场」
 *  人格库。tab 同步到 ?tab=（plaza 可深链，聊天/画布入口直达）。 */
type PageTab = 'agents' | 'plaza'

type SortField = 'name' | 'load'

function isArchived(a: CatalogAgent): boolean {
  return a.visibility === 'archived'
}

function compareAgents(a: CatalogAgent, b: CatalogAgent, field: SortField): number {
  if (field === 'name') return a.name.localeCompare(b.name)
  if (a.load !== b.load) return a.load - b.load
  return a.name.localeCompare(b.name)
}

function glyphClass(kind: AgentKind): string {
  return `agent-glyph kind-${kind}`
}

/** Avatar initial — the agent NAME's first letter (identity), not the kind
 *  glyph; the kind reads from the ghost badge beside the title (PX-A01). */
function nameInitial(name: string): string {
  const ch = name.trim().charAt(0)
  return (ch || '?').toUpperCase()
}

export interface AgentsViewProps {
  /** 初始 tab（来自 ?tab= 深链；默认 agents）。 */
  initialTab?: PageTab
}

export function AgentsView({ initialTab = 'agents' }: AgentsViewProps): React.ReactElement {
  const router = useRouter()
  const { t } = useI18n()
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
  const [tab, setTab] = useState<PageTab>(initialTab)

  // tab 切换同步 URL（replace：tab 是视图不是文档，不污染后退历史）。
  const switchTab = useCallback(
    (next: PageTab) => {
      setTab(next)
      router.replace(next === 'plaza' ? '/agents?tab=plaza' : '/agents', { scroll: false })
    },
    [router],
  )

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
      {/* 页级双 tab：我的 Agents（列表）/ Agent 广场（人格库一等入口） */}
      <div className="scope-tabs-row mb-6">
        <div className="scope-tabs page-tabs" role="tablist" aria-label={t('Agents 页视图')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            onClick={() => switchTab('agents')}
          >
            {t('我的 Agents')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plaza'}
            onClick={() => switchTab('plaza')}
          >
            {t('Agent 广场')}
          </button>
        </div>
        <div className="grow" />
        {tab === 'agents' ? (
          <>
            {!error ? (
              <span className="result-count">
                {t('{n} / {total} 个 agent', { n: visibleSorted.length, total: scoped.length })}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void load()}
              disabled={loading}
              title={t('刷新列表')}
            >
              <Icon name={loading ? 'loader' : 'refresh'} style={{ width: 14, height: 14 }} />
              {t('刷新')}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          {t('新建 Agent')}
        </button>
      </div>

      {tab === 'plaza' ? (
        <AgentPlaza />
      ) : (
        <>
          {/* scope tabs — 仅列表视图 */}
          <div
            className="scope-tabs scope-tabs-secondary mb-4"
            role="tablist"
            aria-label={t('agent 范围')}
          >
            {SCOPE_TABS.map((tabItem) => (
              <button
                key={tabItem.key}
                type="button"
                role="tab"
                aria-selected={scope === tabItem.key}
                data-scope={tabItem.key}
                data-zero={scopeCounts[tabItem.key] === 0 ? 'true' : undefined}
                onClick={() => setScope(tabItem.key)}
              >
                {t(tabItem.label)}
                <span className="cnt">{scopeCounts[tabItem.key]}</span>
              </button>
            ))}
          </div>

          {/* toolbar — search + filter chips */}
          <div className="agents-toolbar">
            <div className="list-search">
              <Icon name="search" />
              <input
                type="search"
                placeholder={t('搜索名称 / ID / 类型…')}
                aria-label={t('搜索 agents')}
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
                {t(kindLabel(k))}
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
                {t(AGENT_STATUS_LABEL[s])}
              </button>
            ))}
            <div className="grow" />
            {/* Sort toggle — clicking the active field flips the direction. */}
            <button
              type="button"
              className="filter-chip"
              aria-pressed={sort.field === 'name'}
              title={t('按名称排序')}
              onClick={() =>
                setSort((p) =>
                  p.field === 'name'
                    ? { field: 'name', dir: p.dir === 'asc' ? 'desc' : 'asc' }
                    : { field: 'name', dir: 'asc' },
                )
              }
            >
              {t('名称')}
              {sort.field === 'name' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
            <button
              type="button"
              className="filter-chip"
              aria-pressed={sort.field === 'load'}
              title={t('按负载排序')}
              onClick={() =>
                setSort((p) =>
                  p.field === 'load'
                    ? { field: 'load', dir: p.dir === 'asc' ? 'desc' : 'asc' }
                    : { field: 'load', dir: 'desc' },
                )
              }
            >
              {t('负载')}
              {sort.field === 'load' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
          </div>

          {error ? (
            <div className="agents-error">
              {t('加载失败：{error}', { error })}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
                {t('重试')}
              </button>
            </div>
          ) : null}

          {/* card list — mirrors flow-card visual language */}
          <div className="agent-cards">
            {loading && agents.length === 0 ? (
              /* PX-F09：骨架复刻 agent 卡真实分区（头像+标题+描述+meta） */
              <SkeletonList rows={5} shape="agent-card" />
            ) : visibleSorted.length === 0 && !error ? (
              <div className="empty-state">
                <div className="empty-state-icon" aria-hidden="true">
                  <Icon name="bot" style={{ width: 28, height: 28 }} />
                </div>
                {/* Empty decision uses the SCOPED count — 3 active + 0 archived
                 * must not show "adjust filters" under the 已归档 tab. */}
                {scoped.length === 0 ? (
                  <>
                    <div className="h">
                      {scope === 'archived' ? t('还没有归档的 Agent') : t('还没有 Agent')}
                    </div>
                    <div className="d">
                      {scope === 'archived'
                        ? t('归档的 Agent 会显示在这里，可在详情页归档。')
                        : t('创建你的第一个 Agent，或去广场启用一个现成的专家人格。')}
                    </div>
                    {scope !== 'archived' ? (
                      <div className="empty-state-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => setCreateOpen(true)}
                        >
                          <Icon name="plus" style={{ width: 14, height: 14 }} />
                          {t('新建 Agent')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => switchTab('plaza')}
                        >
                          <Icon name="bot" style={{ width: 14, height: 14 }} />
                          {t('去广场逛逛')}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="h">{t('没有匹配的 Agent')}</div>
                    <div className="d">{t('试试调整筛选条件或清除搜索。')}</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setFilters(NO_FILTERS)}
                    >
                      {t('清除过滤器')}
                    </button>
                  </>
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
                  aria-label={t('查看 agent {name} 详情', { name: a.name })}
                  onClick={() => onRowClick(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick(a.id)
                    }
                  }}
                >
                  <div className="agent-card-head">
                    <div className={glyphClass(a.kind)} aria-hidden="true">
                      {nameInitial(a.name)}
                    </div>
                    <div className="agent-info">
                      <div className="agent-title">
                        <span className="nm">{a.name}</span>
                        <span className="kind-badge">{t(kindLabel(a.kind))}</span>
                      </div>
                      {/* instructions/summary preview — xs/muted, single line (PX-A01) */}
                      <div className="desc" title={a.summary || a.capability.summary || undefined}>
                        {a.summary || a.capability.summary}
                      </div>
                    </div>
                    <div className="card-actions">
                      {/* Whole card already navigates to the detail page — this
                       * shortcut goes one step further to the EDIT form. */}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        title={t('编辑 Agent')}
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/agents/${a.id}/edit`)
                        }}
                      >
                        <Icon name="pencil" className="ic-12" />
                        {t('编辑')}
                      </button>
                    </div>
                  </div>
                  {/* meta row — status via the shell .status baseline primitive;
                  quantitative meta (load/cost) anchors the right edge. */}
                  <div className="agent-card-meta">
                    <span className={`status ${a.status}`}>
                      <span className="dot" />
                      {t(AGENT_STATUS_LABEL[a.status])}
                    </span>
                    {a.run ? <span className="meta-run">{a.run}</span> : null}
                    <div className="grow" />
                    {/* load 仍是前端按运行时长的推算（带「估」标记）；cost 自
                    2026-08-22 方案 D 起只显示实测值（usage.cost），无计价
                    数据时显示「—」（未计价），不再折算。 */}
                    <div className="agent-load" title={t('按运行时长推算的负载估计，非实时监控')}>
                      <div className="load-bar">
                        <span
                          className={`load-fill${a.load > 85 ? ' danger' : a.load > 70 ? ' warn' : ''}`}
                          style={{ width: `${a.load}%` }}
                        />
                      </div>
                      <span className="load-val mono">{t('{n}% 估', { n: a.load })}</span>
                    </div>
                    {a.cost != null ? (
                      <span
                        className="chip chip-tag"
                        title={t('最近任务的实测成本；无单价数据时显示「—」（未计价）')}
                      >
                        {a.cost}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* create dialog */}
      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </PageShell>
  )
}
