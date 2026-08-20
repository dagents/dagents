'use client'

/**
 * CanvasTopBar — 画布页顶部操作条（client）。
 *
 * vendor 画布（FlowiseCanvasLoader）不动，本条在其上方提供流程名 +
 * 「另存为模板」入口（SaveFlowTemplateDialog）。page.tsx 以 flex 列布局
 * 组合：topbar（固定高）+ 画布（flex:1）。
 */
import { useState } from 'react'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import { SaveFlowTemplateDialog } from '@/components/save-flow-template-dialog'
import '@/styles/flow-templates.css'

export interface CanvasTopBarProps {
  flowId: string
  flowName: string
}

export function CanvasTopBar({ flowId, flowName }: CanvasTopBarProps): React.ReactElement {
  const { t } = useI18n()
  const [saveOpen, setSaveOpen] = useState(false)

  return (
    <>
      <div className="ftpl-canvas-topbar">
        <span className="ftpl-flow-name" title={flowName}>{flowName}</span>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setSaveOpen(true)}
        >
          <Icon name="copy" style={{ width: 14, height: 14 }} />
          {t('另存为模板')}
        </button>
      </div>
      <SaveFlowTemplateDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        flowId={flowId}
        flowName={flowName}
      />
    </>
  )
}
