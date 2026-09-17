'use client'

/**
 * HumanInputAnswerFields — 运行面板的「人工节点预供答案」区（2026-09-18）。
 *
 * FlowRunDialog（列表页）与画布运行输入面板共用：把「含 HumanInput 的流程
 * 在画布/列表必失败」变成「运行前按节点补答案即可跑通」。键控与边界见
 * lib/flow-human-inputs.ts 顶注。
 */
import { useI18n } from '@/i18n'
import type { HumanInputSpec } from '@/lib/flow-human-inputs'

export interface HumanInputAnswerFieldsProps {
  specs: HumanInputSpec[]
  answers: Record<string, string>
  onAnswer: (nodeId: string, value: string) => void
}

export function HumanInputAnswerFields({ specs, answers, onAnswer }: HumanInputAnswerFieldsProps): React.ReactElement | null {
  const { t } = useI18n()
  // 无 prompt 的节点没法键控（引擎按 resolved prompt 取答案）——只提示存在
  const answerable = specs.filter((s) => s.prompt && !s.hasTemplate)
  const unanswerable = specs.filter((s) => !s.prompt || s.hasTemplate)
  if (specs.length === 0) return null

  return (
    <div className="form-section">
      <div className="form-section-label">
        {t('人工确认节点')}（{specs.length}）
      </div>
      {answerable.map((spec) => (
        <div className="field" key={spec.nodeId}>
          {spec.options && spec.options.length > 0 ? (
            <select
              className="input"
              value={answers[spec.nodeId] ?? ''}
              onChange={(e) => onAnswer(spec.nodeId, e.target.value)}
              aria-label={spec.prompt}
            >
              <option value="">{t('（待选择）')}</option>
              {spec.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type="text"
              value={answers[spec.nodeId] ?? ''}
              placeholder={spec.prompt}
              aria-label={spec.prompt}
              onChange={(e) => onAnswer(spec.nodeId, e.target.value)}
            />
          )}
          <div className="modal-hint hint-xs">
            {spec.prompt}
          </div>
        </div>
      ))}
      {unanswerable.length > 0 ? (
        <div className="modal-hint hint-xs hint-warn">
          {t('另有 {n} 个提示含模板变量或为空 —— 其答案需走聊天运行路径', { n: String(unanswerable.length) })}
        </div>
      ) : null}
    </div>
  )
}
