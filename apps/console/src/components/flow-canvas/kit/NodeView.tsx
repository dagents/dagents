/**
 * 通用节点卡 —— 左入右出句柄、图标、标题、运行徽章。
 * 出句柄 id = 注册表 outputs 名（true/false、iteration/result…），
 * 即边上的 sourceHandle —— 分支路由的执行语义。
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { useI18n } from '@/i18n'
import { INPUT_HANDLE_ID, type FlowNodeData } from '../model/flow-document'
import { NodeIcon } from '../registry/icons'
import { getSpec } from '../registry/node-spec'
import { useFlowDocActions } from '../use-flow-doc'
import { useRunState } from './run-state'

export const FlowNodeView = memo(function FlowNodeView({ id, data, selected }: NodeProps) {
  const { t } = useI18n()
  const nodeData = data as FlowNodeData
  const spec = getSpec(nodeData.name)
  const anchors = spec?.outputs ?? [{ id: 'output', label: 'Output' }]
  const { nodeStates } = useRunState()
  const { duplicateNode, deleteNode, openInspector, writable } = useFlowDocActions()
  const run = nodeStates[id]

  return (
    <div
      className={`fc-node${selected ? ' is-selected' : ''}${run ? ` run-${run.status}` : ''}${
        spec ? '' : ' is-unknown'
      }`}
    >
      <Handle id={INPUT_HANDLE_ID} type="target" position={Position.Left} className="fc-handle" />
      <div className="fc-node-head">
        <span className="fc-node-icon" style={spec ? { color: spec.color } : undefined}>
          <NodeIcon icon={spec?.icon ?? 'Code'} size={15} />
        </span>
        <span className="fc-node-label" title={nodeData.label}>
          {nodeData.label}
        </span>
        {run && (
          <span className={`fc-node-badge badge-${run.status}`} title={run.error ?? undefined}>
            {run.status === 'running' && <span className="fc-spin" aria-label="running" />}
            {run.status === 'done' && '✓'}
            {run.status === 'failed' && '✕'}
            {run.status === 'waiting' && '…'}
          </span>
        )}
      </div>
      {!spec && <div className="fc-node-unknown">{t('未知节点类型：{name}', { name: nodeData.name || '(无 name)' })}</div>}
      {spec?.description && <div className="fc-node-desc">{spec.description}</div>}
      <div className="fc-anchor-rows">
        {anchors.map((a) => (
          <div key={a.id} className="fc-anchor-row">
            {anchors.length > 1 && <span className="fc-anchor-label">{a.label}</span>}
            <Handle id={a.id} type="source" position={Position.Right} className="fc-handle" />
          </div>
        ))}
      </div>
      {selected && writable && (
        <div className="fc-node-toolbar">
          <button type="button" title={t('编辑')} onClick={() => openInspector(id)}>
            ✎
          </button>
          <button type="button" title={t('复制节点')} onClick={() => duplicateNode(id)}>
            ⧉
          </button>
          <button type="button" title={t('删除节点')} className="is-danger" onClick={() => deleteNode(id)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
})
