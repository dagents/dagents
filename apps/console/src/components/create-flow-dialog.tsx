'use client'

/**
 * Create Flow dialog — modal form for creating a new flow.
 *
 * Collects name (required) + description (optional), then POSTs /api/workflows
 * with an empty flowData ({ nodes: [], edges: [] }). On success the parent
 * navigates to /workflows/:id/canvas so the user can immediately start
 * building the DAG in the Flowise canvas editor.
 *
 * Mirrors the CreateAgentDialog pattern (single modal, single form) — see
 * components/create-agent-dialog.tsx.
 */

import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/dialog.css'
// flows.css 提供 PX-F05 增强态（.btn-spinner / .fdialog-field-error）；
// 选择器均为 flow 对话框专属类名，无页面级副作用。
import '@/styles/flows.css'

// POST /api/workflows 网关封套是 {success, data:{flow:{id,name}}}（console
// 代理原样透传）。此前这里按 data.id 取值拿到 undefined —— UI 新建 flow
// 会跳到 /workflows/undefined/canvas（e2e UI-01 钉住的回归）。
interface CreateFlowResponse {
  flow: { id: string; name: string }
}

export interface CreateFlowDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}

export function CreateFlowDialog({
  open,
  onClose,
  onCreated,
}: CreateFlowDialogProps): React.ReactElement | null {
  const { t } = useI18n()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  // Reset form when closed
  useEffect(() => {
    if (open) return
    setName('')
    setDescription('')
    setError(null)
  }, [open])

  if (!open) return null

  const nameValid = name.trim().length > 0 && name.trim().length <= 200
  const canSubmit = nameValid && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          flowData: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        }),
      })
      const json = (await res.json()) as { success: boolean; data?: CreateFlowResponse; error?: string }
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error ?? t('创建失败（HTTP {status}）', { status: res.status }))
      }
      onCreated(json.data.flow.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="drawer-backdrop open"
        onClick={submitting ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className="modal-dialog open"
        role="dialog"
        aria-modal="true"
        aria-label={t('新建 Flow')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('新建 Flow')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('关闭')}
            onClick={onClose}
            disabled={submitting}
          >
            <Icon name="close" />
          </button>
        </div>

        {/* Real <form> so Enter in the name field submits (previously Enter
            did nothing — no form element, no keydown handler). */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="modal-body">
            <div className="form-section">
              <div className="form-section-label">{t('基本信息')}</div>
              <div className="field">
                <label htmlFor="flow-name">{t('名称 *')}</label>
                <input
                  id="flow-name"
                  type="text"
                  className={`input${name.length === 0 ? '' : nameValid ? '' : ' invalid'}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('例如 代码审查流程')}
                  maxLength={200}
                  autoFocus
                  aria-invalid={name.length > 0 && !nameValid}
                  aria-describedby={name.length > 0 && !nameValid ? 'flow-name-error' : undefined}
                />
                {name.length > 0 && !nameValid ? (
                  <div id="flow-name-error" className="field-error" role="alert" style={{ display: 'block' }}>
                    {t('名称需 1–200 个字符')}
                  </div>
                ) : null}
                {/* PX-F05：提交错误贴字段下方（红字），不再落对话框顶部 */}
                {error ? (
                  <div className="fdialog-field-error" role="alert">
                    {error}
                  </div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="flow-desc">{t('描述')}</label>
                <textarea
                  id="flow-desc"
                  className="textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('一句话说明这个 Flow 做什么')}
                  rows={2}
                  maxLength={2000}
                />
              </div>
            </div>

            <div className="modal-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)', padding: 'var(--space-2) 0' }}>
              {t('创建后会自动跳转到画布编辑器，可在其中添加节点和连线。')}
            </div>
          </div>

          <div className="modal-foot">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t('取消')}
            </button>
            {/* PX-F05：主按钮 --ctl-lg（去掉 btn-sm），加载态文字「创建中…」+ 14px spinner */}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSubmit}
            >
              {submitting ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  {t('创建中…')}
                </>
              ) : (
                t('创建并编辑')
              )}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
