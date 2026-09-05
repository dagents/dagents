'use client'

/**
 * Agent edit page — form that PATCHes the agent via /api/agents/:id.
 * Fields: name, summary, instructions, model, visibility.
 *
 * PX-AE01 layout: two-column grid (fixed 120px label column + field column),
 * mono instructions textarea (1.7 line-height), sticky bottom action bar
 * (blur + hairline, primary save button with spinner + disabled while saving).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { SkeletonList } from '@/components/skeleton'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import '@/styles/agents.css' // .icon-spin / .detail-back
import '@/styles/agent-detail.css' // .agent-edit-* grid + sticky bar

interface AgentEditData {
  name: string
  summary: string
  instructions: string
  model: string
  visibility: string
}

const EMPTY: AgentEditData = {
  name: '', summary: '', instructions: '', model: '', visibility: 'workspace',
}

export default function AgentEditPage({ params }: { params: Promise<{ id: string }> }): React.ReactElement {
  const { t } = useI18n()
  const toast = useToast()
  const router = useRouter()
  const [id, setId] = useState<string>('')
  const [data, setData] = useState<AgentEditData>(EMPTY)
  // PX-AE01 补：离开守卫的基准快照（保存成功后同步刷新，避免误报脏）
  const [initial, setInitial] = useState<AgentEditData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty =
    !loading && !saving && !notFound && JSON.stringify(data) !== JSON.stringify(initial)

  // 刷新/关闭/跳外站时拦截（App Router 无路由变化钩子，页内侧栏导航
  // 无法拦截——两个显式退出链接由 confirmLeave 兜底）。
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const confirmLeave = (): boolean =>
    !dirty || window.confirm(t('有未保存的更改，确定离开？'))

  useEffect(() => {
    let cancelled = false
    void params.then((p) => {
      if (cancelled) return
      setId(p.id)
      void fetch(`/api/agents/${encodeURIComponent(p.id)}`)
        .then(async (r) => {
          if (cancelled) return
          if (!r.ok) {
            // 404/410 previously fell through to an EMPTY editable form —
            // a ghost edit page for an id that doesn't exist.
            if (r.status === 404 || r.status === 410) setNotFound(true)
            else setError(t('加载失败（HTTP {status}）', { status: r.status }))
            return
          }
          const body = await r.json()
          if (cancelled) return
          const a = body.data?.agent ?? body.data
          if (a) {
            const next: AgentEditData = {
              name: a.name ?? '',
              summary: a.summary ?? '',
              instructions: a.instructions ?? '',
              model: a.model ?? '',
              visibility: a.visibility ?? 'workspace',
            }
            setData(next)
            setInitial(next)
          } else {
            setNotFound(true)
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })
    return () => {
      cancelled = true
    }
  }, [params, t])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (resp.ok) {
        setInitial(data) // 保存成功即不再脏，beforeunload/确认都不会拦跳转
        toast.success(t('已保存'))
        router.push(`/agents/${encodeURIComponent(id)}`)
      } else {
        const body = await resp.json().catch(() => ({}))
        setError(body.error ?? t('保存失败（HTTP {status}）', { status: resp.status }))
      }
    } catch (e) {
      setError(String(e))
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="page agent-edit-page">
        <SkeletonList rows={5} />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="page agent-edit-page">
        <div className="not-found">
          <div className="h">{t('找不到这个 Agent')}</div>
          <div className="d">{t('id “{id}” 不存在，可能已被删除。', { id })}</div>
          <Link className="btn btn-secondary btn-sm" href="/agents">
            {t('返回 Agent 列表')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page agent-edit-page">
      <div className="agent-edit-head">
        <Link className="detail-back" href={`/agents/${encodeURIComponent(id)}`} onClick={(e) => { if (!confirmLeave()) e.preventDefault() }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t('返回 Agent 详情')}
        </Link>
        <h1 className="agent-edit-title">{t('编辑 Agent')}</h1>
      </div>

      {error && (
        <div className="modal-error" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>{error}</div>
      )}

      {/* Two-column grid (PX-AE01): fixed 120px label column, fields aligned
          on one left edge. Inputs/textareas/selects use the shared shell form
          classes. */}
      <div className="agent-edit-form">
        <label htmlFor="edit-name" className="agent-edit-label">{t('名称 *')}</label>
        <input
          id="edit-name"
          type="text"
          className="input"
          maxLength={128}
          value={data.name}
          onChange={(e) => setData((d) => ({ ...d, name: e.target.value }))}
        />

        {/* 「描述」 matches the create dialog's label for the same field. */}
        <label htmlFor="edit-summary" className="agent-edit-label">{t('描述')}</label>
        <input
          id="edit-summary"
          type="text"
          className="input"
          value={data.summary}
          onChange={(e) => setData((d) => ({ ...d, summary: e.target.value }))}
        />

        <label htmlFor="edit-instructions" className="agent-edit-label">{t('指令 (Instructions)')}</label>
        <textarea
          id="edit-instructions"
          className="textarea agent-edit-instructions"
          rows={14}
          value={data.instructions}
          onChange={(e) => setData((d) => ({ ...d, instructions: e.target.value }))}
        />

        <label htmlFor="edit-model" className="agent-edit-label">{t('模型')}</label>
        <input
          id="edit-model"
          type="text"
          className="input"
          value={data.model}
          onChange={(e) => setData((d) => ({ ...d, model: e.target.value }))}
          placeholder={t('留空使用 CLI 默认模型')}
        />

        <label htmlFor="edit-visibility" className="agent-edit-label">{t('可见性')}</label>
        <select
          id="edit-visibility"
          className="select"
          value={data.visibility}
          onChange={(e) => setData((d) => ({ ...d, visibility: e.target.value }))}
        >
          <option value="workspace">{t('工作区')}</option>
          <option value="public">{t('公开')}</option>
          {/* Archived is intentionally editable here (this is also the
           * un-archive path) — the create dialog omits it; archiving a
           * live agent goes through the detail page's 归档 action. */}
          <option value="archived">{t('已归档')}</option>
        </select>
      </div>

      {/* Sticky action bar — blur + hairline top edge, primary right (PX-AE01) */}
      <div className="agent-edit-actions">
        {dirty ? (
          <span className="agent-edit-dirty" role="status">
            <span className="dot warn" aria-hidden="true" />
            {t('未保存的更改')}
          </span>
        ) : null}
        <Link
          href={`/agents/${encodeURIComponent(id)}`}
          className="btn btn-ghost"
          onClick={(e) => {
            if (!confirmLeave()) e.preventDefault()
          }}
        >
          {t('取消')}
        </Link>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={saving || !data.name}
        >
          {saving ? <Icon name="loader" className="icon-spin" style={{ width: 14, height: 14 }} /> : null}
          {saving ? t('保存中…') : t('保存')}
        </button>
      </div>
    </div>
  )
}
