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
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/dialog.css'
// flows.css 提供 PX-F06 增强态（.genflow-prompt/.genflow-engine/.genflow-progress/
// .btn-spinner）；选择器均为 flow 对话框专属类名，无页面级副作用。
import '@/styles/flows.css'

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
  // PX-F06：生成中步骤文案轮换（每 2.6s），等待期对话框内始终有动的东西
  const [stepIdx, setStepIdx] = useState(0)
  const stepTimer = useRef<number>(0)

  const GEN_STEPS = [
    t('正在理解你的描述…'),
    t('正在编排节点与连线…'),
    t('正在做拓扑校验…'),
    t('仍在生成，CLI 实跑可能需要 1-3 分钟…'),
  ] as const

  useEffect(() => {
    if (!open) {
      setQuestion('')
      setError(null)
      setGenerating(false)
      setStepIdx(0)
    }
  }, [open])

  useEffect(() => {
    if (!generating) return
    setStepIdx(0)
    stepTimer.current = window.setInterval(() => {
      setStepIdx((i) => Math.min(i + 1, GEN_STEPS.length - 1))
    }, 2600)
    return () => {
      window.clearInterval(stepTimer.current)
    }
    // GEN_STEPS 由 t() 派生，语言切换才换引用 —— 步进逻辑只依赖 generating
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating])

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
      const vendor = json as VendorFlow & {
        bindings?: { agentNodeCount: number; unboundAgentNodeCount: number; note: string } | null
      }
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
      // FR-13：bindings 写进 flow 描述 —— 列表/画布长期可见「生成的流将以
      // 什么档位跑」，不止 toast 一闪而过。
      const bindingsNote = vendor.bindings
        ? `${vendor.bindings.note}（Agent 节点 ${vendor.bindings.agentNodeCount}，未绑定 ${vendor.bindings.unboundAgentNodeCount}）`
        : ''
      const createRes = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: question.trim().slice(0, 60),
          description: bindingsNote || undefined,
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
                {/* PX-F06：prompt 框是主视觉 —— 大一档字、autofocus、行高放宽 */}
                <textarea
                  className="textarea genflow-prompt"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t('例如：claude a 做需求规划，claude b 做开发，最后审查')}
                  rows={4}
                  maxLength={500}
                  autoFocus
                  disabled={generating}
                />
                {/* 引擎管线说明为次级行（本入口固定 CLI 优先 + 自动兜底，无选择器） */}
                <div className="genflow-engine">
                  <Icon name="bot" style={{ width: 13, height: 13 }} />
                  {t('CLI 优先执行 · 自动拓扑校验 · 失败显式报错')}
                </div>
              </div>
            </div>
            {/* 生成中动态进度（PX-F06）：呼吸点 + 步骤文案轮换，不许死白屏 */}
            {generating ? (
              <div className="genflow-progress" role="status" aria-live="polite">
                <span className="genflow-dot" aria-hidden="true" />
                <span>{GEN_STEPS[stepIdx]}</span>
              </div>
            ) : null}
            {error ? (
              <div className="fdialog-field-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={generating}>
              {t('取消')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {generating ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  {t('生成中…')}
                </>
              ) : (
                t('生成并进入画布')
              )}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
