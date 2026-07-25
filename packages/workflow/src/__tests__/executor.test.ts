import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { RuntimeState } from '../engine/runtime.js'
import { SseStreamer } from '../engine/sse-streamer.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

// Stub node that echoes its input + a configured suffix.
function makeEchoNode(name: string, suffix: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(nodeData: INodeData, input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      return {
        id: nodeData.id,
        name,
        input: { raw: input },
        output: { content: `${inputStr} ${suffix}` },
      }
    },
  }
}

describe('DagExecutor (linear)', () => {
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('executes a single-node graph', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'echoA' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(1)
    expect(result.executedNodes[0].output.content).toBe('hello A')
  })

  it('executes a linear chain A → B → C', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    registry.register(makeEchoNode('echoB', 'B'))
    registry.register(makeEchoNode('echoC', 'C'))
    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'echoA' } },
        { id: 'n2', data: { name: 'echoB' } },
        { id: 'n3', data: { name: 'echoC' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'start', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(3)
    // Each node appends its suffix: start → start A → start A B → start A B C
    expect(result.executedNodes[2].output.content).toBe('start A B C')
  })

  it('returns failed status when a node throws', async () => {
    const failingNode: INode = {
      label: 'Fail',
      name: 'failNode',
      version: 1,
      type: 'Fail',
      category: 'Test',
      color: '#000',
      inputs: [],
      async run() {
        throw new Error('intentional failure')
      },
    }
    registry.register(failingNode)
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'failNode' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('intentional failure')
  })

  it('returns failed status when node type not in registry', async () => {
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'nonexistentNode' } }],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('nonexistentNode')
  })

  it('detects cycles and fails', async () => {
    registry.register(makeEchoNode('echoA', 'A'))
    registry.register(makeEchoNode('echoB', 'B'))
    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'echoA' } },
        { id: 'n2', data: { name: 'echoB' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' }, // cycle
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'start', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/cycle/i)
  })

  it('uses SSE streamer for last node', async () => {
    const streamingNode: INode = {
      label: 'Stream',
      name: 'streamNode',
      version: 1,
      type: 'Stream',
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
        if (options.sseStreamer && options.isLastNode) {
          options.sseStreamer.streamTokenEvent(options.chatId, 'streamed token')
        }
        return { id: nodeData.id, name: 'streamNode', input: {}, output: { content: 'done' } }
      },
    }
    registry.register(streamingNode)
    const flow: FlowData = {
      nodes: [{ id: 'n1', data: { name: 'streamNode' } }],
      edges: [],
    }
    const streamer = new SseStreamer('c1')
    const executor = new DagExecutor(registry)
    await executor.execute(flow, 'input', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      sseStreamer: streamer,
    })
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'token', data: 'streamed token' })
  })
})
