'use client'

/**
 * GenerateFlowDialog — 「一句话生成」对话框（PRD F7）。
 *
 * 与画布 vendor 对话框、聊天 @workflow 共用同一后端管线（gateway
 * flow-generator.ts：CLI 优先/HTTP 兜底 → 拓扑校验 → 一轮修复 → 显式失败），
 * 这里是 console 原生入口：首页 / Flows 工具栏 / 任何需要「描述→画布」的
 * 地方。BFF 返回 vendor 形状（type=节点名），落库前转回 canonical
 * customNode —— 与 BFF 的 toVendorFlow 互逆。
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/dialog.css'

interface VendorNode {
  id: string
  type: string
  position?: { x: number; y: number }
  data: Record<string, unknown>
}

interface VendorFlow {
  nodes: VendorNode[]
  edges: Array<{ id: string; source: string; target: string }>
}

export interface GenerateFlowDialogProps {
  open: boolean
  onClose: () => void
  /** 生成成功后的跳转目标（默认画布）。 */
  onCreated?: (flowId: string) => void
}

export function GenerateFlowDialog({
  open,
  onClose,
  onCreated,
}: GenerateFlowDialogProps): React.ReactElement | null {
  const router = useRouter()
  const { t } = useI18n()
  const [question, setQuestion] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setQuestion('')
      setError(null)
      setGenerating(false)
    }
  }, [open])

  // Escape 关闭（与 CreateFlowDialog 同契约）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !generating) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, generating])

  if (!open) return null

  const canSubmit = question.trim().length > 0 && !generating

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setGenerating(true)
    setError(null)
    try {
      // ① 生成（BFF → gateway 统一管线；失败显式抛出，无静默兜底）
      const res = await fetch('/api/flowise/api/v1/agentflowv2-generator/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      })
      const json = (await res.json()) as
        | { success?: false; error?: string; message?: string }
        | VendorFlow
      if (!res.ok) {
        throw new Error(
          (json as { error?: string; message?: string }).error
            ?? (json as { message?: string }).message
            ?? t('生成失败（HTTP {status}）', { status: res.status }),
        )
      }
      const vendor = json as VendorFlow
      if (!Array.isArray(vendor.nodes) || vendor.nodes.length === 0) {
        throw new Error(t('未生成有效的流程节点，请换一种描述重试'))
      }

      // ② vendor → canonical（type=节点名 → customNode + data.name）
      const flowData = {
        nodes: vendor.nodes.map((n) => ({
          id: n.id,
          type: 'customNode',
          position: n.position ?? { x: 0, y: 0 },
          data: { ...n.data, name: n.type },
        })),
        edges: vendor.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        viewport: { x: 0, y: 0, zoom: 1 },
      }

      // ③ 落库 + 直达画布
      const createRes = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: question.trim().slice(0, 60),
          flowData,
        }),
      })
      const createJson = (await createRes.json()) as {
        success: boolean
        data?: { flow: { id: string } }
        error?: string
      }
      if (!createRes.ok || !createJson.success || !createJson.data) {
        throw new Error(createJson.error ?? t('创建失败（HTTP {status}）', { status: createRes.status }))
      }
      const flowId = createJson.data.flow.id
      onClose()
      if (onCreated) onCreated(flowId)
      else router.push(`/workflows/${flowId}/canvas`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      <div className="drawer-backdrop open" onClick={generating ? undefined : onClose} aria-hidden="true" />
      <div className="modal-dialog open" role="dialog" aria-modal="true" aria-label={t('一句话生成工作流')}>
        <div className="modal-head">
          <h2 className="modal-title">{t('一句话生成工作流')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('关闭')}
            onClick={onClose}
            disabled={generating}
          >
            <Icon name="close" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="modal-body">
            <div className="form-section">
              <div className="form-section-label">{t('描述你要的流程')}</div>
              <div className="field">
                <textarea
                  className="textarea"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t('例如：claude a 做需求规划，claude b 做开发，最后审查')}
                  rows={3}
                  maxLength={500}
                  autoFocus
                  disabled={generating}
                />
              </div>
            </div>
            <div className="modal-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)', padding: 'var(--space-2) 0' }}>
              {generating
                ? t('生成中（CLI 实跑可能需要 1-3 分钟）…')
                : t('生成后自动进入画布，可继续编辑节点与连线。')}
            </div>
            {error ? <div className="modal-error">{error}</div> : null}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={generating}>
              {t('取消')}
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canSubmit}>
              {generating ? t('生成中…') : t('生成并进入画布')}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
