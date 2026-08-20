'use client'

/**
 * SaveFlowTemplateDialog — 画布页「另存为模板」小 modal（docs/flow-templates.md §5）。
 *
 * POST from-flow：gateway 侧做抽取清洗（platformAgent → 人格名引用、剥运行态
 * 字段），这里只收集名称/描述/图标/分类。成功后 toast + 关闭。
 */

import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import { extractFlowTemplate } from '@/lib/flow-templates'
import '@/styles/dialog.css'

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'custom', label: '自定义' },
  { key: 'dev', label: '开发' },
  { key: 'research', label: '调研' },
  { key: 'content', label: '内容' },
  { key: 'ops', label: '运维' },
]

export interface SaveFlowTemplateDialogProps {
  open: boolean
  onClose: () => void
  flowId: string
  flowName: string
}

export function SaveFlowTemplateDialog({
  open,
  onClose,
  flowId,
  flowName,
}: SaveFlowTemplateDialogProps): React.ReactElement | null {
  const toast = useToast()
  const { t } = useI18n()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('📄')
  const [category, setCategory] = useState('custom')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(`${flowName}（模板）`)
    setDescription('')
    setIcon('📄')
    setCategory('custom')
    setError(null)
  }, [open, flowName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  if (!open) return null

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError(t('模板名称不能为空'))
      return
    }
    setSubmitting(true)
    try {
      const result = await extractFlowTemplate(flowId, {
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || '📄',
        category,
      })
      toast.success(t('已保存为模板（{n} 个 Agent 引用）', { n: result.agentRefCount }))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose} aria-hidden="true" />
      <div
        className="modal-dialog open ftpl-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('另存为模板')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('另存为模板')}</h2>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onClose} disabled={submitting}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="ftpl-save-form">
            <label>
              <span>{t('名称')}</span>
              <input className="input" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span>{t('描述')}</span>
              <textarea
                className="textarea"
                value={description}
                maxLength={2000}
                rows={2}
                placeholder={t('这个模板适合什么场景？（可选）')}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="ftpl-save-row">
              <label>
                <span>{t('图标')}</span>
                <input className="input" value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} />
              </label>
              <label>
                <span>{t('分类')}</span>
                <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{t(c.label)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ftpl-save-hint">
              {t('Agent 节点将以「人格名」保存引用：实例化时自动重绑，未挂人格库则降级为 LLM 节点。')}
            </div>
            {error && <div className="ftpl-save-error">{error}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? t('保存中…') : t('保存模板')}
          </button>
        </div>
      </div>
    </>
  )
}
