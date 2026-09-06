/**
 * 便签节点 —— 顶部拖拽条 + 内联 textarea。
 * 便签不参与连线；只有便签会把手调尺寸持久化（serializeDocument 特判）。
 * textarea 的 pointerdown 阻断冒泡（否则拖选文本会拖走便签），代价是
 * 文本区拖不动便签 —— 所以必须有独立的拖拽区（顶部条，不阻断冒泡，
 * 由 RF 节点 wrapper 接管拖动）。
 */

import { NodeResizer, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { useI18n } from '@/i18n'
import { useFlowDocActions } from '../use-flow-doc'
import type { StickyNoteData } from '../model/flow-document'

export const StickyNoteView = memo(function StickyNoteView({ id, data, selected }: NodeProps) {
  const { updateNodeData, writable } = useFlowDocActions()
  const { t } = useI18n()
  const note = data as StickyNoteData
  return (
    <div className={`fc-sticky${selected ? ' is-selected' : ''}`}>
      <NodeResizer isVisible={selected && writable} minWidth={140} minHeight={80} lineClassName="fc-resizer-line" handleClassName="fc-resizer-handle" />
      <div className="fc-sticky-drag" title={t('拖动便签')} aria-hidden="true" />
      <textarea
        className="fc-sticky-text"
        value={note.text}
        placeholder={t('便签…')}
        readOnly={!writable}
        onChange={(e) => updateNodeData(id, { text: e.target.value })}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  )
})
