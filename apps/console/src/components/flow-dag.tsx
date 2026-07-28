'use client'

/**
 * React Flow read-only DAG canvas.
 *
 * Renders a flow's nodes + edges from the console `FlowDetailView`. This is a
 * BROWSE canvas, not an editor — nodes are not draggable, edges are
 * not rewireable; the user can pan/zoom and click a node to inspect it.
 *
 * Node status coloring: each node card gets a `.status-<state>` class (the
 * accent strip + dot in shell.css). Edges whose source is running/done AND
 * whose target is running/queued get `.active` (accent stroke), matching the
 * design's "active edge" rule (design/agentflows.html renderFlow).
 *
 * `flowId` is threaded so a re-fetch of the flow remounts the canvas (React
 * Flow keys internal state by node identity; a key on the wrapper ensures a
 * stale graph never lingers when the selected flow changes).
 */

import { useCallback, useMemo } from 'react'
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
  Position,
} from 'reactflow'
import 'reactflow/dist/style.css'
import type { FlowDetailView, FlowNodeView, NodeRunStatus } from '@/lib/flows'
import { DagNode, type DagNodeData } from './dag-node'

const NODE_TYPES = { dag: DagNode }

const STATUS_CN: Record<NodeRunStatus, string> = {
  running: '运行',
  done: '完成',
  failed: '失败',
  queued: '排队',
  paused: '人工暂停',
  idle: '未触发',
}

/** True for statuses that indicate data has flowed along an edge. */
function isFlowing(s: NodeRunStatus): boolean {
  return s === 'running' || s === 'done'
}

interface FlowDagProps {
  flow: FlowDetailView
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

export function FlowDag({ flow, selectedNodeId, onSelectNode }: FlowDagProps): React.ReactElement {
  const statusById = useMemo(() => {
    const m = new Map<string, NodeRunStatus>()
    for (const n of flow.nodes) m.set(n.id, n.status)
    return m
  }, [flow.nodes])

  const nodes: Node<DagNodeData>[] = useMemo(
    () =>
      flow.nodes.map((n) => toFlowNode(n, n.id === selectedNodeId)),
    [flow.nodes, selectedNodeId],
  )

  const edges: Edge[] = useMemo(
    () =>
      flow.edges.map((e) => {
        const src = statusById.get(e.source)
        const tgt = statusById.get(e.target)
        const active = !!src && !!tgt && isFlowing(src) && (tgt === 'running' || tgt === 'queued')
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'smoothstep',
          className: active ? 'active' : '',
          labelStyle: { fontSize: 9, fill: 'var(--meta)', fontFamily: 'var(--font-mono)' },
        }
      }),
    [flow.edges, statusById],
  )

  const onNodeClick = useCallback<NonNullable<NodeMouseHandler>>(
    (_e, node) => onSelectNode(node.id),
    [onSelectNode],
  )

  // Click on empty canvas deselects.
  const onPaneClick = useCallback(() => onSelectNode(null), [onSelectNode])

  return (
    <div className="flow-canvas-stage" key={flow.id}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background gap={20} size={1} color="var(--border-soft)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/** Map a console FlowNodeView to a React Flow node carrying the DagNode data. */
function toFlowNode(n: FlowNodeView, selected: boolean): Node<DagNodeData> {
  return {
    id: n.id,
    type: 'dag',
    position: n.position,
    data: { label: n.label, type: n.type, status: n.status, statusCn: STATUS_CN[n.status] },
    selectable: true,
    selected,
    // Source/target handles on both sides so smoothstep edges route from any
    // direction — the saved flow may not have explicit handle ids.
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }
}
