'use client'

/**
 * FlowRunDialog — 列表页「运行」的输入面板（对齐画布运行输入面板）。
 *
 * 此前列表页运行按钮直接 POST 同步 run 端点 —— HTTP 响应被压住直到整个
 * 工作流跑完（CLI Agent 流程动辄几分钟），期间不跳详情、无进度，用户
 * 感知「点了没反应」（2026-08-29 修复）。现在：点运行先到这里收集输入
 * （作为 `{{$start.input}}` 传入 + 项目目录），提交走 `?async=1` 立即
 * 返回 runId 并打开详情页旁观（进度轮询在 flows-view 的 spans effect）。
 */
import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { type Directory } from '@/lib/directories'
import { useI18n } from '@/i18n'
import '@/styles/dialog.css'

export interface FlowRunDialogProps {
  /** 目标 flow 名（标题展示）。 */
  flowName: string
  directories: Directory[]
  dirId: string
  onDirChange: (id: string) => void
  onCancel: () => void
  /** 提交（输入文本）—— 父组件负责发起异步运行并关闭本对话框。 */
  onSubmit: (input: string) => void
  /** 模板带的运行输入引导（flow start 节点 data.inputHint）——有则替换引擎术语 placeholder。 */
  inputHint?: string
  /** 输入示例（start 节点 data.inputExample）——持久展示，输入后也不消失。 */
  inputExample?: string
}

export function FlowRunDialog({
  flowName,
  directories,
  dirId,
  onDirChange,
  onCancel,
  onSubmit,
  inputHint,
  inputExample,
}: FlowRunDialogProps): React.ReactElement {
  const { t } = useI18n()
  const [input, setInput] = useState('')

  // Escape 关闭（与 CreateFlowDialog 同款）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <>
      <div className="drawer-backdrop open" onClick={onCancel} aria-hidden="true" />
      <div
        className="modal-dialog open"
        role="dialog"
        aria-modal="true"
        aria-label={t('运行输入')}
      >
        <div className="modal-head">
          <h2 className="modal-title">
            {t('运行')} · {flowName}
          </h2>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-section">
            <div className="form-section-label">{t('项目目录')}</div>
            <div className="field">
              <select className="input" value={dirId} onChange={(e) => onDirChange(e.target.value)}>
                {directories.length === 0 ? (
                  <option value="">{t('（无目录 — Agent 在网关目录运行）')}</option>
                ) : null}
                {directories.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name || d.path}
                  </option>
                ))}
              </select>
              <div className="modal-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
                {t('Agent 将在所选项目目录中读写文件、执行命令')}
              </div>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-label">{t('运行输入')}</div>
            <div className="field">
              <textarea
                className="textarea"
                rows={5}
                autoFocus
                value={input}
                placeholder={inputHint ?? t(
                  '输入将作为 {{$start.input}}（等价 {{input}}）传入；节点里可用 {{<节点id>.output}} 或 {{<节点id>.content}} 引用上游产出',
                )}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    onSubmit(input)
                  }
                }}
              />
              {inputExample ? (
                <div className="modal-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)', marginTop: 'var(--space-1)' }}>
                  {t('示例')}：{inputExample}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="modal-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
            ⌘⏎ {t('开始运行')}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              {t('取消')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onSubmit(input)}>
              {t('开始运行')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
