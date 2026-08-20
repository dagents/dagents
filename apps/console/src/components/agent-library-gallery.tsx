'use client'

/**
 * AgentLibraryGallery — Agent 人格库浏览/启用 modal。
 *
 * 「库/目录分离」（docs/agent-library.md D1）的前端面：浏览挂载目录里的
 * 人格（division 分组 + 搜索），点卡片进入确认步 —— 三档瘦身 profile 的
 * 字符数对照来自 detail 的 previews；未启用 → instantiate，已启用 → 按
 * drift 状态显示角标并提供 reimport（本地已修改时明确标注会覆盖）。
 * 空态提供挂载目录管理（默认 ~/.agents/agent-library，agency-agents 的
 * clone 软链过去即可）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import {
  type AgentLibraryCatalog,
  type AgentLibraryDetail,
  type AgentLibraryDriftItem,
  type PersonaProfile,
  type TeamTemplateSummary,
  addAgentLibraryRoot,
  fetchAgentLibrary,
  fetchAgentLibraryDrift,
  fetchAgentLibraryEntry,
  fetchTeamTemplates,
  instantiateAgentFromLibrary,
  instantiateTeamTemplate,
  reimportAgentFromLibrary,
} from '@/lib/agent-library'
import '@/styles/dialog.css'
import '@/styles/agent-templates.css'
import '@/styles/agent-library.css'

const PROFILE_LABELS: { key: PersonaProfile; zh: string }[] = [
  { key: 'slim', zh: '均衡（推荐）' },
  { key: 'full', zh: '完整' },
  { key: 'minimal', zh: '精简' },
]

const DRIFT_BADGES: Record<string, string> = {
  'up-to-date': '已启用',
  'upstream-updated': '有更新',
  'locally-modified': '已本地修改',
  diverged: '双方已改',
  'missing-upstream': '库中已移除',
}

export interface AgentLibraryGalleryProps {
  open: boolean
  onClose: () => void
}

export function AgentLibraryGallery({
  open,
  onClose,
}: AgentLibraryGalleryProps): React.ReactElement | null {
  const router = useRouter()
  const toast = useToast()
  const { t } = useI18n()

  const [catalog, setCatalog] = useState<AgentLibraryCatalog | null>(null)
  const [drift, setDrift] = useState<AgentLibraryDriftItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [division, setDivision] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<AgentLibraryDetail | null>(null)
  const [profile, setProfile] = useState<PersonaProfile>('slim')
  const [submitting, setSubmitting] = useState(false)
  const [rootInput, setRootInput] = useState('')
  const [addingRoot, setAddingRoot] = useState(false)

  // ── 团队场景模式（Phase 3）：静态模板目录，懒加载 ──
  const [mode, setMode] = useState<'personas' | 'teams'>('personas')
  const [teamTemplates, setTeamTemplates] = useState<TeamTemplateSummary[] | null>(null)
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)
  const [teamConfirm, setTeamConfirm] = useState<TeamTemplateSummary | null>(null)

  const driftById = useMemo(() => {
    const map = new Map<string, AgentLibraryDriftItem>()
    for (const item of drift) map.set(item.libraryId, item)
    return map
  }, [drift])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cat, driftItems] = await Promise.all([
        fetchAgentLibrary({ refresh: true }),
        fetchAgentLibraryDrift(),
      ])
      setCatalog(cat)
      setDrift(driftItems)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCatalog(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const loadTeam = useCallback(async () => {
    setTeamLoading(true)
    setTeamError(null)
    try {
      setTeamTemplates(await fetchTeamTemplates())
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : String(err))
      setTeamTemplates(null)
    } finally {
      setTeamLoading(false)
    }
  }, [])

  // 切到团队场景时懒加载目录（人格模式的数据已由 load() 负责）。
  useEffect(() => {
    if (open && mode === 'teams' && teamTemplates === null && !teamLoading) void loadTeam()
  }, [open, mode, teamTemplates, teamLoading, loadTeam])

  useEffect(() => {
    if (open) return
    setDivision('all')
    setSearch('')
    setDetail(null)
    setProfile('slim')
    setError(null)
    setRootInput('')
    setMode('personas')
    setTeamConfirm(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        if (teamConfirm) setTeamConfirm(null)
        else if (detail) setDetail(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting, detail, teamConfirm])

  const entries = catalog?.entries ?? []
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (division !== 'all' && e.division !== division) return false
      if (!q) return true
      return e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
    })
  }, [entries, division, search])

  const divisionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) counts.set(e.division, (counts.get(e.division) ?? 0) + 1)
    return counts
  }, [entries])

  const divisionLabel = useCallback(
    (key: string): string => catalog?.divisions.find((d) => d.key === key)?.label ?? key,
    [catalog],
  )

  if (!open) return null

  const openDetail = async (id: string) => {
    setError(null)
    try {
      const d = await fetchAgentLibraryEntry(id)
      setDetail(d)
      setProfile('slim')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleInstantiate = async () => {
    if (!detail) return
    setSubmitting(true)
    try {
      const { id } = await instantiateAgentFromLibrary(detail.id, { profile })
      toast.success(t('已启用「{name}」', { name: detail.name }))
      onClose()
      router.push(`/agents/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleReimport = async () => {
    if (!detail) return
    setSubmitting(true)
    try {
      await reimportAgentFromLibrary(detail.id, { confirm: true, profile })
      toast.success(t('已重新导入「{name}」', { name: detail.name }))
      await load()
      setDetail(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddRoot = async () => {
    const dir = rootInput.trim()
    if (!dir) return
    setAddingRoot(true)
    try {
      await addAgentLibraryRoot(dir)
      toast.success(t('已挂载目录：{dir}', { dir }))
      setRootInput('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingRoot(false)
    }
  }

  const handleTeamInstantiate = async () => {
    if (!teamConfirm) return
    setSubmitting(true)
    try {
      const result = await instantiateTeamTemplate(teamConfirm.id, { profile })
      toast.success(t('已创建工作流「{name}」（{n} 个成员 Agent）', {
        name: teamConfirm.name,
        n: result.members.length,
      }))
      onClose()
      router.push(`/workflows/${result.flowId}/canvas`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const previewChars = (p: PersonaProfile): number | null =>
    detail?.previews.find((v) => v.profile === p)?.chars ?? null

  const fmtChars = (n: number | null): string =>
    n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const hasAnyEntry = entries.length > 0

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose} aria-hidden="true" />
      <div
        className="modal-dialog open alib-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('从人格库启用 Agent')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('Agent 人格库')}</h2>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onClose} disabled={submitting}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {detail ? (
            <div className="alib-confirm">
              <div className="alib-confirm-head">
                <span className="alib-confirm-emoji" aria-hidden="true">{detail.emoji ?? '🤖'}</span>
                <div>
                  <div className="alib-confirm-name">{detail.name}</div>
                  <div className="alib-confirm-desc">{detail.description}</div>
                </div>
              </div>
              <dl className="alib-confirm-meta">
                <div>
                  <dt>{t('部门')}</dt>
                  <dd>{divisionLabel(detail.division)}</dd>
                </div>
                <div>
                  <dt>{t('运行时')}</dt>
                  <dd>claude（{t('CLI，带真实工具')}）</dd>
                </div>
                {detail.tools && detail.tools.length > 0 && (
                  <div>
                    <dt>{t('声明工具')}</dt>
                    <dd>{detail.tools.join('、')}</dd>
                  </div>
                )}
              </dl>
              <div className="alib-profile-fieldset">
                <div className="alib-profile-label">{t('导入档位（systemPrompt 体积）')}</div>
                <div className="alib-profile-options" role="radiogroup" aria-label={t('导入档位')}>
                  {PROFILE_LABELS.map(({ key, zh }) => (
                    <label key={key} className={`alib-profile-option${profile === key ? ' active' : ''}`}>
                      <input
                        type="radio"
                        name="alib-profile"
                        value={key}
                        checked={profile === key}
                        onChange={() => setProfile(key)}
                      />
                      <span className="alib-profile-name">{t(zh)}</span>
                      <span className="alib-profile-chars">{fmtChars(previewChars(key))}</span>
                    </label>
                  ))}
                </div>
                <div className="alib-profile-hint">
                  {t('人格为英文原文；启用后自动附加「跟随用户语言回复」指令。')}
                </div>
              </div>
            </div>
          ) : teamConfirm ? (
            <div className="alib-team-confirm">
              <div className="alib-confirm-head">
                <span className="alib-confirm-emoji" aria-hidden="true">{teamConfirm.icon}</span>
                <div>
                  <div className="alib-confirm-name">{teamConfirm.name}</div>
                  <div className="alib-confirm-desc">{teamConfirm.description}</div>
                </div>
              </div>
              <div className="alib-team-shape-hint">
                {teamConfirm.shape === 'fan-out'
                  ? t('成员并行执行，最终由 LLM 节点汇总。')
                  : t('成员按顺序执行，上游产出作为下游输入。')}
                {t('缺失的成员将自动启用为 claude Agent（slim 档）；已启用的直接复用。')}
              </div>
              <div className="alib-team-member-list">
                {teamConfirm.members.map((m) => (
                  <div key={m.persona} className="alib-team-member">
                    <span className="alib-member-emoji" aria-hidden="true">{m.emoji ?? '🤖'}</span>
                    <div className="alib-member-body">
                      <div className="alib-member-name">{m.persona}</div>
                      <div className="alib-member-label">{m.label}{m.division ? ` · ${m.division}` : ''}</div>
                    </div>
                    <span className={`alib-badge alib-badge-${m.available ? 'up-to-date' : 'diverged'}`}>
                      {m.available ? t('可解析') : t('库中缺失')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="alib-mode-tabs" role="tablist" aria-label={t('库模式')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'personas'}
                  className={`alib-chip${mode === 'personas' ? ' active' : ''}`}
                  onClick={() => setMode('personas')}
                >
                  {t('人格')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'teams'}
                  className={`alib-chip${mode === 'teams' ? ' active' : ''}`}
                  onClick={() => setMode('teams')}
                >
                  {t('团队场景')}
                </button>
              </div>

              {mode === 'teams' ? (
                teamLoading ? (
                  <div className="atg-grid">
                    {Array.from({ length: 4 }, (_, i) => (
                      <div key={i} className="atg-card atg-skeleton">
                        <div className="atg-card-icon skeleton" />
                        <div className="atg-card-body">
                          <div className="skeleton-text" style={{ width: '60%' }} />
                          <div className="skeleton-text" style={{ width: '90%', height: '10px' }} />
                          <div className="skeleton-text" style={{ width: '75%', height: '10px' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : teamError ? (
                  <div className="atg-error">
                    <div>{t('加载团队场景失败：{error}', { error: teamError })}</div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadTeam()}>
                      {t('重试')}
                    </button>
                  </div>
                ) : (
                  <div className="atg-grid alib-team-grid">
                    {(teamTemplates ?? []).map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className="atg-card alib-team-card"
                        onClick={() => setTeamConfirm(tpl)}
                        aria-label={t('查看团队场景 {name}', { name: tpl.name })}
                      >
                        <div className="atg-card-icon" aria-hidden="true">{tpl.icon}</div>
                        <div className="atg-card-body">
                          <div className="atg-card-name">{tpl.name}</div>
                          <div className="atg-card-desc">{tpl.description}</div>
                          <div className="alib-team-members">
                            {tpl.members.map((m) => (
                              <span key={m.persona} className={`alib-member-chip${m.available ? '' : ' missing'}`}>
                                {m.emoji ?? '🤖'} {m.label}
                                {!m.available && <em> {t('库中缺失')}</em>}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <>
              <div className="alib-toolbar">
                <div className="list-search alib-search">
                  <Icon name="search" />
                  <input
                    type="search"
                    placeholder={t('搜索人格名称 / 简介…')}
                    aria-label={t('搜索人格库')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <span className="alib-count">{t('{n} / {total} 个人格', { n: visible.length, total: entries.length })}</span>
              </div>

              {hasAnyEntry && (
                <div className="alib-divisions" role="tablist" aria-label={t('部门筛选')}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={division === 'all'}
                    className={`alib-chip${division === 'all' ? ' active' : ''}`}
                    onClick={() => setDivision('all')}
                  >
                    {t('全部')}
                  </button>
                  {catalog?.divisions
                    .filter((d) => divisionCounts.get(d.key))
                    .map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        role="tab"
                        aria-selected={division === d.key}
                        className={`alib-chip${division === d.key ? ' active' : ''}`}
                        onClick={() => setDivision(d.key)}
                      >
                        {d.label}
                        <span className="alib-chip-count">{divisionCounts.get(d.key)}</span>
                      </button>
                    ))}
                </div>
              )}

              {loading ? (
                <div className="atg-grid">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="atg-card atg-skeleton">
                      <div className="atg-card-icon skeleton" />
                      <div className="atg-card-body">
                        <div className="skeleton-text" style={{ width: '60%' }} />
                        <div className="skeleton-text" style={{ width: '90%', height: '10px' }} />
                        <div className="skeleton-text" style={{ width: '75%', height: '10px' }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="atg-error">
                  <div>{t('加载人格库失败：{error}', { error })}</div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                    {t('重试')}
                  </button>
                </div>
              ) : !hasAnyEntry ? (
                <div className="alib-empty">
                  <div className="alib-empty-title">{t('库是空的 —— 挂载一个人格库目录')}</div>
                  <div className="alib-empty-hint">
                    {t('默认目录 ~/.agents/agent-library（软链或 clone 到该路径即可），或在下面直接添加：')}
                  </div>
                  <div className="alib-empty-form">
                    <input
                      type="text"
                      className="input"
                      placeholder="/Users/you/Projects/agency-agents"
                      aria-label={t('库目录路径')}
                      value={rootInput}
                      onChange={(e) => setRootInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleAddRoot()}
                      disabled={addingRoot || !rootInput.trim()}
                    >
                      {addingRoot ? t('挂载中…') : t('挂载')}
                    </button>
                  </div>
                  {catalog && catalog.roots && (
                    <div className="alib-roots">
                      {t('当前挂载：{dirs}', {
                        dirs: catalog.roots.map((r) => `${r.dir}（${r.source}）`).join('、') || t('无'),
                      })}
                    </div>
                  )}
                </div>
              ) : visible.length === 0 ? (
                <div className="atg-empty">{t('没有匹配的人格。')}</div>
              ) : (
                <div className="atg-grid">
                  {visible.map((entry) => {
                    const d = driftById.get(entry.id)
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        className="atg-card alib-card"
                        onClick={() => void openDetail(entry.id)}
                        aria-label={t('查看人格 {name}', { name: entry.name })}
                      >
                        <div className="atg-card-icon" aria-hidden="true">{entry.emoji ?? '🤖'}</div>
                        <div className="atg-card-body">
                          <div className="atg-card-name">{entry.name}</div>
                          <div className="atg-card-desc">{entry.description}</div>
                        </div>
                        {d ? (
                          <span className={`alib-badge alib-badge-${d.state}`}>{t(DRIFT_BADGES[d.state] ?? d.state)}</span>
                        ) : (
                          <span className="alib-card-size">{Math.max(1, Math.round(entry.sizeBytes / 1024))}KB</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              </>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {detail ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDetail(null)}
                disabled={submitting}
              >
                {t('返回')}
              </button>
              {detail.instantiated ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleReimport()}
                  disabled={submitting}
                >
                  {submitting
                    ? t('更新中…')
                    : detail.instantiated.drift === 'locally-modified' || detail.instantiated.drift === 'diverged'
                      ? t('覆盖本地修改并更新')
                      : t('重新导入')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleInstantiate()}
                  disabled={submitting}
                >
                  {submitting ? t('启用中…') : t('启用')}
                </button>
              )}
            </>
          ) : teamConfirm ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setTeamConfirm(null)}
                disabled={submitting}
              >
                {t('返回')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleTeamInstantiate()}
                disabled={submitting || teamConfirm.members.some((m) => !m.available)}
              >
                {submitting ? t('创建中…') : t('创建工作流')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              {t('取消')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
