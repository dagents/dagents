/**
 * 检查器 —— 右侧固定属性面板（D3：替代 vendor 的浮动 EditNodeDialog，
 * 长流程里改参数不用来回开关对话框）。双击节点或选中即展示。
 */

import { useI18n } from '@/i18n'
import type { CanvasDocument, CanvasNode, FlowNodeData } from '../model/flow-document'
import { NodeIcon } from '../registry/icons'
import { getSpec } from '../registry/node-spec'
import { FieldWidget } from './form-engine'

export function InspectorPanel({
  node,
  document: doc,
  onChange,
  onClose,
}: {
  node: CanvasNode
  document: CanvasDocument
  onChange(patch: Record<string, unknown>): void
  onClose(): void
}) {
  const { t } = useI18n()
  if (node.type === 'stickyNote') {
    const note = node.data as { text: string }
    return (
      <aside className="fc-inspector">
        <div className="fc-inspector-head">
          <span className="fc-inspector-title">{t('便签')}</span>
          <button type="button" className="fc-inspector-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="fc-field">
          <label className="fc-field-label">{t('内容')}</label>
          <textarea
            className="fc-textarea"
            rows={8}
            value={note.text}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </div>
      </aside>
    )
  }

  const data = node.data as FlowNodeData
  const spec = getSpec(data.name)

  // 变量清单：{{$start.input}} + 其余流程节点的 {{id.output}}
  const variables = [
    '{{$start.input}}',
    ...doc.nodes
      .filter((n) => n.id !== node.id && n.type === 'flowNode')
      .map((n) => `{{${n.id}.output}}`),
  ]

  return (
    <aside className="fc-inspector">
      <div className="fc-inspector-head">
        {spec && (
          <span className="fc-inspector-title">
            <span className="fc-node-icon" style={{ color: spec.color }}>
              <NodeIcon icon={spec.icon} size={14} />
            </span>
            {spec.label}
          </span>
        )}
        {!spec && <span className="fc-inspector-title">{t('未知节点')}</span>}
        <button type="button" className="fc-inspector-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="fc-field">
        <label className="fc-field-label">{t('节点名称')}</label>
        <input
          className="fc-input"
          type="text"
          value={data.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>
      {spec ? (
        spec.inputs.map((param) => (
          <FieldWidget
            key={param.name}
            param={param}
            value={data[param.name]}
            variables={variables}
            onChange={(value) => onChange({ [param.name]: value })}
          />
        ))
      ) : (
        <div className="fc-inspector-unknown">
          未知节点类型 <code>{data.name || '(空)'}</code> —— 该节点由旧版本创建，
          保留原样可执行；编辑字段请升级或删除后重建。
        </div>
      )}
    </aside>
  )
}
