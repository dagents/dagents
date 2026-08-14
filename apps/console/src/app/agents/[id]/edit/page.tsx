'use client'

/**
 * Agent edit page — simple form that PATCHes the agent via /api/agents/:id.
 * Fields: name, summary, instructions, model, visibility.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'

interface AgentEditData {
  name: string
  summary: string
  instructions: string
  model: string
  visibility: string
}

export default function AgentEditPage({ params }: { params: Promise<{ id: string }> }): React.ReactElement {
  const router = useRouter()
  const [id, setId] = useState<string>('')
  const [data, setData] = useState<AgentEditData>({
    name: '', summary: '', instructions: '', model: '', visibility: 'workspace',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void params.then((p) => {
      setId(p.id)
      void fetch(`/api/agents/${encodeURIComponent(p.id)}`)
        .then((r) => r.json())
        .then((body) => {
          const a = body.data?.agent ?? body.data
          if (a) {
            setData({
              name: a.name ?? '',
              summary: a.summary ?? '',
              instructions: a.instructions ?? '',
              model: a.model ?? '',
              visibility: a.visibility ?? 'workspace',
            })
          }
        })
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false))
    })
  }, [params])

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
        router.push(`/agents/${encodeURIComponent(id)}`)
      } else {
        const body = await resp.json().catch(() => ({}))
        setError(body.error ?? `保存失败 (${resp.status})`)
      }
    } catch (e) {
      setError(String(e))
    }
    setSaving(false)
  }

  if (loading) {
    return <div className="page" style={{ padding: 'var(--space-6)' }}>加载中…</div>
  }

  return (
    <div className="page" style={{ padding: 'var(--space-6)', maxWidth: 640 }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Link className="btn btn-ghost btn-sm" href={`/agents/${encodeURIComponent(id)}`}>
          <Icon name="chevronLeft" style={{ width: 14, height: 14 }} />
          返回 Agent 详情
        </Link>
      </div>

      <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, margin: '0 0 var(--space-6)' }}>编辑 Agent</h1>

      {error && (
        <div className="modal-error" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>{error}</div>
      )}

      {/* Fields use the global form system (.field / .input / .textarea / .select
          from shell.css) — same visual language as every other form in the app. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div className="field">
          <label htmlFor="edit-name">名称</label>
          <input
            id="edit-name"
            type="text"
            className="input"
            value={data.name}
            onChange={(e) => setData((d) => ({ ...d, name: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-summary">简介</label>
          <input
            id="edit-summary"
            type="text"
            className="input"
            value={data.summary}
            onChange={(e) => setData((d) => ({ ...d, summary: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-instructions">指令 (Instructions)</label>
          <textarea
            id="edit-instructions"
            className="textarea"
            rows={5}
            value={data.instructions}
            onChange={(e) => setData((d) => ({ ...d, instructions: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="edit-model">模型</label>
          <input
            id="edit-model"
            type="text"
            className="input"
            value={data.model}
            onChange={(e) => setData((d) => ({ ...d, model: e.target.value }))}
            placeholder="留空使用 CLI 默认模型"
          />
        </div>

        <div className="field">
          <label htmlFor="edit-visibility">可见性</label>
          <select
            id="edit-visibility"
            className="select"
            value={data.visibility}
            onChange={(e) => setData((d) => ({ ...d, visibility: e.target.value }))}
          >
            <option value="workspace">工作区</option>
            <option value="public">公开</option>
            <option value="archived">已归档</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSave()}
            disabled={saving || !data.name}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <Link href={`/agents/${encodeURIComponent(id)}`} className="btn btn-ghost btn-sm">
            取消
          </Link>
        </div>
      </div>
    </div>
  )
}
