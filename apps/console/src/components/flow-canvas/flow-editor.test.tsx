import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FlowEditor, type FlowEditorHandle, type HeaderSlotProps } from './flow-editor'
import { NODE_SPECS } from './registry/node-spec'

/* React Flow v12 在 jsdom 里需要的两个浏览器 API（无头环境只做 DOM 断言，
   不做布局数学）。 */
class DOMMatrixReadOnlyPolyfill {
  m22: number
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1]
    this.m22 = scale !== undefined ? +scale : 1
  }
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyPolyfill
}

/** 生成器形状的样本 flow（扁平 customNode）。 */
const generatedFlow = {
  nodes: [
    { id: 'n1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
    { id: 'n2', type: 'customNode', position: { x: 300, y: 0 }, data: { name: 'llmAgentflow', label: '总结一下', model: 'p::m', prompt: 'hi' } },
    { id: 'n3', type: 'customNode', position: { x: 600, y: 0 }, data: { name: 'directReplyAgentflow', text: 'ok' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3' },
  ],
}

describe('FlowEditor', () => {
  it('渲染存量 flow 的节点（normalize → NodeView），含 label 解析', async () => {
    render(<FlowEditor initialFlow={generatedFlow} />)
    expect(await screen.findByText('总结一下')).toBeInTheDocument()
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getByText('Direct Reply')).toBeInTheDocument()
  })

  it('condition 节点渲染双分支锚点标签（True/False = sourceHandle 执行语义）', async () => {
    render(
      <FlowEditor
        initialFlow={{
          nodes: [
            { id: 'c1', type: 'agentflowNode', position: { x: 0, y: 0 }, data: { name: 'conditionAgentflow', inputs: { conditions: [] } } },
          ],
          edges: [],
        }}
      />,
    )
    expect(await screen.findByText('True')).toBeInTheDocument()
    expect(screen.getByText('False')).toBeInTheDocument()
  })

  it('vendor 形状读入：嵌套 inputs 覆盖扁平，targetHandle=<nodeId> 约定被无视', async () => {
    render(
      <FlowEditor
        initialFlow={{
          nodes: [
            {
              id: 'v1',
              type: 'agentflowNode',
              position: { x: 0, y: 0 },
              data: { name: 'startAgentflow', inputs: { variables: { a: 1 } }, outputAnchors: [{ id: 'output' }], version: 1 },
            },
            { id: 'v2', type: 'agentflowNode', position: { x: 300, y: 0 }, data: { name: 'directReplyAgentflow' } },
          ],
          edges: [{ id: 've1', source: 'v1', sourceHandle: 'output', target: 'v2', targetHandle: 'v2' }],
        }}
      />,
    )
    // 两个节点都渲染（边 DOM 断言在 jsdom 不可靠 —— RF 依赖节点实测尺寸，
    // noop ResizeObserver 下边不挂载；边的形状契约由 model/normalize 测试钉）
    expect(await screen.findByText('Start')).toBeInTheDocument()
    expect(screen.getByText('Direct Reply')).toBeInTheDocument()
  })

  it('未知节点渲染占位卡（不崩、显示类型名）', async () => {
    render(
      <FlowEditor
        initialFlow={{
          nodes: [{ id: 'u1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'loopAgentflow' } }],
          edges: [],
        }}
      />,
    )
    expect(await screen.findByText(/loopAgentflow/)).toBeInTheDocument()
  })

  it('header 插槽收到 isDirty；空画布自动补 Start', async () => {
    const seen: HeaderSlotProps[] = []
    render(
      <FlowEditor
        initialFlow={{ nodes: [], edges: [] }}
        header={(p) => {
          seen.push(p)
          return <div data-testid="hdr">header</div>
        }}
      />,
    )
    await screen.findByTestId('hdr')
    expect(seen.at(-1)?.isDirty).toBe(false)
    // 自动 seed
    await waitFor(() => expect(screen.getByText('Start')).toBeInTheDocument())
  })

  it('节点面板：FAB 展开后按 D8 保留集 9 类渲染', async () => {
    render(<FlowEditor initialFlow={generatedFlow} />)
    const fab = document.querySelector('.fc-palette-fab') as HTMLButtonElement
    expect(fab).toBeTruthy()
    fireEvent.click(fab)
    const count = document.querySelectorAll('.fc-palette-item').length
    // 9 类引擎节点 + 画布便签
    expect(count).toBe(NODE_SPECS.length + 1)
    expect(count).toBe(10)
  })

  it('readOnly：无节点面板 FAB、无检查器', () => {
    render(<FlowEditor initialFlow={generatedFlow} readOnly />)
    expect(document.querySelector('.fc-palette-fab')).toBeNull()
  })

  it('命令式 handle：getDocument 返回扁平规范形；applyRunStates 点亮节点徽章', async () => {
    let handle: FlowEditorHandle | null = null
    render(
      <FlowEditor
        ref={(h) => {
          handle = h
        }}
        initialFlow={generatedFlow}
      />,
    )
    await screen.findByText('总结一下')
    const doc = handle!.getDocument()
    expect(doc.nodes.map((n) => n.type)).toEqual(['customNode', 'customNode', 'customNode'])
    expect(doc.nodes[1]!.data).toMatchObject({ name: 'llmAgentflow', label: '总结一下', model: 'p::m' })
    // 规范形不带 vendor 杂项键
    expect('outputAnchors' in (doc.nodes[0]!.data as object)).toBe(false)
    // 边写出不带 targetHandle
    expect(doc.edges[0]).toMatchObject({ id: 'e1', source: 'n1', target: 'n2' })
    expect('targetHandle' in doc.edges[0]!).toBe(false)

    handle!.applyRunStates({ n2: { status: 'running' } })
    await waitFor(() => expect(document.querySelector('.fc-node-badge.badge-running')).toBeInTheDocument())
    handle!.applyRunStates({ n2: { status: 'done' } })
    await waitFor(() => expect(document.querySelector('.fc-node-badge.badge-done')).toBeInTheDocument())
    handle!.clearRunState()
    await waitFor(() => expect(document.querySelector('.fc-node-badge')).toBeNull())
  })

  it('单击只选中（工具条），双击/工具条✎才开检查器（D3：拖动不弹面板）', async () => {
    const onSaveRequest = vi.fn()
    render(<FlowEditor initialFlow={generatedFlow} onSaveRequest={onSaveRequest} />)
    await screen.findByText('总结一下')

    // 单击 → 选中态 + 工具条（复制/删除），检查器不出现
    fireEvent.click(screen.getByText('总结一下'))
    await waitFor(() => expect(document.querySelector('.fc-node.is-selected')).toBeInTheDocument())
    expect(document.querySelector('.fc-node-toolbar')).toBeInTheDocument()
    expect(document.querySelector('.fc-inspector')).toBeNull()

    // 双击 → 检查器打开，表单引擎渲染注册表字段（Model 下拉 + Prompt 文本域）
    fireEvent.doubleClick(screen.getByText('总结一下'))
    await waitFor(() => expect(document.querySelector('.fc-inspector')).toBeInTheDocument())
    expect(document.querySelector('.fc-select')).toBeTruthy()
    expect(screen.getByText('Prompt')).toBeInTheDocument()

    // 关闭检查器 → 工具条✎ 重新打开
    document.querySelector('.fc-inspector-close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => expect(document.querySelector('.fc-inspector')).toBeNull())
    const editBtn = document.querySelector('.fc-node-toolbar button')!
    fireEvent.click(editBtn)
    await waitFor(() => expect(document.querySelector('.fc-inspector')).toBeInTheDocument())

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
  })
})
