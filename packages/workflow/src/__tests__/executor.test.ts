import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { RuntimeState } from '../engine/runtime.js'
import { SseStreamer } from '../engine/sse-streamer.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

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

function makeConditionNode(name: string, result: 'true' | 'false'): INode {
  return {
    label: name,
    name,
    version: 1,
    type: 'Condition',
    category: 'logic',
    color: '#f59e0b',
    inputs: [],
    async run(nodeData: INodeData, input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      return {
        id: nodeData.id,
        name,
        input: { raw: input },
        output: { matched: result, result },
      }
    },
  }
}

function makeConditionAgentNode(name: string, selected: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: 'ConditionAgent',
    category: 'logic',
    color: '#f59e0b',
    inputs: [],
    async run(nodeData: INodeData, input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      return {
        id: nodeData.id,
        name,
        input: { raw: input },
        output: { selected, result: selected, reason: 'test' },
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

describe('DagExecutor (conditional branching)', () => {
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('executes only true branch when condition matches', async () => {
    registry.register(makeEchoNode('startNode', 'start'))
    registry.register(makeConditionNode('condTrue', 'true'))
    registry.register(makeEchoNode('trueBranch', 'TRUE'))
    registry.register(makeEchoNode('falseBranch', 'FALSE'))
    registry.register(makeEchoNode('joinNode', 'join'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'startNode' } },
        { id: 'n2', data: { name: 'condTrue' } },
        { id: 'n3', data: { name: 'trueBranch' } },
        { id: 'n4', data: { name: 'falseBranch' } },
        { id: 'n5', data: { name: 'joinNode' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
        { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false' },
        { id: 'e4', source: 'n3', target: 'n5' },
        { id: 'e5', source: 'n4', target: 'n5' },
      ],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    const executedIds = result.executedNodes.map((n) => n.nodeId)
    expect(executedIds).toContain('n1')
    expect(executedIds).toContain('n2')
    expect(executedIds).toContain('n3')
    expect(executedIds).not.toContain('n4')
    expect(executedIds).toContain('n5')
    expect(result.executedNodes).toHaveLength(4)
  })

  it('executes only false branch when condition does not match', async () => {
    registry.register(makeEchoNode('startNode', 'start'))
    registry.register(makeConditionNode('condFalse', 'false'))
    registry.register(makeEchoNode('trueBranch', 'TRUE'))
    registry.register(makeEchoNode('falseBranch', 'FALSE'))
    registry.register(makeEchoNode('joinNode', 'join'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'startNode' } },
        { id: 'n2', data: { name: 'condFalse' } },
        { id: 'n3', data: { name: 'trueBranch' } },
        { id: 'n4', data: { name: 'falseBranch' } },
        { id: 'n5', data: { name: 'joinNode' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
        { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false' },
        { id: 'e4', source: 'n3', target: 'n5' },
        { id: 'e5', source: 'n4', target: 'n5' },
      ],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    const executedIds = result.executedNodes.map((n) => n.nodeId)
    expect(executedIds).toContain('n1')
    expect(executedIds).toContain('n2')
    expect(executedIds).not.toContain('n3')
    expect(executedIds).toContain('n4')
    expect(executedIds).toContain('n5')
    expect(result.executedNodes).toHaveLength(4)
  })

  it('routes ConditionAgent by selected scenario', async () => {
    registry.register(makeConditionAgentNode('condAgent', 'scenarioB'))
    registry.register(makeEchoNode('scenarioA', 'SA'))
    registry.register(makeEchoNode('scenarioB', 'SB'))
    registry.register(makeEchoNode('scenarioC', 'SC'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'condAgent' } },
        { id: 'n2', data: { name: 'scenarioA' } },
        { id: 'n3', data: { name: 'scenarioB' } },
        { id: 'n4', data: { name: 'scenarioC' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'scenarioA' },
        { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'scenarioB' },
        { id: 'e3', source: 'n1', target: 'n4', sourceHandle: 'scenarioC' },
      ],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    const executedIds = result.executedNodes.map((n) => n.nodeId)
    expect(executedIds).toContain('n1')
    expect(executedIds).not.toContain('n2')
    expect(executedIds).toContain('n3')
    expect(executedIds).not.toContain('n4')
    expect(result.executedNodes).toHaveLength(2)
  })

  it('sets isLastNode on the real final executed node in a branch', async () => {
    const lastFlags: Record<string, boolean> = {}
    const captureNode = (name: string, suffix: string): INode => ({
      label: name,
      name,
      version: 1,
      type: name,
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData, input, options) {
        lastFlags[nodeData.id] = options.isLastNode
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
        return { id: nodeData.id, name, input: { raw: input }, output: { content: `${inputStr} ${suffix}` } }
      },
    })

    registry.register(captureNode('startNode', 'start'))
    registry.register(makeConditionNode('cond', 'true'))
    registry.register(captureNode('trueBranch', 'TRUE'))
    registry.register(captureNode('falseBranch', 'FALSE'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'startNode' } },
        { id: 'n2', data: { name: 'cond' } },
        { id: 'n3', data: { name: 'trueBranch' } },
        { id: 'n4', data: { name: 'falseBranch' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
        { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false' },
      ],
    }

    const executor = new DagExecutor(registry)
    await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    // n3 is the real last executed node; n4 is on the inactive false branch.
    expect(lastFlags.n1).toBe(false)
    expect(lastFlags.n2).toBeUndefined()
    expect(lastFlags.n3).toBe(true)
    expect(lastFlags.n4).toBeUndefined()
  })

  it('sets isLastNode on the active branch tail when the other branch is inactive', async () => {
    const lastFlags: Record<string, boolean> = {}
    const captureNode = (name: string, suffix: string): INode => ({
      label: name,
      name,
      version: 1,
      type: name,
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData, input, options) {
        lastFlags[nodeData.id] = options.isLastNode
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
        return { id: nodeData.id, name, input: { raw: input }, output: { content: `${inputStr} ${suffix}` } }
      },
    })

    registry.register(captureNode('startNode', 'start'))
    registry.register(makeConditionNode('cond', 'false'))
    registry.register(captureNode('trueBranch', 'TRUE'))
    registry.register(captureNode('falseBranch', 'FALSE'))

    // cond=false, so n4 is executed and is the real last node; n3 is skipped.
    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'startNode' } },
        { id: 'n2', data: { name: 'cond' } },
        { id: 'n3', data: { name: 'trueBranch' } },
        { id: 'n4', data: { name: 'falseBranch' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
        { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false' },
      ],
    }

    const executor = new DagExecutor(registry)
    await executor.execute(flow, 'hello', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(lastFlags.n1).toBe(false)
    expect(lastFlags.n2).toBeUndefined()
    expect(lastFlags.n3).toBeUndefined()
    expect(lastFlags.n4).toBe(true)
  })

  it('skips entire downstream branch when condition skips predecessor', async () => {
    registry.register(makeConditionNode('cond', 'false'))
    registry.register(makeEchoNode('trueNode', 'T1'))
    registry.register(makeEchoNode('trueChild', 'T2'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'cond' } },
        { id: 'n2', data: { name: 'trueNode' } },
        { id: 'n3', data: { name: 'trueChild' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'true' },
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
    const executedIds = result.executedNodes.map((n) => n.nodeId)
    expect(executedIds).toContain('n1')
    expect(executedIds).not.toContain('n2')
    expect(executedIds).not.toContain('n3')
    expect(result.executedNodes).toHaveLength(1)
  })

  it('merges inputs from multiple active incoming edges', async () => {
    registry.register(makeEchoNode('branchA', 'A'))
    registry.register(makeEchoNode('branchB', 'B'))
    registry.register(makeEchoNode('mergeNode', 'M'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'branchA' } },
        { id: 'n2', data: { name: 'branchB' } },
        { id: 'n3', data: { name: 'mergeNode' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n3' },
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
    const mergeNode = result.executedNodes.find((n) => n.nodeId === 'n3')
    expect(mergeNode).toBeDefined()
  })

  it('linear DAG still works with new executor', async () => {
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
    expect(result.executedNodes[2].output.content).toBe('start A B C')
  })
})
