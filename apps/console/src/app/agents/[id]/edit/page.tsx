'use client'

/**
 * Agent edit page — simple form that PATCHes the agent via /api/agents/:id.
 * Fields: name, summary, instructions, model, visibility.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { SkeletonList } from '@/components/skeleton'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'

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
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
            setData({
              name: a.name ?? '',
              summary: a.summary ?? '',
              instructions: a.instructions ?? '',
              model: a.model ?? '',
              visibility: a.visibility ?? 'workspace',
            })
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
      <div className="page" style={{ padding: 'var(--space-6)', maxWidth: 640 }}>
        <SkeletonList rows={5} />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="page" style={{ padding: 'var(--space-6)', maxWidth: 640 }}>
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
    <div className="page" style={{ padding: 'var(--space-6)', maxWidth: 640 }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Link className="btn btn-ghost btn-sm" href={`/agents/${encodeURIComponent(id)}`}>
          <Icon name="chevronLeft" style={{ width: 14, height: 14 }} />
          {t('返回 Agent 详情')}
        </Link>
      </div>

      <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, margin: '0 0 var(--space-6)' }}>{t('编辑 Agent')}</h1>

      {error && (
        <div className="modal-error" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>{error}</div>
      )}

      {/* Fields use the global form system (.field / .input / .textarea / .select
          from shell.css) — same visual language as every other form in the app. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div className="field">
          <label htmlFor="edit-name">{t('名称 *')}</label>
          <input
            id="edit-name"
            type="text"
            className="input"
            maxLength={128}
            value={data.name}
            onChange={(e) => setData((d) => ({ ...d, name: e.target.value }))}
          />
        </div>

        {/* 「描述」 matches the create dialog's label for the same field. */}
        <div className="field">
          <label htmlFor="edit-summary">{t('描述')}</label>
          <input
            id="edit-summary"
            type="text"
            className="input"
            value={data.summary}
            onChange={(e) => setData((d) => ({ ...d, summary: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-instructions">{t('指令 (Instructions)')}</label>
          <textarea
            id="edit-instructions"
            className="textarea"
            rows={5}
            value={data.instructions}
            onChange={(e) => setData((d) => ({ ...d, instructions: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-model">{t('模型')}</label>
          <input
            id="edit-model"
            type="text"
            className="input"
            value={data.model}
            onChange={(e) => setData((d) => ({ ...d, model: e.target.value }))}
            placeholder={t('留空使用 CLI 默认模型')}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-visibility">{t('可见性')}</label>
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

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSave()}
            disabled={saving || !data.name}
          >
            {saving ? t('保存中…') : t('保存')}
          </button>
          <Link href={`/agents/${encodeURIComponent(id)}`} className="btn btn-ghost btn-sm">
            {t('取消')}
          </Link>
        </div>
      </div>
    </div>
  )
}
