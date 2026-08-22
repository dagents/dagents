import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { convertToFlowiseFormat, FlowiseCanvas } from './flowise-canvas'
import { ToastProvider } from '@/components/toast'

// Mock @dagents/agentflow so we don't need React Flow / MUI in jsdom.
const mockAgentflow = vi.fn()

vi.mock('@dagents/agentflow', () => ({
  Agentflow: (props: {
    initialFlow: unknown
    onSave: (data: unknown) => Promise<void>
    renderHeader: (p: {
      onSave: () => void
      isDirty: boolean
    }) => React.ReactElement
  }) => {
    mockAgentflow(props)
    const safeSave = () => props.onSave({ nodes: [], edges: [] })
    return props.renderHeader({ onSave: safeSave, isDirty: true })
  },
}))

describe('convertToFlowiseFormat', () => {
  it('synthesizes outputAnchors from node meta', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        {
          id: 'n1',
          type: 'default',
          data: { name: 'conditionAgentflow' },
        },
      ],
      edges: [],
    })
    const node = result.nodes[0] as { data: { outputAnchors: Array<{ id: string; name: string; label: string }> } }
    const ids = node.data.outputAnchors.map((o) => o.id)
    expect(ids).toContain('true')
    expect(ids).toContain('false')
  })

  it('falls back to a default output anchor when meta has no outputs', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        {
          id: 'n1',
          type: 'default',
          data: { name: 'stickyNote' },
        },
      ],
      edges: [],
    })
    const node = result.nodes[0] as { data: { outputAnchors: Array<{ id: string; name: string; label: string }> } }
    expect(node.data.outputAnchors).toHaveLength(1)
    expect(node.data.outputAnchors[0]).toMatchObject({ id: 'output', name: 'output', label: 'Output' })
  })

  it('derives node label from meta when legacy data has only name (not all-Start)', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        { id: 'start', type: 'customNode', data: { name: 'startAgentflow', variables: {} } },
        { id: 'llm_1', type: 'customNode', data: { name: 'llmAgentflow', model: 'glm-5.2' } },
        { id: 'reply', type: 'customNode', data: { name: 'directReplyAgentflow', text: '' } },
      ],
      edges: [],
    })
    const labels = result.nodes.map((n) => (n as { data: { label: string } }).data.label)
    expect(labels).toEqual(['Start', 'LLM', 'Direct Reply'])
  })

  it('completes missing edge handles per handle-id conventions', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        { id: 'start', type: 'customNode', data: { name: 'startAgentflow' } },
        { id: 'llm_1', type: 'customNode', data: { name: 'llmAgentflow' } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'llm_1' }],
    })
    const edge = result.edges[0] as { sourceHandle?: string; targetHandle?: string }
    // source handle = 源节点第一个输出锚点 id；target handle = 目标节点自身 id
    expect(edge.sourceHandle).toBe('output')
    expect(edge.targetHandle).toBe('llm_1')
  })

  it('keeps explicit edge handles when present', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        { id: 'c1', type: 'customNode', data: { name: 'conditionAgentflow' } },
        { id: 'n2', type: 'customNode', data: { name: 'llmAgentflow' } },
      ],
      edges: [{ id: 'e1', source: 'c1', sourceHandle: 'false', target: 'n2', targetHandle: 'n2' }],
    })
    const edge = result.edges[0] as { sourceHandle?: string; targetHandle?: string }
    expect(edge.sourceHandle).toBe('false')
    expect(edge.targetHandle).toBe('n2')
  })

  it('normalizes node types to agentflowNode except special types', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        { id: 'n1', type: 'default', data: { name: 'startAgentflow' } },
        { id: 'n2', type: 'stickyNote', data: { name: 'stickyNote' } },
        { id: 'n3', type: 'iteration', data: { name: 'iterationAgentflow' } },
        { id: 'n4', type: 'agentflowNode', data: { name: 'agentAgentflow' } },
      ],
      edges: [],
    })
    const types = result.nodes.map((n) => (n as { type: string }).type)
    expect(types).toEqual(['agentflowNode', 'stickyNote', 'iteration', 'agentflowNode'])
  })

  it('defaults viewport when missing', () => {
    const result = convertToFlowiseFormat({ nodes: [], edges: [] })
    expect(result.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('preserves existing outputAnchors if present', () => {
    const result = convertToFlowiseFormat({
      nodes: [
        {
          id: 'n1',
          data: {
            name: 'directReplyAgentflow',
            outputAnchors: [{ id: 'custom', name: 'custom', label: 'Custom', type: 'string' }],
          },
        },
      ],
      edges: [],
    })
    const node = result.nodes[0] as { data: { outputAnchors: unknown[] } }
    expect(node.data.outputAnchors).toHaveLength(1)
    expect(node.data.outputAnchors[0]).toMatchObject({ id: 'custom' })
  })
})

describe('FlowiseCanvas', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('renders the flow name in the header', () => {
    render(
      <FlowiseCanvas
        flowId='flow-1'
        flowName='Test Flow'
        initialFlow={{ nodes: [], edges: [] }}
      />,
    )
    expect(screen.getByText('Test Flow *')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
  })

  it('transitions save button through saving → saved → idle', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <FlowiseCanvas
        flowId='flow-1'
        flowName='Test Flow'
        initialFlow={{ nodes: [], edges: [] }}
        onSave={onSave}
      />,
    )

    const button = screen.getByRole('button', { name: '保存' })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: '已保存 ✓' })).toBeInTheDocument())

    vi.advanceTimersByTime(2000)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument())

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('transitions save button through saving → error → idle on failure', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <FlowiseCanvas
        flowId='flow-1'
        flowName='Test Flow'
        initialFlow={{ nodes: [], edges: [] }}
        onSave={onSave}
      />,
    )

    const button = screen.getByRole('button', { name: '保存' })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: '保存失败' })).toBeInTheDocument())

    vi.advanceTimersByTime(3000)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument())
  })

  it('uses default fetch save when onSave is not provided', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    render(
      <FlowiseCanvas
        flowId='flow-1'
        flowName='Test Flow'
        initialFlow={{ nodes: [], edges: [] }}
      />,
    )

    const button = screen.getByRole('button', { name: '保存' })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: '已保存 ✓' })).toBeInTheDocument())
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/workflows/flow-1',
      expect.objectContaining({ method: 'PUT' }),
    )

    fetchSpy.mockRestore()
  })
})

// ─── 保存拓扑干跑（docs/product-plan.md 方案 A4）────────────────────────
// 保存前 validateFlowTopology，errors/warnings 通过 toast 反馈且不阻断保存。
// 这里不走 header 按钮绕道（mock 里 onSave 被硬编码喂空图），直接从 mock
// 收集到的 props 里调 onSave，喂入构造的 flowData 验证 toast 分支。
// 不用 fake timers —— toast 的自动消失计时器用真实时间即可。
describe('FlowiseCanvas topology dry-run', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  /** 渲染后取 mock Agentflow 收到的 onSave 回调。 */
  function renderAndGetSave(): (data: unknown) => Promise<void> {
    render(
      <ToastProvider>
        <FlowiseCanvas
          flowId='flow-1'
          flowName='Test Flow'
          initialFlow={{ nodes: [], edges: [] }}
          onSave={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>,
    )
    const props = mockAgentflow.mock.calls[0][0] as { onSave: (data: unknown) => Promise<void> }
    return props.onSave
  }

  it('toasts a non-blocking error when the saved flow cannot run', async () => {
    const onSave = renderAndGetSave()

    // 无 startAgentflow + 边悬空 → errors
    await onSave({
      nodes: [
        { id: 'n1', type: 'agentflowNode', data: { name: 'llmAgentflow' } },
        { id: 'n2', type: 'agentflowNode', data: { name: 'llmAgentflow' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'missing' }],
    })

    expect(
      await screen.findByText(/已保存，但该流程当前无法运行/),
    ).toBeInTheDocument()
    // 错误详情（前 3 条）也随 toast 展示
    expect(screen.getByText(/flow has no startAgentflow node/)).toBeInTheDocument()
  })

  it('toasts a warning (no error) when the flow only has suspicious nodes', async () => {
    const onSave = renderAndGetSave()

    // platformAgent 无 agentId → warning；结构本身可执行
    await onSave({
      nodes: [
        { id: 'start', type: 'agentflowNode', data: { name: 'startAgentflow' } },
        { id: 'pa', type: 'agentflowNode', data: { name: 'platformAgentAgentflow', inputs: {} } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'pa' }],
    })

    expect(await screen.findByText(/已保存，流程有可疑之处/)).toBeInTheDocument()
    expect(screen.getByText(/platform agent node "pa" has no agentId/)).toBeInTheDocument()
    expect(screen.queryByText(/已保存，但该流程当前无法运行/)).not.toBeInTheDocument()
  })

  it('stays quiet on a clean flow — save button feedback is enough', async () => {
    const onSave = renderAndGetSave()

    await onSave({
      nodes: [
        { id: 'start', type: 'agentflowNode', data: { name: 'startAgentflow' } },
        { id: 'llm', type: 'agentflowNode', data: { name: 'llmAgentflow' } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'llm' }],
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '已保存 ✓' })).toBeInTheDocument())
    expect(screen.queryByText(/已保存，/)).not.toBeInTheDocument()
  })
})
