'use client'

/**
 * AgentPlaza — Agent 广场页面组件（docs/agent-plaza.md D4）。
 *
 * 人格库的前端面从 modal 升格为一等页面：浏览（分部 chips + 搜索 + 分区分组）
 * → 确认步（三档瘦身 profile + 运行时/模型）→ 启用/更新（instantiate/reimport）
 * → 跳转 Agent 详情。内置精选库（builtin-library，source=builtin）开箱即有
 * 内容，卡片带「内置」角标；完整库通过底部 clone 引导挂载。
 *
 * 与退役的 agent-library-gallery.tsx（modal）的差异：
 * - 分区陈列：quickstart 置顶 → 各分部独立小节（原来是单块「全部人格」），
 *   配合 content-visibility 廉价虚拟化承接 300+ 卡。
 * - 卡片新增 vibe 人格标语行；体积降级为 hover 次要信息。
 * - 团队场景模式保留（懒加载），人格/团队双 tab 同前。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import { AGENT_KINDS } from '@/lib/agents-catalog'
import { formatBytes } from '@/lib/format'
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
import '@/styles/agent-templates.css'
import '@/styles/agent-library.css'

/** Runtime kinds offered for instantiation — labels resolve through the
 *  shared AGENT_KINDS catalog. */
const RUNTIME_KINDS = ['claude', 'codex', 'copilot', 'qwen'] as const

/** Quickstart division key (gateway quickstart-library root) — pinned as the
 *  first section above the per-division grid. */
const QUICKSTART_DIVISION = 'quickstart'

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

/** 完整 The Agency 库的挂载引导命令（docs/agent-plaza.md §7）。 */
const FULL_LIBRARY_CLONE_CMD =
  'git clone https://github.com/msitarzewski/agency-agents ~/.agents/agent-library'

export function AgentPlaza(): React.ReactElement {
  const router = useRouter()
  const toast = useToast()
  const { t } = useI18n()

  const [catalog, setCatalog] = useState<AgentLibraryCatalog | null>(null)
  const [drift, setDrift] = useState<AgentLibraryDriftItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [division, setDivision] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<AgentLibraryDetail | null>(null)
  const [profile, setProfile] = useState<PersonaProfile>('slim')
  // 运行时档位：预填人格 frontmatter 建议（快速开始人格锁定 kind/model），可改
  const [runtimeKind, setRuntimeKind] = useState('claude')
  const [runtimeModel, setRuntimeModel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [rootInput, setRootInput] = useState('')
  const [addingRoot, setAddingRoot] = useState(false)
  const [copied, setCopied] = useState(false)

  // ── 团队场景模式：静态模板目录，懒加载 ──
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
    void load()
  }, [load])

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
    if (mode === 'teams' && teamTemplates === null && !teamLoading) void loadTeam()
  }, [mode, teamTemplates, teamLoading, loadTeam])

  // 搜索变更时退出确认步（返回列表看新结果）。
  useEffect(() => {
    setDetail(null)
  }, [division])

  const entries = catalog?.entries ?? []
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (division !== 'all' && e.division !== division) return false
      if (!q) return true
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.vibe ?? '').toLowerCase().includes(q)
      )
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

  /** 分区陈列：搜索 = 单块无题结果网格；选中部门 = 单分区；全部 =
   *  quickstart 置顶 + 各分部独立小节（catalog.divisions 顺序 = 字母序）。 */
  const sections = useMemo(() => {
    const searching = search.trim().length > 0
    if (searching) return [{ key: '__results__', title: '', entries: visible }]
    if (division !== 'all') {
      return [{ key: division, title: divisionLabel(division), entries: visible }]
    }
    const quick = visible.filter((e) => e.division === QUICKSTART_DIVISION)
    const rest = visible.filter((e) => e.division !== QUICKSTART_DIVISION)
    const byDivision = new Map<string, typeof visible>()
    for (const e of rest) {
      const list = byDivision.get(e.division) ?? []
      list.push(e)
      byDivision.set(e.division, list)
    }
    const divisionOrder = (catalog?.divisions ?? [])
      .map((d) => d.key)
      .filter((k) => byDivision.has(k))
    const out: { key: string; title: string; entries: typeof visible }[] = []
    if (quick.length > 0) {
      out.push({
        key: QUICKSTART_DIVISION,
        title: divisionLabel(QUICKSTART_DIVISION),
        entries: quick,
      })
    }
    for (const key of divisionOrder) {
      out.push({ key, title: divisionLabel(key), entries: byDivision.get(key)! })
    }
    return out
  }, [visible, division, search, divisionLabel, catalog])

  const openDetail = async (id: string) => {
    setError(null)
    try {
      const d = await fetchAgentLibraryEntry(id)
      setDetail(d)
      // 快速开始人格锁定档位；普通人格默认 claude
      setRuntimeKind(d.suggestedKind ?? 'claude')
      setRuntimeModel(d.suggestedModel ?? '')
      setProfile('slim')
      window.scrollTo({ top: 0 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleInstantiate = async () => {
    if (!detail) return
    setSubmitting(true)
    try {
      const { id } = await instantiateAgentFromLibrary(detail.id, {
        profile,
        kind: runtimeKind,
        ...(runtimeModel ? { model: runtimeModel } : {}),
      })
      toast.success(t('已启用「{name}」', { name: detail.name }))
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
      setDetail(null)
      await load()
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
      toast.success(
        t('已创建工作流「{name}」（{n} 个成员 Agent）', {
          name: teamConfirm.name,
          n: result.members.length,
        }),
      )
      router.push(`/workflows/${result.flowId}/canvas`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const copyCloneCmd = async () => {
    try {
      await navigator.clipboard.writeText(FULL_LIBRARY_CLONE_CMD)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('复制失败，请手动复制'))
    }
  }

  const previewChars = (p: PersonaProfile): number | null =>
    detail?.previews.find((v) => v.profile === p)?.chars ?? null

  const fmtChars = (n: number | null): string =>
    n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const hasAnyEntry = entries.length > 0

  return (
    <div className="agent-plaza">
      {detail ? (
        <div className="alib-confirm">
          <div className="alib-confirm-head">
            <span className="alib-confirm-emoji" aria-hidden="true">
              {detail.emoji ?? '🤖'}
            </span>
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
              <dd className="alib-runtime-dd">
                <select
                  className="alib-runtime-select"
                  value={runtimeKind}
                  onChange={(e) => {
                    setRuntimeKind(e.target.value)
                    // 非 claude 无模型档位概念，清空
                    if (e.target.value !== 'claude') setRuntimeModel('')
                  }}
                  aria-label={t('运行时')}
                >
                  {RUNTIME_KINDS.map((k) => {
                    const meta = AGENT_KINDS.find((m) => m.kind === k)
                    return (
                      <option key={k} value={k}>
                        {meta ? t(meta.label) : k}
                      </option>
                    )
                  })}
                </select>
                {runtimeKind === 'claude' ? (
                  <select
                    className="alib-runtime-select"
                    value={runtimeModel}
                    onChange={(e) => setRuntimeModel(e.target.value)}
                    aria-label={t('模型档位')}
                  >
                    <option value="">{t('默认模型')}</option>
                    <option value="sonnet">sonnet</option>
                    <option value="opus">opus</option>
                    <option value="haiku">haiku</option>
                  </select>
                ) : null}
              </dd>
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
                <label
                  key={key}
                  className={`alib-profile-option${profile === key ? ' active' : ''}`}
                >
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
          <div className="alib-confirm-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDetail(null)}
              disabled={submitting}
            >
              {t('返回广场')}
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
                  : detail.instantiated.drift === 'locally-modified' ||
                      detail.instantiated.drift === 'diverged'
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
          </div>
        </div>
      ) : teamConfirm ? (
        <div className="alib-team-confirm">
          <div className="alib-confirm-head">
            <span className="alib-confirm-emoji" aria-hidden="true">
              {teamConfirm.icon}
            </span>
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
                <span className="alib-member-emoji" aria-hidden="true">
                  {m.emoji ?? '🤖'}
                </span>
                <div className="alib-member-body">
                  <div className="alib-member-name">{m.persona}</div>
                  <div className="alib-member-label">
                    {m.label}
                    {m.division ? ` · ${m.division}` : ''}
                  </div>
                </div>
                <span
                  className={`alib-badge alib-badge-${m.available ? 'up-to-date' : 'diverged'}`}
                >
                  {m.available ? t('可解析') : t('库中缺失')}
                </span>
              </div>
            ))}
          </div>
          <div className="alib-confirm-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setTeamConfirm(null)}
              disabled={submitting}
            >
              {t('返回广场')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleTeamInstantiate()}
              disabled={submitting}
            >
              {submitting ? t('创建中…') : t('创建工作流')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="alib-mode-tabs" role="tablist" aria-label={t('广场模式')}>
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
                      <div className="skeleton-text alib-skel-w1" />
                      <div className="skeleton-text alib-skel-w2" />
                      <div className="skeleton-text alib-skel-w3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : teamError ? (
              <div className="atg-error">
                <div>{t('加载团队场景失败：{error}', { error: teamError })}</div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadTeam()}
                >
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
                    <div className="atg-card-icon" aria-hidden="true">
                      {tpl.icon}
                    </div>
                    <div className="atg-card-body">
                      <div className="atg-card-name">{tpl.name}</div>
                      <div className="atg-card-desc">{tpl.description}</div>
                      <div className="alib-team-members">
                        {tpl.members.map((m) => (
                          <span
                            key={m.persona}
                            className={`alib-member-chip${m.available ? '' : ' missing'}`}
                          >
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
                    placeholder={t('搜索人格名称 / 简介 / 标语…')}
                    aria-label={t('搜索人格库')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <span className="alib-count">
                  {t('{n} / {total} 个人格', { n: visible.length, total: entries.length })}
                </span>
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
                  {Array.from({ length: 8 }, (_, i) => (
                    <div key={i} className="atg-card atg-skeleton">
                      <div className="atg-card-icon skeleton" />
                      <div className="atg-card-body">
                        <div className="skeleton-text alib-skel-w1" />
                        <div className="skeleton-text alib-skel-w2" />
                        <div className="skeleton-text alib-skel-w3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="atg-error">
                  <div>{t('加载人格库失败：{error}', { error })}</div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void load()}
                  >
                    {t('重试')}
                  </button>
                </div>
              ) : !hasAnyEntry ? (
                <div className="alib-empty">
                  <div className="alib-empty-title">{t('库是空的 —— 挂载一个人格库目录')}</div>
                  <div className="alib-empty-hint">
                    {t('在下面直接添加本机路径，或用底部的命令挂载完整 The Agency 库：')}
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
                </div>
              ) : visible.length === 0 ? (
                <div className="atg-empty">{t('没有匹配的人格。')}</div>
              ) : (
                sections.map((section) => (
                  <div key={section.key} className="alib-section">
                    {section.title ? (
                      <div className="alib-section-title">
                        {t(section.title)}
                        <span className="alib-chip-count">{section.entries.length}</span>
                      </div>
                    ) : null}
                    <div className="atg-grid">
                      {section.entries.map((entry) => {
                        const d = driftById.get(entry.id)
                        const isBuiltin = entry.source === 'builtin'
                        return (
                          <div
                            key={entry.id}
                            className="atg-card alib-card"
                            onClick={() => void openDetail(entry.id)}
                          >
                            <div className="atg-card-icon" aria-hidden="true">
                              {entry.emoji ?? '🤖'}
                            </div>
                            <div className="atg-card-body">
                              <div className="atg-card-name">{entry.name}</div>
                              <div className="atg-card-desc">{entry.description}</div>
                              {entry.vibe ? (
                                <div className="alib-card-vibe">{entry.vibe}</div>
                              ) : null}
                            </div>
                            {/* 唯一主操作（启用/更新 = 墨色）；整卡可点开预览确认步。
                                角标优先级：drift 状态 > 内置 > 体积（hover 次要信息）。 */}
                            <div className="alib-card-side">
                              {d ? (
                                <span className={`alib-badge alib-badge-${d.state}`}>
                                  {t(DRIFT_BADGES[d.state] ?? d.state)}
                                </span>
                              ) : isBuiltin ? (
                                <span className="alib-badge alib-badge-builtin">{t('内置')}</span>
                              ) : null}
                              <span className="alib-card-size" title={t('人格文件体积')}>
                                {formatBytes(entry.sizeBytes)}
                              </span>
                              <span className="alib-card-preview" aria-hidden="true">
                                {t('预览')}
                              </span>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void openDetail(entry.id)
                                }}
                              >
                                {d ? t('重新导入') : t('启用')}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {/* 广场脚注：完整库挂载引导 + 当前挂载根（docs/agent-plaza.md D4）。 */}
          {!(detail || teamConfirm) && (
            <div className="alib-footer">
              <div className="alib-footer-clone">
                <span className="alib-footer-label">{t('想要完整库（282+ 人格）？')}</span>
                <code className="alib-footer-cmd">{FULL_LIBRARY_CLONE_CMD}</code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void copyCloneCmd()}
                >
                  <Icon name={copied ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                  {copied ? t('已复制') : t('复制命令')}
                </button>
              </div>
              {catalog && catalog.roots && catalog.roots.length > 0 && (
                <div className="alib-roots">
                  {t('当前挂载：{dirs}', {
                    dirs: catalog.roots.map((r) => `${r.dir}（${r.source}）`).join('、') || t('无'),
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
