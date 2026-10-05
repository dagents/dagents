'use client'

/**
 * FlowContextDialog —— 画布「上下文」面板（2026-10-04 P2a flow 级上下文）。
 *
 * flows.context_md：随 flow 走的常驻上下文（CLAUDE.md 的 flow 版），运行时
 * 经字节预算（默认 8KB，DAGENTS_FLOW_CONTEXT_CAP）预裁后注入 LLM/Agent
 * 节点 system 前部。结构变更保存时随版本一起快照，回滚一并恢复。
 */

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import './flow-context.css'

export function FlowContextDialog({
  open,
  onClose,
  flowId,
  initialContext,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  flowId: string
  initialContext: string | null
  /** 保存成功回调（父组件可 bump 刷新/提示）。 */
  onSaved?: () => void
}): React.ReactElement | null {
  const { t } = useI18n()
  const [value, setValue] = useState(initialContext ?? '')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValue(initialContext ?? '')
      setNotice(null)
    }
  }, [open, initialContext])

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextMd: value.trim().length > 0 ? value : null }),
      })
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setNotice(t('已保存'))
      onSaved?.()
      setTimeout(onClose, 600)
    } catch (err) {
      setNotice(t('保存失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
    }
  }, [flowId, value, saving, onClose, onSaved, t])

  if (!open) return null

  return (
    <div className="flow-ctx-panel" role="dialog" aria-label={t('流程上下文')}>
      <div className="flow-ctx-head">
        <span className="flow-ctx-title">{t('流程上下文')}</span>
        <button type="button" className="flow-ctx-close" onClick={onClose} aria-label={t('关闭')}>
          ×
        </button>
      </div>
      <div className="flow-ctx-hint">
        {t('运行时注入每个 LLM / Agent 节点的系统提示前部（预算内截断）；随版本快照与回滚。')}
      </div>
      <textarea
        className="flow-ctx-editor"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={12}
        maxLength={131072}
        placeholder={t('例：本流程的领域背景、术语表、固定约束、输出风格要求…')}
        spellCheck={false}
      />
      <div className="flow-ctx-foot">
        <span className="flow-ctx-count tnum">{value.length.toLocaleString()} / 131,072</span>
        {notice ? <span className="flow-ctx-notice">{notice}</span> : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? t('保存中…') : t('保存')}
        </button>
      </div>
    </div>
  )
}
