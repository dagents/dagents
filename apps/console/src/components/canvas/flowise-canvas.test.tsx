import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { convertToFlowiseFormat, FlowiseCanvas } from './flowise-canvas'

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
