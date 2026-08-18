'use client'

/**
 * SkillsView — 技能库（运行时注册表的只读视图）.
 *
 * Registry-not-database: the gateway scans `~/.agents/skills` +
 * `DAGENTS_SKILL_DIRS` (the cross-client convention shared by Cursor / Gemini
 * CLI / Copilot CLI) on demand; nothing lives in Postgres. This page shows
 * the merged catalog (summaries only — no bodies), and lazily fetches the
 * full SKILL.md body when a row is expanded, so gateway-side edits are
 * visible on the next click without any invalidation protocol.
 *
 * Layout follows the Agents page's discipline: 克制 list, grayscale hierarchy,
 * text-sm primary size, spacing over borders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { SkeletonList } from '@/components/skeleton'
import '@/styles/skills.css'
import {
  type SkillDefinition,
  type SkillRootInfo,
  type SkillSummary,
  type SkillCatalog,
  addSkillRoot,
  fetchSkillDetail,
  fetchSkills,
  removeSkillRoot,
  sourceLabel,
} from '@/lib/skills'

type SourceFilter = 'all' | 'custom' | 'user-agents'

const SOURCE_FILTERS: { key: SourceFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'user-agents', label: '本机 ~/.agents' },
  { key: 'custom', label: '自定义目录' },
]

/**
 * 直接输入目录 → 立即加载：网关校验目录存在后写入用户级配置
 * （~/.agents/skill-dirs.json）并强制重扫，一次往返带回最新技能列表，
 * 无需重启进程。空状态与页脚共用此输入组件。
 */
function AddDirInput({
  onCatalog,
  busyLabel = '加载中…',
}: {
  onCatalog: (catalog: SkillCatalog) => void
  busyLabel?: string
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async (): Promise<void> => {
    const dir = value.trim()
    if (!dir || busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await addSkillRoot(dir)
      setValue('')
      onCatalog(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [value, busy, onCatalog])

  return (
    <div className="skills-add-dir">
      <input
        type="text"
        placeholder="~/Projects/my-skills"
        aria-label="自定义技能目录路径"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
      />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy || !value.trim()}
        onClick={() => void submit()}
      >
        {busy ? busyLabel : '加载技能'}
      </button>
      {error ? <div className="skills-add-error">{error}</div> : null}
    </div>
  )
}

export function SkillsView(): React.ReactElement {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [roots, setRoots] = useState<SkillRootInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDefinition | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [footerAdding, setFooterAdding] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchSkills(refresh)
      setSkills(data.skills)
      setRoots(data.roots)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false
      if (!q) return true
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    })
  }, [skills, query, sourceFilter])

  const toggle = useCallback(
    (name: string) => {
      if (expanded === name) {
        setExpanded(null)
        return
      }
      setExpanded(name)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      fetchSkillDetail(name)
        .then(setDetail)
        .catch((err: Error) => {
          // 列表来自 60s TTL 缓存而详情每次现扫磁盘 —— 404 意味着这行是
          // 残影（技能已被删除）。自动刷新目录让残影消失，不甩原始错误。
          if (err.message.includes('404')) {
            setDetailError('该技能已不存在（目录里可能已被删除），列表已自动刷新。')
            void load(true)
          } else {
            setDetailError(`加载失败：${err.message}`)
          }
        })
        .finally(() => setDetailLoading(false))
    },
    [expanded, load],
  )

  const customRoots = useMemo(() => roots.filter((r) => r.source === 'custom'), [roots])
  const hasCustomRoots = customRoots.length > 0

  const applyCatalog = useCallback((catalog: SkillCatalog) => {
    setSkills(catalog.skills)
    setRoots(catalog.roots)
  }, [])

  const removeRoot = useCallback(
    async (dir: string): Promise<void> => {
      try {
        applyCatalog(await removeSkillRoot(dir))
      } catch (err) {
        setError(`移除目录失败：${(err as Error).message}`)
      }
    },
    [applyCatalog],
  )

  return (
    <PageShell fullBleed>
      <div className="skills-toolbar">
        <div className="list-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="搜索技能名 / 描述…"
            aria-label="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {SOURCE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="filter-chip"
            aria-pressed={sourceFilter === f.key}
            onClick={() => setSourceFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <div style={{ flexGrow: 1 }} />
        <span className="result-count">
          {visible.length} / {skills.length} 个技能
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(true)}>
          <Icon name="refresh" style={{ width: 14, height: 14 }} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="skills-error">
          加载失败：{error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {loading && skills.length === 0 ? (
        <SkeletonList rows={6} />
      ) : visible.length === 0 && !error ? (
        sourceFilter === 'custom' && !hasCustomRoots ? (
          <div className="skills-empty skills-add-state">
            <div className="h">添加自定义技能目录</div>
            <div className="d">
              输入本机目录路径，立即加载其中的技能包（<code>&lt;名称&gt;/SKILL.md</code> 或{' '}
              <code>&lt;名称&gt;.md</code>，frontmatter 含 <code>name</code> 与{' '}
              <code>description</code>）。支持 <code>~/</code> 展开，保存后无需重启。
            </div>
            <AddDirInput onCatalog={applyCatalog} />
          </div>
        ) : (
          <div className="skills-empty">
            <div className="h">{skills.length === 0 ? '没有发现技能' : '没有匹配的技能'}</div>
            <div className="d">
              技能来自运行时目录（不落库）：在 <code>~/.agents/skills/&lt;name&gt;/SKILL.md</code> 或
              自定义目录放置 Agent Skills 标准格式的技能包后刷新。
            </div>
            {sourceFilter === 'custom' && hasCustomRoots ? (
              <div className="d mono">
                已配置的自定义目录（当前未扫出技能，请检查目录内容与格式）：
                {customRoots.map((r) => r.dir).join('、')}
              </div>
            ) : null}
          </div>
        )
      ) : (
        <div className="skills-list">
          {visible.map((s) => (
            <div key={s.name} className="skill-row">
              <button
                type="button"
                className="skill-row-head"
                aria-expanded={expanded === s.name}
                onClick={() => toggle(s.name)}
              >
                <Icon name="chevronRight" className="skill-chev" />
                <span className="skill-name">{s.name}</span>
                <span className="skill-desc">{s.description}</span>
                <span className="skill-source">{sourceLabel(s.source)}</span>
              </button>
              {expanded === s.name ? (
                <div className="skill-detail">
                  {detailLoading ? <div className="skill-detail-meta">加载中…</div> : null}
                  {detailError ? <div className="skill-detail-error">{detailError}</div> : null}
                  {detail ? (
                    <>
                      <div className="skill-detail-meta">
                        {detail.dir}
                        <span className="skill-detail-hint">
                          删除此技能 = 删除磁盘上的该目录（技能不落库，文件即真相；删后点「刷新」）
                        </span>
                      </div>
                      <pre className="skill-detail-body">{detail.content}</pre>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="skills-footer">
        {roots.map((r) => (
          <div key={`${r.source}:${r.dir}`} className="skills-footer-root">
            <span>
              发现根 · {sourceLabel(r.source)} → <span className="dir">{r.dir}</span>
            </span>
            {r.removable ? (
              <button
                type="button"
                className="skills-root-remove"
                aria-label={`移除目录 ${r.dir}`}
                title={r.removable ? '从列表移除（不删除磁盘文件）' : undefined}
                onClick={() => void removeRoot(r.dir)}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
        {footerAdding ? (
          <AddDirInput
            onCatalog={(catalog) => {
              applyCatalog(catalog)
              setFooterAdding(false)
            }}
          />
        ) : (
          <button
            type="button"
            className="skills-add-trigger"
            onClick={() => setFooterAdding(true)}
          >
            + 添加目录
          </button>
        )}
      </div>
    </PageShell>
  )
}
