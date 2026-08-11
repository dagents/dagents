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
      <div className="mb-4">
        <Link className="detail-back" href={`/agents/${encodeURIComponent(id)}`}>
          <Icon name="chevronLeft" style={{ width: 16, height: 16 }} />
          返回 Agent 详情
        </Link>
      </div>

      <h1 className="mb-6" style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>编辑 Agent</h1>

      {error && (
        <div className="mb-4" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{error}</div>
      )}

      <div className="mb-4">
        <label className="block mb-1" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>名称</label>
        <input
          type="text"
          className="agent-edit-input"
          value={data.name}
          onChange={(e) => setData((d) => ({ ...d, name: e.target.value }))}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)' }}
        />
      </div>

      <div className="mb-4">
        <label className="block mb-1" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>简介</label>
        <input
          type="text"
          className="agent-edit-input"
          value={data.summary}
          onChange={(e) => setData((d) => ({ ...d, summary: e.target.value }))}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)' }}
        />
      </div>

      <div className="mb-4">
        <label className="block mb-1" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>指令 (Instructions)</label>
        <textarea
          className="agent-edit-input"
          rows={5}
          value={data.instructions}
          onChange={(e) => setData((d) => ({ ...d, instructions: e.target.value }))}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)', resize: 'vertical' }}
        />
      </div>

      <div className="mb-4">
        <label className="block mb-1" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>模型</label>
        <input
          type="text"
          className="agent-edit-input"
          value={data.model}
          onChange={(e) => setData((d) => ({ ...d, model: e.target.value }))}
          placeholder="留空使用 CLI 默认模型"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)' }}
        />
      </div>

      <div className="mb-6">
        <label className="block mb-1" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>可见性</label>
        <select
          className="agent-edit-input"
          value={data.visibility}
          onChange={(e) => setData((d) => ({ ...d, visibility: e.target.value }))}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)' }}
        >
          <option value="workspace">Workspace</option>
          <option value="public">Public</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div className="flex gap-2">
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
  )
}
