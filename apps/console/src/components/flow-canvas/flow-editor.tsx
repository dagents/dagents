/**
 * FlowEditor —— 自研画布组合根（替换 vendor <Agentflow> 的唯一宿主组件）。
 *
 * 职责：
 *  - 文档状态所有权（nodes/edges/dirty），读写经 model/normalize 与持久化契约对齐
 *  - 交互：连线合法化（connection-rules）、palette 拖放/点击、键盘（Del 删除、
 *    Cmd/Ctrl+S 触发保存请求）、节点复制
 *  - 命令式 ref（FlowEditorHandle）：保存方取规范形文档、运行方注入徽章/边状态
 *  - 插槽：header（console 工具栏）、inspector（右侧属性面板）
 *
 * 不做：保存网络请求、运行轮询 —— 分别由页面客户端与 run/ 模块持有。
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
// RF 基础样式（节点绝对定位/handle/edge 基类）—— 缺了它节点按块级布局
// 摊满容器、边层量不出坐标（vendor 时代 flowise.css 承担的同位职责）。
import '@xyflow/react/dist/style.css'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { FlowData } from '@dagents/workflow'
import { FlowEdgeView } from './kit/EdgeView'
import { FlowNodeView } from './kit/NodeView'
import { StickyNoteView } from './kit/StickyNoteView'
import { EMPTY_RUN_STATE, RunStateProvider, type NodeRunStatus, type RunState } from './kit/run-state'
import { INPUT_HANDLE_ID, type CanvasDocument, type FlowNodeData, type StickyNoteData } from './model/flow-document'
import { normalizeDocument, serializeDocument } from './model/normalize'
import { getSpec, type NodeSpec } from './registry/node-spec'
import { connectionAllowed } from './kit/connection-rules'
import { PALETTE_DND_TYPE, Palette } from './palette/Palette'
import { InspectorPanel } from './inspector/InspectorPanel'
import { FlowDocActionsProvider } from './use-flow-doc'

export type FlowRFNode = Node<FlowNodeData, 'flowNode'> | Node<StickyNoteData, 'stickyNote'>

export interface FlowEditorHandle {
  getDocument(): FlowData
  isDirty(): boolean
  markSaved(): void
  fitView(): void
  /** 注入节点运行态；边状态（完成段/活动段）由 FlowEditor 按自有连线派生。 */
  applyRunStates(nodeStates: Record<string, { status: NodeRunStatus; error?: string }>): void
  clearRunState(): void
}

export interface HeaderSlotProps {
  isDirty: boolean
  /** 与 Cmd/Ctrl+S 同一条保存请求管线。 */
  requestSave(): void
}

/** 布局自动保存载荷（2026-09-06）：只含坐标与视口，服务端 merge。 */
export interface FlowLayoutPayload {
  positions: Record<string, { x: number; y: number }>
  viewport: { x: number; y: number; zoom: number }
}

export interface FlowEditorProps {
  initialFlow: unknown
  readOnly?: boolean
  onSaveRequest?(): void
  /** 布局自动保存（拖拽停/视口停后 debounce 触发）。静默 fire-and-forget ——
   *  不翻脏标记、不动保存状态（配置编辑仍走显式保存管线）。 */
  onLayoutPersist?(layout: FlowLayoutPayload): void
  header?(props: HeaderSlotProps): React.ReactNode
  /** 外部受控选中（如画布旁观跳转）暂不需要，选中纯内部态。 */
}

const nodeTypes = { flowNode: FlowNodeView, stickyNote: StickyNoteView }
const edgeTypes = { flowEdge: FlowEdgeView }

export const FlowEditor = forwardRef<FlowEditorHandle, FlowEditorProps>(function FlowEditor(
  { initialFlow, readOnly = false, onSaveRequest, onLayoutPersist, header },
  ref,
) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner ref={ref} initialFlow={initialFlow} readOnly={readOnly} onSaveRequest={onSaveRequest} onLayoutPersist={onLayoutPersist} header={header} />
    </ReactFlowProvider>
  )
})

const FlowEditorInner = forwardRef<FlowEditorHandle, FlowEditorProps>(function FlowEditorInner(
  { initialFlow, readOnly = false, onSaveRequest, onLayoutPersist, header },
  ref,
) {
  const initialDoc = useMemo<CanvasDocument>(() => normalizeDocument(initialFlow), [initialFlow])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowRFNode>(initialDoc.nodes as FlowRFNode[])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialDoc.edges as Edge[])
  const [dirty, setDirty] = useState(false)
  const [nodeRunStates, setNodeRunStates] = useState<RunState['nodeStates']>({})
  /** 选中（工具条/删除跟随），单击即选。 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 检查器目标：双击节点或工具条「编辑」打开（D3 —— 单击只选中，拖动
   * 节点不会反复弹面板）。 */
  const [inspectorId, setInspectorId] = useState<string | null>(null)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const seeded = useRef(false)

  // viewport 由 RF onMove 持续写 ref（不触发重渲染）
  const viewportRef = useRef<{ x: number; y: number; zoom: number } | undefined>(initialDoc.viewport)

  // ── 布局自动保存（2026-09-06）：拖拽/视口停后 debounce 静默提交 ──
  // 只发 positions+viewport（服务端 merge），不翻脏标记 —— 用户未保存的
  // 配置编辑仍是草稿；布局是纯视觉调整，刷新即回退的体验不可接受。
  // 声明必须在 handleNodesChange 之前（其依赖数组引用本回调）。
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const layoutTimerRef = useRef<number | undefined>(undefined)
  const scheduleLayoutPersist = useCallback(() => {
    if (readOnly || !onLayoutPersist) return
    window.clearTimeout(layoutTimerRef.current)
    layoutTimerRef.current = window.setTimeout(() => {
      const vp = viewportRef.current
      if (!vp) return
      const positions: Record<string, { x: number; y: number }> = {}
      for (const n of nodesRef.current) {
        positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
      }
      onLayoutPersist({ positions, viewport: vp })
    }, 800)
  }, [readOnly, onLayoutPersist])
  useEffect(() => () => window.clearTimeout(layoutTimerRef.current), [])

  // 边状态派生（单向数据流）：源+目标都 done → 完成段；源 done + 目标
  // running → 活动段（dash 流动）。取代 vendor 时代借
  // getReactFlowInstance().setEdges() 绕过 React 状态的写法。
  const runState = useMemo<RunState>(() => {
    if (Object.keys(nodeRunStates).length === 0) return EMPTY_RUN_STATE
    const isDone = (id: string): boolean => nodeRunStates[id]?.status === 'done'
    const isRunning = (id: string): boolean => nodeRunStates[id]?.status === 'running'
    const edgeStates: RunState['edgeStates'] = {}
    for (const e of edges) {
      if (isDone(e.source) && isDone(e.target)) edgeStates[e.id] = 'done'
      else if (isDone(e.source) && isRunning(e.target)) edgeStates[e.id] = 'active'
    }
    return { nodeStates: nodeRunStates, edgeStates }
  }, [nodeRunStates, edges])

  // 空画布自动补 Start（vendor 同款行为；seed 不算用户改动，不标脏）
  useEffect(() => {
    if (seeded.current || readOnly) return
    seeded.current = true
    if (nodes.length === 0) {
      addNode('startAgentflow', { x: 80, y: 160 }, { markDirty: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 测量加固：RF 的 NodeRenderer ResizeObserver→updateNodeInternals 回路
  // 在部分环境（IAB webview 实测）不触发 —— 节点永远 visibility:hidden、
  // 边层空。这里在「存在未测量节点」时主动驱动一次 store 测量（与 RO
  // 回调同一入口，幂等；dimensions 变化不计入脏标记，见 handleNodesChange）。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const store = useStoreApi()
  const kickMeasurement = useCallback(() => {
    const root = bodyRef.current
    if (!root) return
    const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: true }>()
    for (const el of Array.from(root.querySelectorAll<HTMLDivElement>('.react-flow__node[data-id]'))) {
      const id = el.getAttribute('data-id')
      if (id) updates.set(id, { id, nodeElement: el, force: true })
    }
    if (updates.size > 0) store.getState().updateNodeInternals(updates)
  }, [store])
  useEffect(() => {
    if (!nodes.some((n) => n.measured == null)) return
    const t = window.setTimeout(kickMeasurement, 60)
    return () => window.clearTimeout(t)
  }, [nodes, kickMeasurement])

  // Cmd/Ctrl+S —— 保存请求走页面客户端管线（拓扑干跑 + PUT）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSaveRequest?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSaveRequest])

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowRFNode>[]) => {
      onNodesChange(changes)
      if (changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add')) {
        setDirty(true)
      }
      // 坐标变更（拖动逐帧，debounce 合并到停手后一拍）触发布局自动保存
      if (changes.some((c) => c.type === 'position')) {
        scheduleLayoutPersist()
      }
      // RF 会把内部 measured 尺寸写回 node；便签的手调尺寸要跟随
    },
    [onNodesChange, scheduleLayoutPersist],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes)
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) {
        setDirty(true)
      }
    },
    [onEdgesChange],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connectionAllowed(edges, connection)) return
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            // id 必须含 sourceHandle：condition 的 true/false 两个句柄可以
            // 各连一条边到同一目标（引擎按 handle 路由），同对边 id 冲突会
            // 炸 React key 与运行态点亮映射。
            id: `${connection.source}-${connection.sourceHandle ?? 'output'}-${connection.target}`,
            targetHandle: INPUT_HANDLE_ID,
            type: 'flowEdge',
          },
          eds,
        ),
      )
      setDirty(true)
    },
    [edges, setEdges],
  )

  /** 新节点 id：`<registryName>_<n>`，n 取同前缀最大序号 +1。 */
  const nextId = (name: string): string => {
    let max = -1
    for (const n of nodes) {
      const m = /^(.*)_(\d+)$/.exec(n.id)
      if (m && m[1] === name) max = Math.max(max, Number(m[2]))
    }
    return `${name}_${max + 1}`
  }

  const addNode = useCallback(
    (specName: string, position: { x: number; y: number }, opts?: { markDirty?: boolean }): string => {
      const spec = getSpec(specName)
      const id = nextId(specName)
      const data: FlowNodeData = spec
        ? { name: specName, label: spec.label, ...structuredClone(spec.defaultData) }
        : { name: specName, label: specName }
      setNodes((ns) => [
        ...ns,
        { id, type: 'flowNode', position, data } as FlowRFNode,
      ])
      if (opts?.markDirty !== false) setDirty(true)
      return id
    },
    // nextId 读 nodes 快照 —— 通过 setNodes 函数式更新内部推导，避免依赖漂移
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, setNodes],
  )

  const addStickyNote = useCallback(
    (position: { x: number; y: number }): string => {
      let max = -1
      for (const n of nodes) {
        const m = /^stickyNote_(\d+)$/.exec(n.id)
        if (m) max = Math.max(max, Number(m[1]))
      }
      const id = `stickyNote_${max + 1}`
      setNodes((ns) => [...ns, { id, type: 'stickyNote', position, data: { text: '' } } as FlowRFNode])
      setDirty(true)
      return id
    },
    // nodes 快照推 id —— 函数式更新内推导
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, setNodes],
  )

  const addFromSpec = useCallback(
    (item: NodeSpec | 'stickyNote') => {
      // 点击添加：视口内交错落点，避免完全重叠
      const n = nodes.length
      const position = { x: 200 + (n % 5) * 60, y: 120 + Math.floor(n / 5) * 80 }
      if (item === 'stickyNote') {
        addStickyNote(position)
        return
      }
      addNode(item.name, position)
    },
    [nodes.length, addNode, addStickyNote],
  )

  const updateNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowRFNode) : n)),
      )
      setDirty(true)
    },
    [setNodes],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id))
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
      setDirty(true)
      if (selectedId === id) setSelectedId(null)
      if (inspectorId === id) setInspectorId(null)
    },
    [setNodes, setEdges, selectedId, inspectorId],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodes.find((n) => n.id === id)
      if (!src || src.type !== 'flowNode') return
      const name = (src.data as FlowNodeData).name
      const newId = nextId(`${name}_copy`)
      setNodes((ns) => [
        ...ns,
        {
          ...structuredClone(src),
          id: newId,
          selected: false,
          position: { x: src.position.x + 48, y: src.position.y + 48 },
        } as FlowRFNode,
      ])
      setDirty(true)
    },
    // nextId 读 nodes 快照（同 addNode）—— 函数式更新内推导，避免依赖漂移
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, setNodes],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const specName = event.dataTransfer.getData(PALETTE_DND_TYPE)
      if (!specName) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      if (specName === 'stickyNote') {
        addStickyNote({ x: position.x - 110, y: position.y - 60 })
        return
      }
      addNode(specName, { x: position.x - 90, y: position.y - 20 })
    },
    [addNode, addStickyNote, screenToFlowPosition],
  )

  useImperativeHandle(
    ref,
    () => ({
      getDocument: () =>
        serializeDocument({
          nodes: nodes as CanvasDocument['nodes'],
          edges: edges as CanvasDocument['edges'],
          viewport: viewportRef.current,
        }),
      isDirty: () => dirty,
      markSaved: () => setDirty(false),
      fitView: () => fitView({ padding: 0.2, duration: 200 }),
      applyRunStates: (next: RunState['nodeStates']) => setNodeRunStates(next),
      clearRunState: () => setNodeRunStates({}),
      // nodes/edges 在 handle 闭包里必须是最新值 —— useImperativeHandle 依赖数组见下
    }),
    [nodes, edges, dirty, fitView],
  )

  const onMoveEnd = useCallback(
    (_e: unknown, vp: { x: number; y: number; zoom: number }) => {
      viewportRef.current = vp
      scheduleLayoutPersist()
    },
    [scheduleLayoutPersist],
  )

  // 选中变化（memoize：RF 文档要求 onChange 稳定引用，否则每渲染反复挂卸
  // handler）。检查器打开的节点被取消选中时同步收起。
  const handleSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: Array<{ id: string }> }) => {
      setSelectedId(selected.length === 1 ? selected[0]!.id : null)
    },
    [],
  )
  useEffect(() => {
    if (selectedId === null) setInspectorId(null)
  }, [selectedId])

  // 双击节点 → 检查器（D3：单击只选中出工具条，拖动不弹面板）
  const handleNodeDoubleClick = useCallback((_e: unknown, node: { id: string }) => {
    setSelectedId(node.id)
    setInspectorId(node.id)
  }, [])

  const selectedNode = selectedId ? (nodes.find((n) => n.id === selectedId) ?? null) : null
  const inspectorNode = inspectorId ? (nodes.find((n) => n.id === inspectorId) ?? null) : null

  const docActions = useMemo(
    () => ({
      updateNodeData,
      duplicateNode,
      deleteNode,
      openInspector: (id: string) => {
        setSelectedId(id)
        setInspectorId(id)
      },
      writable: !readOnly,
    }),
    [updateNodeData, duplicateNode, deleteNode, readOnly],
  )

  const headerNode = header?.({ isDirty: dirty, requestSave: () => onSaveRequest?.() })

  return (
    <div className="fc-root">
      <FlowDocActionsProvider value={docActions}>
        <RunStateProvider value={runState}>
          {headerNode && <div className="fc-header-slot">{headerNode}</div>}
          <div className="fc-body" ref={bodyRef}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultEdgeOptions={{ type: 'flowEdge' }}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={readOnly ? undefined : handleConnect}
              onSelectionChange={handleSelectionChange}
              onNodeDoubleClick={readOnly ? undefined : handleNodeDoubleClick}
              onDrop={readOnly ? undefined : onDrop}
              onDragOver={readOnly ? undefined : ((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }) as React.DragEventHandler}
              onMoveEnd={onMoveEnd}
              // 有持久化视口就原样还原；没有（生成器/新 flow 的绝对坐标可能
              // 在视口外）就 fitView 适配 —— 两者互斥，fitView 时不给 defaultViewport
              defaultViewport={initialDoc.viewport ? initialDoc.viewport : undefined}
              fitView={!initialDoc.viewport}
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              edgesReconnectable={false}
              elementsSelectable
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
              <Controls showInteractive={false} position="bottom-right" />
              <MiniMap pannable zoomable position="bottom-left" />
            </ReactFlow>
            {!readOnly && <Palette onAdd={addFromSpec} />}
            {inspectorNode && !readOnly && (
              <InspectorPanel
                node={inspectorNode as CanvasDocument['nodes'][number]}
                document={{ nodes: nodes as CanvasDocument['nodes'], edges: edges as CanvasDocument['edges'] }}
                onChange={(patch) => updateNodeData(inspectorNode.id, patch)}
                onClose={() => setInspectorId(null)}
              />
            )}
          </div>
        </RunStateProvider>
      </FlowDocActionsProvider>
    </div>
  )
})
