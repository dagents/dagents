/**
 * AuditLog — 审计日志查看器（settings "审计日志" tab）。
 *
 * 列表式审计浏览：顶部筛选条（target type / action 文本 / actor type）+ 表格
 * 列表（时间 / 操作者 / 动作徽章 / 目标 / IP）+ 可展开的 detail JSON。光标
 * 分页用「加载更多」按钮，符合审计浏览场景（非无限滚动 —— 审计场景偶尔需要
 * 停下来翻看）。
 *
 * 数据流：browser → /api/audit (console proxy) → gateway GET /api/v1/audit。
 * 客户端 lib（@/lib/audit）封装了 envelope unwrap 和 items→entries 重命名。
 *
 * 视觉：复用全局 `.table-wrap` + `table.data` + `.filter-chip` + `.tokens-toolbar`
 * 原语，page-local CSS 只覆盖审计特有的部分（动作徽章配色、detail JSON 折叠、
 * 加载骨架、移动端卡片堆叠）。所有颜色走 CSS token，无硬编码 hex。
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@/components/icon'
import { fetchAudit, type AuditEntry } from '@/lib/audit'
import { useI18n } from '@/i18n'
import '@/styles/audit-log.css'

/** 页大小 —— 审计浏览偏大页（gateway cap 200，我们用 50 平衡首屏与翻页）。 */
const PAGE_SIZE = 50

/** targetType 下拉选项 —— 覆盖审计表实际出现的 target_type 值。 */
type TargetFilter = 'all' | 'token' | 'pipeline_version' | 'llm_provider'
const TARGET_OPTIONS: ReadonlyArray<{ value: TargetFilter; label: string }> = [
  { value: 'all', label: '全部目标' },
  { value: 'token', label: '令牌 (token)' },
  { value: 'pipeline_version', label: '流水线版本 (pipeline_version)' },
  { value: 'llm_provider', label: 'LLM Provider (llm_provider)' },
]

/** actorType 筛选 chip —— gateway 仅接受 'user' | 'system'。 */
type ActorFilter = 'all' | 'user' | 'system'
const ACTOR_OPTIONS: ReadonlyArray<{ value: ActorFilter; label: string }> = [
  { value: 'all', label: '全部操作者' },
  { value: 'user', label: '用户' },
  { value: 'system', label: '系统' },
]

/** action 徽章配色 —— 按动作动词前缀分色。 */
type ActionTone = 'create' | 'update' | 'delete' | 'default'

/** 根据 action 字符串推断徽章色调（create/update/delete/默认）。 */
function actionTone(action: string): ActionTone {
  const a = action.toLowerCase()
  if (a.includes('create') || a.includes('add') || a.startsWith('post')) return 'create'
  if (a.includes('update') || a.includes('patch') || a.includes('rotate') || a.includes('toggle')) return 'update'
  if (a.includes('delete') || a.includes('remove') || a.includes('revoke')) return 'delete'
  return 'default'
}

const ACTION_TONE_LABEL: Record<ActionTone, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  default: '其他',
}

/** actorType → 图标 + 中文标签。 */
function actorVisual(actorType: string): { icon: IconName; label: string } {
  switch (actorType) {
    case 'user':
      return { icon: 'user', label: '用户' }
    case 'system':
      return { icon: 'zap', label: '系统' }
    default:
      return { icon: 'bot', label: actorType }
  }
}

/** 相对时间 —— "刚刚 / 3分钟前 / 2小时前 / 3天前 / 绝对日期"。
 *  `t` 来自调用方 useI18n()，单位随语言切换。 */
type TFn = (key: string, params?: Record<string, string | number>) => string
function timeAgo(iso: string, t: TFn): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return t('刚刚')
  if (diff < 3_600_000) return t('{n} 分钟前', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} 小时前', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('{n} 天前', { n: Math.floor(diff / 86_400_000) })
  // 老于一周回退到绝对日期，避免"30 天前"这种没信息量的表达
  return new Date(iso).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 绝对时间 title（hover 看精确时间）—— ISO + 本地串。 */
function timeTitle(iso: string): string {
  const d = new Date(iso)
  return `${d.toISOString()} · ${d.toLocaleString()}`
}

/** 截断 id —— 表格列宽有限，长 UUID/ULID 截断到 8 位并加省略号。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

export function AuditLog(): React.ReactElement {
  const { t } = useI18n()
  // ─── 筛选状态 ──────────────────────────────────────────────
  const [targetFilter, setTargetFilter] = useState<TargetFilter>('all')
  const [actorFilter, setActorFilter] = useState<ActorFilter>('all')
  const [actionInput, setActionInput] = useState('')

  // ─── 数据状态 ──────────────────────────────────────────────
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true) // 首屏 / 筛选变更
  const [loadingMore, setLoadingMore] = useState(false) // 加载更多
  const [error, setError] = useState<string | null>(null)

  // 已展开 detail 的 entry id 集合（toggle 展开/折叠 JSON）
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // action 输入防抖：用户停下打字 400ms 后再触发查询，避免每个键都打网关
  const [debouncedAction, setDebouncedAction] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedAction(actionInput.trim()), 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [actionInput])

  // ─── 加载（首屏 / 筛选变更时重置） ─────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchAudit({
        targetType: targetFilter === 'all' ? undefined : targetFilter,
        actorType: actorFilter === 'all' ? undefined : actorFilter,
        action: debouncedAction || undefined,
        limit: PAGE_SIZE,
      })
      setEntries(res.entries)
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
      setNextCursor(null)
    } finally {
      setLoading(false)
    }
  }, [targetFilter, actorFilter, debouncedAction])

  useEffect(() => {
    void load()
  }, [load])

  // ─── 加载更多（光标翻页，追加到现有列表） ───────────────────
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetchAudit({
        targetType: targetFilter === 'all' ? undefined : targetFilter,
        actorType: actorFilter === 'all' ? undefined : actorFilter,
        action: debouncedAction || undefined,
        before: nextCursor,
        limit: PAGE_SIZE,
      })
      setEntries((prev) => [...prev, ...res.entries])
      setNextCursor(res.nextCursor)
    } catch (err) {
      // 加载更多失败用 error 态但不清空已有数据 —— 用户可重试
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, targetFilter, actorFilter, debouncedAction])

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const hasEntries = entries.length > 0
  const hasMore = nextCursor !== null

  return (
    <section className="settings-section active audit-log" aria-label={t('审计日志')}>
      <div className="row-between mb-4 audit-log-head">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{t('审计日志')}</div>
          <div className="muted mt-2" style={{ fontSize: 13 }}>
            {t('平台全部写操作的安全审计轨迹。记录操作者、动作、目标与来源 IP，便于追溯与合规排查。')}
          </div>
        </div>
      </div>

      {/* ─── 筛选条 ─── */}
      <div className="tokens-toolbar audit-filters">
        <label className="audit-filter-field">
          <span className="audit-filter-label">{t('目标类型')}</span>
          <select
            className="select"
            aria-label={t('按目标类型筛选')}
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value as TargetFilter)}
          >
            {TARGET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.label)}</option>
            ))}
          </select>
        </label>

        <label className="audit-filter-field">
          <span className="audit-filter-label">{t('操作动作')}</span>
          <input
            type="search"
            className="input"
            placeholder={t('如 token.create…')}
            aria-label={t('按动作筛选')}
            value={actionInput}
            onChange={(e) => setActionInput(e.target.value)}
          />
        </label>

        <div className="audit-filter-chips" role="group" aria-label={t('按操作者类型筛选')}>
          <span className="audit-filter-label">{t('操作者')}</span>
          {ACTOR_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className="filter-chip"
              aria-pressed={actorFilter === o.value}
              onClick={() => setActorFilter(o.value)}
            >
              {t(o.label)}
            </button>
          ))}
        </div>

        <span className="tk-count">{hasEntries ? t('{n} 条记录', { n: entries.length }) : ''}</span>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('刷新审计日志')}
        >
          <Icon name="refresh" className="audit-refresh-icon" />
          {t('刷新')}
        </button>
      </div>

      {/* ─── 列表 ─── */}
      <div className="audit-body">
        {loading ? (
          <AuditSkeleton />
        ) : error && !hasEntries ? (
          <div className="audit-empty audit-error" role="alert">
            <Icon name="alertCircle" className="audit-empty-icon audit-empty-icon-danger" />
            <div className="audit-empty-title">{t('加载失败')}</div>
            <div className="audit-empty-desc">{error}</div>
            <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => void load()}>
              {t('重试')}
            </button>
          </div>
        ) : !hasEntries ? (
          <div className="audit-empty">
            <Icon name="info" className="audit-empty-icon" />
            <div className="audit-empty-title">{t('暂无审计记录')}</div>
            <div className="audit-empty-desc">
              {targetFilter !== 'all' || actorFilter !== 'all' || debouncedAction
                ? t('当前筛选条件下没有匹配的审计记录。试试调整或清空筛选。')
                : t('还没有任何审计事件被记录。当平台发生写操作（令牌、Provider、版本等）时，事件会出现在这里。')}
            </div>
          </div>
        ) : (
          <>
            {/* 桌面：表格布局 */}
            <div className="table-wrap audit-table-wrap">
              <table className="data audit-table">
                <thead>
                  <tr>
                    <th style={{ width: '14%' }}>{t('时间')}</th>
                    <th style={{ width: '20%' }}>{t('操作者')}</th>
                    <th style={{ width: '14%' }}>{t('动作')}</th>
                    <th style={{ width: '20%' }}>{t('目标')}</th>
                    <th>{t('详情')}</th>
                    <th style={{ width: '12%' }}>{t('来源 IP')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <AuditRow
                      key={e.id}
                      entry={e}
                      expanded={expanded.has(e.id)}
                      onToggle={() => toggleExpand(e.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* 加载更多 / 翻页 / 错误（追加失败时保留已有数据） */}
            {hasMore ? (
              <div className="audit-load-more">
                {error ? (
                  <div className="audit-load-more-error" role="alert">
                    {t('加载更多失败：{msg}', { msg: error })}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm ml-2"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                    >
                      {t('重试')}
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? t('加载中…') : t('加载更多')}
                </button>
              </div>
            ) : (
              <div className="audit-end-hint muted">{t('已到达最旧记录')}</div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** 单行审计记录 —— 表格行（桌面）+ 卡片（移动端，由 CSS 切换）。 */
function AuditRow(props: {
  entry: AuditEntry
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const { entry, expanded, onToggle } = props
  const tone = actionTone(entry.action)
  const actor = actorVisual(entry.actorType)
  const hasDetail = entry.detail != null && Object.keys(entry.detail).length > 0

  return (
    <tr className={`audit-row ${expanded ? 'audit-row-expanded' : ''}`}>
      <td className="audit-cell-time">
        <time dateTime={entry.createdAt} title={timeTitle(entry.createdAt)}>
          {timeAgo(entry.createdAt, t)}
        </time>
      </td>
      <td className="audit-cell-actor">
        <span className="audit-actor">
          <Icon name={actor.icon} className="audit-actor-icon" />
          <span className="audit-actor-meta">
            <span className="audit-actor-type">{t(actor.label)}</span>
            <span className="audit-actor-id mono">{shortId(entry.actorId)}</span>
          </span>
        </span>
      </td>
      <td className="audit-cell-action">
        <span className={`audit-badge audit-badge-${tone}`} title={entry.action}>
          {t(ACTION_TONE_LABEL[tone])}
        </span>
        <span className="audit-action-name mono">{entry.action}</span>
      </td>
      <td className="audit-cell-target">
        <span className="audit-target-type">{entry.targetType}</span>
        <span className="audit-target-id mono">{shortId(entry.targetId)}</span>
      </td>
      <td className="audit-cell-detail">
        {hasDetail ? (
          <button
            type="button"
            className="audit-detail-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? t('折叠详情') : t('展开详情')}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className="audit-detail-chevron" />
            {expanded ? t('折叠') : t('详情')}
          </button>
        ) : (
          <span className="muted audit-detail-none">—</span>
        )}
        {expanded && hasDetail ? (
          <pre className="audit-detail-json mono">{JSON.stringify(entry.detail, null, 2)}</pre>
        ) : null}
      </td>
      <td className="audit-cell-ip">
        {entry.ip ? <span className="audit-ip mono">{entry.ip}</span> : <span className="muted">—</span>}
      </td>
    </tr>
  )
}

/** 加载骨架 —— 表格行的 shimmer 占位，复用全局 .skeleton / .skeleton-text。 */
function AuditSkeleton(): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className="table-wrap audit-table-wrap">
      <table className="data audit-table">
        <thead>
          <tr>
            <th style={{ width: '14%' }}>{t('时间')}</th>
            <th style={{ width: '20%' }}>{t('操作者')}</th>
            <th style={{ width: '14%' }}>{t('动作')}</th>
            <th style={{ width: '20%' }}>{t('目标')}</th>
            <th>{t('详情')}</th>
            <th style={{ width: '12%' }}>{t('来源 IP')}</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, i) => (
            <tr key={i} className="audit-skeleton-row">
              <td><div className="skeleton skeleton-text" style={{ width: '70%' }} /></td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <div className="skeleton" style={{ width: 16, height: 16, borderRadius: '50%' }} />
                  <div className="skeleton skeleton-text" style={{ width: '60%' }} />
                </div>
              </td>
              <td><div className="skeleton" style={{ width: 40, height: 18, borderRadius: 'var(--radius-pill)' }} /></td>
              <td><div className="skeleton skeleton-text" style={{ width: '70%' }} /></td>
              <td><div className="skeleton skeleton-text" style={{ width: '30%' }} /></td>
              <td><div className="skeleton skeleton-text" style={{ width: '60%' }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default AuditLog
