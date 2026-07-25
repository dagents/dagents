import { describe, it, expectTypeOf } from 'vitest'
import type { INode, INodeData, INodeOutput, INodeParams } from '../types/node.js'
import type { FlowNode, FlowEdge, FlowData } from '../types/flow.js'
import type { ExecutionStatus, IExecutedNode, IExecutionContext } from '../types/execution.js'
import type { IServerSideEventStreamer, StreamEvent } from '../types/stream.js'

describe('type contracts', () => {
  it('INode has required fields', () => {
    expectTypeOf<INode>().toMatchTypeOf<{
      label: string
      name: string
      version: number
      type: string
      category: string
      inputs: INodeParams[]
      run: (nodeData: INodeData, input: unknown, options: IExecutionContext) => Promise<INodeOutput>
    }>()
  })

  it('INodeOutput carries id, name, input, output, state', () => {
    expectTypeOf<INodeOutput>().toMatchTypeOf<{
      id: string
      name: string
      input: Record<string, unknown>
      output: Record<string, unknown>
      state?: Record<string, unknown>
    }>()
  })

  it('FlowData has nodes and edges', () => {
    expectTypeOf<FlowData>().toMatchTypeOf<{ nodes: FlowNode[]; edges: FlowEdge[] }>()
  })

  it('FlowEdge has source, target, sourceHandle, targetHandle', () => {
    expectTypeOf<FlowEdge>().toMatchTypeOf<{
      id: string
      source: string
      target: string
      sourceHandle?: string | null
      targetHandle?: string | null
    }>()
  })

  it('ExecutionStatus is the union', () => {
    expectTypeOf<ExecutionStatus>().toEqualTypeOf<'idle' | 'running' | 'success' | 'failed' | 'cancelled'>()
  })

  it('IServerSideEventStreamer has streamTokenEvent and streamEndEvent', () => {
    expectTypeOf<IServerSideEventStreamer>().toMatchTypeOf<{
      streamTokenEvent: (chatId: string, token: string) => void
      streamEndEvent: (chatId: string) => void
      streamErrorEvent: (chatId: string, error: string) => void
    }>()
  })
})
