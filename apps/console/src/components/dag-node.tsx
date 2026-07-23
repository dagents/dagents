'use client'

/**
 * React Flow node card for the AgentFlows DAG (P1.10.T5).
 *
 * A presentational node body styled by `.dag-node .status-<state>` in
 * shell.css: a left accent strip + a status dot, with the node label and type.
 * The status strip/dot color is driven entirely by the `status` CSS class —
 * the design's status palette (running=accent, done=success, …) is in
 * `tokens.css` / `shell.css`.
 *
 * React Flow renders handles separately; this component only owns the card body.
 */

import { memo } from 'react'
import { Handle, Position } from 'reactflow'
import type { NodeRunStatus } from '@/lib/flows'

export interface DagNodeData {
  label: string
  type: string
  status: NodeRunStatus
  statusCn: string
}

function DagNodeComponent({ data, selected }: { data: DagNodeData; selected?: boolean }): React.ReactElement {
  const { label, type, status, statusCn } = data
  return (
    <div className={`dag-node status-${status}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="dag-node-label">{label}</div>
      <div className="dag-node-sub">
        {type} · {statusCn}
      </div>
      <span className="dag-node-dot" aria-hidden="true" />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

export const DagNode = memo(DagNodeComponent)
