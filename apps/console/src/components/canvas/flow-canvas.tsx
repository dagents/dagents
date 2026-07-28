'use client'

import { useCallback, useRef, useState, useMemo } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  type NodeTypes,
  BackgroundVariant,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { getNodeMeta } from '@dagents/workflow'
import { CustomNode } from './custom-node'
import { NodePalette } from './node-palette'
import { NodeInspector } from './node-inspector'
import { CanvasToolbar } from './canvas-toolbar'
import type { FlowNodeData, CanvasProps } from './types'

const nodeTypes: NodeTypes = {
  agentFlow: CustomNode,
}

let nodeIdCounter = 0

function generateId(): string {
  nodeIdCounter += 1
  return `node_${Date.now()}_${nodeIdCounter}`
}

export function FlowCanvas({
  flowId,
  initialData,
  onSave,
  onRun,
  readOnly = false,
}: CanvasProps): React.ReactElement {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [flowName, setFlowName] = useState(`工作流 ${flowId.slice(0, 8)}`)

  const initialNodes = useMemo<Node<FlowNodeData>[]>(() => {
    if (initialData.nodes && initialData.nodes.length > 0) {
      return initialData.nodes.map((node: any) => ({
        id: node.id,
        type: node.type || 'agentFlow',
        position: node.position || { x: 0, y: 0 },
        data: {
          name: node.data?.name || node.name || 'startAgentflow',
          label: node.data?.label || node.label || 'Start',
          status: 'idle' as const,
          ...node.data,
        },
      }))
    }
    return [
      {
        id: 'start_1',
        type: 'agentFlow',
        position: { x: 120, y: 160 },
        data: {
          name: 'startAgentflow',
          label: 'Start',
          variables: {},
          status: 'idle' as const,
        },
      },
    ]
  }, [initialData.nodes])

  const initialEdges = useMemo<Edge[]>(() => {
    if (initialData.edges && initialData.edges.length > 0) {
      return initialData.edges.map((edge: any) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: edge.type || 'smoothstep',
        animated: edge.animated ?? false,
        style: {
          stroke: 'var(--border)',
          strokeWidth: 1.5,
        },
      }))
    }
    return []
  }, [initialData.edges])

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const selectedNode = useMemo(
    () => (selectedNodeId ? (nodes.find((n) => n.id === selectedNodeId) as Node<FlowNodeData> | undefined) ?? null : null),
    [nodes, selectedNodeId],
  )

  const onConnect = useCallback(
    (params: Connection) => {
      if (readOnly) return
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: 'smoothstep',
            style: { stroke: 'var(--border)', strokeWidth: 1.5 },
          },
          eds,
        ),
      )
    },
    [setEdges, readOnly],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      if (readOnly) return

      const type = event.dataTransfer.getData('application/reactflow/type')
      const dataStr = event.dataTransfer.getData('application/reactflow/data')

      if (!type || !dataStr || !reactFlowWrapper.current || !reactFlowInstance) {
        return
      }

      const bounds = reactFlowWrapper.current.getBoundingClientRect()
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      })

      const nodeData = JSON.parse(dataStr)
      const newNode: Node<FlowNodeData> = {
        id: generateId(),
        type: 'agentFlow',
        position,
        data: nodeData,
      }

      setNodes((nds) => nds.concat(newNode))
    },
    [reactFlowInstance, setNodes, readOnly],
  )

  const handleUpdateNode = useCallback(
    (nodeId: string, data: Partial<FlowNodeData>) => {
      if (readOnly) return
      setNodes((nds) =>
        nds.map((node) => {
          if (node.id === nodeId) {
            return {
              ...node,
              data: {
                ...node.data,
                ...data,
              },
            }
          }
          return node
        }),
      )
    },
    [setNodes, readOnly],
  )

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      if (readOnly) return
      setNodes((nds) => nds.filter((node) => node.id !== nodeId))
      setEdges((eds) => eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
      setSelectedNodeId(null)
    },
    [setNodes, setEdges, readOnly],
  )

  const handleSave = useCallback(async () => {
    if (!onSave || !reactFlowInstance) return

    setIsSaving(true)
    try {
      const viewport = reactFlowInstance.getViewport()
      await onSave({
        nodes,
        edges,
        viewport,
      })
    } finally {
      setIsSaving(false)
    }
  }, [onSave, nodes, edges, reactFlowInstance])

  const handleRun = useCallback(() => {
    if (!onRun) return
    setIsRunning(true)
    onRun()
    setTimeout(() => setIsRunning(false), 1000)
  }, [onRun])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--bg)',
        minWidth: 0,
      }}
    >
      <CanvasToolbar
        flowName={flowName}
        onSave={handleSave}
        onRun={handleRun}
        isSaving={isSaving}
        isRunning={isRunning}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {!readOnly && <NodePalette />}

        <div ref={reactFlowWrapper} style={{ flex: 1, position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            elementsSelectable={!readOnly}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border-soft)" />
            <Controls showInteractive={false} style={{ borderRadius: 6, border: '1px solid var(--border-soft)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }} />
            <MiniMap
              pannable
              zoomable
              style={{
                backgroundColor: 'var(--surface-warm)',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}
              nodeColor={(node) => {
                const name = (node.data as FlowNodeData)?.name
                const meta = name ? getNodeMeta(name) : undefined
                return meta?.color ?? 'var(--accent)'
              }}
              nodeStrokeWidth={2}
              nodeStrokeColor="var(--bg)"
              maskColor="rgba(0, 0, 0, 0.08)"
            />
          </ReactFlow>
        </div>

        <NodeInspector
          selectedNode={selectedNode}
          onUpdateNode={handleUpdateNode}
          onDeleteNode={handleDeleteNode}
        />
      </div>
    </div>
  )
}
