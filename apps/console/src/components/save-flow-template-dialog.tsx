'use client'

/**
 * SaveFlowTemplateDialog — 画布页「另存为模板」小 modal（docs/flow-templates.md §5）。
 *
 * POST from-flow：gateway 侧做抽取清洗（platformAgent → 人格名引用、剥运行态
 * 字段），这里只收集名称/描述/图标/分类。成功后 toast + 关闭。
 */

import { useEffect, useMemo, useState } from 'react'
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

/* ── 模板参数扫描（与 gateway flow-template-pipeline.ts 的
 * scanTemplateParams 同规：同正则、同字段域、同引擎保留字）—— 保存前
 * 预览「这个模板会参数化哪些 {{变量}}」，chip 网格呈现（PX-CV04）。 */
const PARAM_PATTERN = /\{\{\s*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*\}\}/g
const PARAM_FIELDS = ['systemPrompt', 'prompt', 'userPrompt', 'content', 'question'] as const
const ENGINE_RESERVED_PARAMS = new Set([
  'input',
  'question',
  'chat_history',
  'current_date_time',
  'runtime_messages_length',
  'loop_count',
  'file_attachment',
])

/** 扫描节点文案里的 `{{变量}}`（去重、保序、剔除引擎运行时变量）。 */
export function scanTemplateParamNames(
  nodes: ReadonlyArray<{ data?: Record<string, unknown> }>,
): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const node of nodes) {
    const data = node.data
    if (!data) continue
    const inputs = (data.inputs ?? {}) as Record<string, unknown>
    for (const field of PARAM_FIELDS) {
      for (const value of [data[field], inputs[field]]) {
        if (typeof value !== 'string') continue
        for (const match of value.matchAll(PARAM_PATTERN)) {
          const name = match[1]
          if (!name || ENGINE_RESERVED_PARAMS.has(name) || seen.has(name)) continue
          seen.add(name)
          names.push(name)
        }
      }
    }
  }
  return names
}

export interface SaveFlowTemplateDialogProps {
  open: boolean
  onClose: () => void
  flowId: string
  flowName: string
  /** 扫描出的 `{{变量}}` 名单（PX-CV04 chip 网格预览；空数组 = 无参数）。 */
  paramNames?: string[]
}

export function SaveFlowTemplateDialog({
  open,
  onClose,
  flowId,
  flowName,
  paramNames = [],
}: SaveFlowTemplateDialogProps): React.ReactElement | null {
  const toast = useToast()
  const { t } = useI18n()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('📄')
  const [category, setCategory] = useState('custom')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 每个变量的可选默认值（name → defaultValue），提交时随 params 透传。 */
  const [defaultValues, setDefaultValues] = useState<Record<string, string>>({})
  const shownParamNames = useMemo(() => paramNames.slice(0, 24), [paramNames])

  useEffect(() => {
    if (!open) return
    setName(`${flowName}（模板）`)
    setDescription('')
    setIcon('📄')
    setCategory('custom')
    setError(null)
    setDefaultValues({})
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
        // 只透传有值的默认值（gateway 与自身扫描结果按名合并）
        params: shownParamNames
          .filter((n) => (defaultValues[n] ?? '').trim().length > 0)
          .map((n) => ({ name: n, defaultValue: defaultValues[n]!.trim() })),
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
            {shownParamNames.length > 0 ? (
              <div className="ftpl-save-params">
                <span className="ftpl-save-params-label">{t('模板参数（实例化时回填）')}</span>
                <div className="ftpl-save-param-grid">
                  {shownParamNames.map((param) => (
                    <label key={param} className="ftpl-save-param-chip">
                      <span className="ftpl-save-param-name" title={`{{${param}}}`}>{`{{${param}}}`}</span>
                      <input
                        className="ftpl-save-param-default"
                        value={defaultValues[param] ?? ''}
                        maxLength={200}
                        placeholder={t('默认值')}
                        aria-label={t('{name} 的默认值', { name: param })}
                        disabled={submitting}
                        onChange={(e) =>
                          setDefaultValues((prev) => ({ ...prev, [param]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
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
