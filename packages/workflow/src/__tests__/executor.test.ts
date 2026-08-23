import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { SseStreamer } from '../engine/sse-streamer.js'
import { allNodes } from '../nodes/index.js'
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

describe('DagExecutor (parallel waves + loops)', () => {
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('runs independent branches concurrently (parallel waves)', async () => {
    const releaseOrder: string[] = []
    let active = 0
    let maxActive = 0

    const makeBlockingNode = (name: string, waitMs: number): INode => ({
      label: name,
      name,
      version: 1,
      type: name,
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData, input: unknown): Promise<INodeOutput> {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, waitMs))
        active -= 1
        releaseOrder.push(name)
        return {
          id: nodeData.id,
          name,
          input: { raw: input },
          output: { content: `${name}-done` },
        }
      },
    })

    // slowA takes 60ms, fastB 10ms — under concurrency the fast branch
    // releases first; a serial executor (topo order) would finish slowA first.
    registry.register(makeBlockingNode('slowA', 60))
    registry.register(makeBlockingNode('fastB', 10))
    registry.register(makeEchoNode('joinNode', 'M'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'slowA' } },
        { id: 'n2', data: { name: 'fastB' } },
        { id: 'n3', data: { name: 'joinNode' } },
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
    // Both branches completed before the join.
    expect(releaseOrder).toContain('slowA')
    expect(releaseOrder).toContain('fastB')
    // Concurrent: both branches were in flight at once, and the fast branch
    // released before the slow one (a serial executor would finish slowA
    // first — it's earlier in topo order).
    expect(maxActive).toBeGreaterThanOrEqual(2)
    expect(releaseOrder).toEqual(['fastB', 'slowA'])
  })

  it('executes a Loop node body once per loopCount and aggregates iterations', async () => {
    registry.register(makeEchoNode('startNode', 'start'))
    registry.register({
      label: 'Loop',
      name: 'loopAgentflow',
      version: 1,
      type: 'Loop',
      category: 'flow',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData): Promise<INodeOutput> {
        return { id: nodeData.id, name: 'loopAgentflow', input: {}, output: { loopCount: 3 } }
      },
    })
    registry.register(makeEchoNode('bodyNode', 'BODY'))

    const flow: FlowData = {
      nodes: [
        { id: 'n1', data: { name: 'startNode' } },
        { id: 'n2', data: { name: 'loopAgentflow' } },
        { id: 'n3', data: { name: 'bodyNode' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        // Legacy single-anchor graph: plain edge = loop body.
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    // Loop controller + body executed 3 times.
    const bodyRuns = result.executedNodes.filter((n) => n.nodeId === 'n3')
    expect(bodyRuns).toHaveLength(3)
    // Each iteration feeds the previous iteration's output downstream.
    expect(bodyRuns[0].output.content).toBe('seed start BODY')
    expect(bodyRuns[1].output.content).toBe('seed start BODY BODY')
    expect(bodyRuns[2].output.content).toBe('seed start BODY BODY BODY')
    // Aggregate output carries the collected iterations.
    const loopRun = result.executedNodes.find((n) => n.nodeId === 'n2')
    expect(loopRun?.output.completedIterations).toBe(3)
    expect((loopRun?.output.iterations as unknown[]).length).toBe(3)
  })

  it('executes an Iteration body once per item with loop-anchor routing', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))

    const flow: FlowData = {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items: '["a", "b"]' } },
        { id: 'n3', data: { name: 'bodyNode' } },
        { id: 'n4', data: { name: 'bodyNode' } },
      ],
      edges: [
        { id: 'e1', source: 'it', target: 'n3', sourceHandle: 'iteration' },
        { id: 'e2', source: 'n3', target: 'n4' },
      ],
    }

    // Register the real IterationNode for array parsing.
    registry.register(new (await import('../nodes/iteration/iteration.node.js')).IterationNode())

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'ignored', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    const firstBodyRuns = result.executedNodes.filter((n) => n.nodeId === 'n3')
    expect(firstBodyRuns).toHaveLength(2)
    // Iteration 1 seeds the body with item "a"; iteration 2 with "b".
    expect(firstBodyRuns[0].output.content).toBe('a BODY')
    expect(firstBodyRuns[1].output.content).toBe('b BODY')
    // The second body node chains within each iteration.
    const secondBodyRuns = result.executedNodes.filter((n) => n.nodeId === 'n4')
    expect(secondBodyRuns[0].output.content).toBe('a BODY BODY')
    expect(secondBodyRuns[1].output.content).toBe('b BODY BODY')
  })

  it('loop break condition stops iterating early', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))
    registry.register({
      label: 'Loop',
      name: 'loopAgentflow',
      version: 1,
      type: 'Loop',
      category: 'flow',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData): Promise<INodeOutput> {
        return { id: nodeData.id, name: 'loopAgentflow', input: {}, output: { loopCount: 5 } }
      },
    })

    const flow: FlowData = {
      nodes: [
        { id: 'lp', data: { name: 'loopAgentflow', condition: '$flow.state.stop === true' } },
        { id: 'n2', data: { name: 'bodyNode' } },
      ],
      edges: [{ id: 'e1', source: 'lp', target: 'n2' }],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'x', {
      chatId: 'c1',
      runId: 'r1',
      // Break condition reads runtime state — set stop so iteration 2 breaks.
      state: { stop: true },
      isLastNode: true,
    })

    expect(result.status).toBe('success')
    const bodyRuns = result.executedNodes.filter((n) => n.nodeId === 'n2')
    expect(bodyRuns).toHaveLength(1)
  })
})

describe('DagExecutor (human input + subflow wiring)', () => {
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('passes humanInputResolver through to HumanInput nodes and continues the flow', async () => {
    registry.registerMany(allNodes())
    const resolver = vi.fn().mockResolvedValue('来自人类的回答')

    const flow: FlowData = {
      nodes: [
        { id: 'hi', data: { name: 'humanInputAgentflow', prompt: '请输入名称' } },
        { id: 'dr', data: { name: 'directReplyAgentflow', directReplyMessage: '回答是：{{hi.response}}' } },
      ],
      edges: [{ id: 'e1', source: 'hi', target: 'dr' }],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      humanInputResolver: resolver,
    })

    expect(resolver).toHaveBeenCalledWith('请输入名称', 'text', [])
    expect(result.status).toBe('success')
    // The DirectReply receives the human answer as its upstream input
    // (content-string convention) and streams it.
    const dr = result.executedNodes.find((n) => n.nodeId === 'dr')
    expect(dr?.output.content).toBe('回答是：来自人类的回答')
  })

  it('passes flowExecutor through to ExecuteFlow nodes', async () => {
    registry.registerMany(allNodes())
    const flowExecutor = vi.fn().mockResolvedValue({ content: '子流程结果' })

    const flow: FlowData = {
      nodes: [
        { id: 'ef', data: { name: 'executeFlowAgentflow', flowId: 'sub-1' } },
      ],
      edges: [],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'upstream 输入', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      flowExecutor,
    })

    expect(flowExecutor).toHaveBeenCalledWith('sub-1', 'upstream 输入')
    expect(result.status).toBe('success')
    expect(result.finalOutput?.content).toBe('子流程结果')
    expect(result.finalOutput?.output).toEqual({ content: '子流程结果' })
  })
})

describe('DagExecutor (canvas-shape compatibility)', () => {
  // 画布编辑器（vendor/agentflow）保存的节点配置嵌套在 data.inputs 下，
  // 边的 sourceHandle 是锚点 id（如 'output' / `${nodeId}-output-N`）。
  // 这组回归测试保证画布保存的 flow 能被引擎正确执行（2026-08-16 修复）。
  let registry: NodeRegistry

  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('reads node config nested under data.inputs (canvas save shape)', async () => {
    // 一个读 inputs.suffix 的 echo 节点，模拟真实节点从 nodeData.inputs 读配置
    const makeConfigNode = (name: string): INode => ({
      label: name,
      name,
      version: 1,
      type: name,
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData, input: unknown): Promise<INodeOutput> {
        const suffix = (nodeData.inputs?.suffix as string) ?? 'MISSING'
        return {
          id: nodeData.id,
          name,
          input: { raw: input },
          output: { content: `${typeof input === 'string' ? input : JSON.stringify(input)} ${suffix}` },
        }
      },
    })
    registry.register(makeConfigNode('cfgA'))
    const flow: FlowData = {
      nodes: [
        {
          id: 'n1',
          data: {
            name: 'cfgA',
            label: 'Config A',
            inputs: { suffix: 'FROM_CANVAS' }, // 画布形状：配置在 data.inputs 下
          },
        },
      ],
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
    expect(result.executedNodes[0].output.content).toBe('hello FROM_CANVAS')
  })

  it('nested data.inputs overrides stale flat keys (edited AI flow)', async () => {
    const makeConfigNode = (name: string): INode => ({
      label: name,
      name,
      version: 1,
      type: name,
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData): Promise<INodeOutput> {
        return {
          id: nodeData.id,
          name,
          input: {},
          output: { content: String(nodeData.inputs?.suffix) },
        }
      },
    })
    registry.register(makeConfigNode('cfgB'))
    const flow: FlowData = {
      nodes: [
        {
          id: 'n1',
          data: {
            name: 'cfgB',
            suffix: 'STALE_FLAT', // AI 生成的旧值
            inputs: { suffix: 'NEW_NESTED' }, // 画布编辑后的新值
          },
        },
      ],
      edges: [],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, '', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.executedNodes[0].output.content).toBe('NEW_NESTED')
  })

  it('anchor-handle edges from data nodes are active (no silent downstream skip)', async () => {
    // LLM/HTTP 等数据节点的输出没有 selected/result —— 画布给它们的边填
    // 'output' 锚点 id。此前 shouldExecuteEdge 会判定不匹配而静默跳过下游。
    const dataNode: INode = {
      label: 'Data',
      name: 'dataNode',
      version: 1,
      type: 'Data',
      category: 'Test',
      color: '#000',
      inputs: [],
      async run(nodeData: INodeData, input: unknown): Promise<INodeOutput> {
        return {
          id: nodeData.id,
          name: 'dataNode',
          input: { raw: input },
          output: { content: 'data-out' }, // 无 selected/result/matched
        }
      },
    }
    const downstream = makeEchoNode('echoDown', 'DOWN')
    registry.register(dataNode)
    registry.register(downstream)
    const flow: FlowData = {
      nodes: [
        { id: 'src', data: { name: 'dataNode' } },
        { id: 'dst', data: { name: 'echoDown' } },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'dst', sourceHandle: 'output' }],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'in', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(2)
    expect(result.finalOutput?.content).toBe('data-out DOWN')
  })

  it('canvas condition node routes numeric/Else anchors to true/false branches', async () => {
    // 用真实 ConditionNode（输出只有 matched，无 selected/result —— 这是
    // shouldExecuteEdge 里 matched 分支的前提）；假节点常带 result 字段会走
    // 另一条路由规则。
    registry.registerMany(allNodes())
    registry.register(makeEchoNode('branchA', 'A'))
    registry.register(makeEchoNode('branchB', 'B'))
    const flow: FlowData = {
      nodes: [
        { id: 'cond', data: { name: 'conditionAgentflow', conditions: [{ comparisonOperator: '===', valueToCompare: 'a', valueToCompareAgainst: 'a' }] } },
        { id: 'a', data: { name: 'branchA' } },
        { id: 'b', data: { name: 'branchB' } },
      ],
      edges: [
        // 画布锚点：conditions.length = 1，index 0 = true 分支，index 1 = Else
        { id: 'e1', source: 'cond', target: 'a', sourceHandle: 'cond-output-0' },
        { id: 'e2', source: 'cond', target: 'b', sourceHandle: 'cond-output-1' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'x', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    const executedNames = result.executedNodes.map((n) => n.nodeName)
    expect(executedNames).toContain('conditionAgentflow')
    expect(executedNames).toContain('branchA')
    expect(executedNames).not.toContain('branchB')
  })
})

describe('DagExecutor node lifecycle hooks (onNodeStart / onNodeEnd)', () => {
  it('fires start→end per node in execution order with success status', async () => {
    const registry = new NodeRegistry()
    registry.registerMany([makeEchoNode('echoA', 'A'), makeEchoNode('echoB', 'B')])
    const flow: FlowData = {
      nodes: [
        { id: 'a', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'echoA' } },
        { id: 'b', type: 'customNode', position: { x: 1, y: 0 }, data: { name: 'echoB' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }
    const events: string[] = []
    const result = await new DagExecutor(registry).execute(flow, 'hi', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      onNodeStart: (n) => events.push(`start:${n.nodeId}:${n.nodeName}`),
      onNodeEnd: (n) => events.push(`end:${n.nodeId}:${n.status}`),
    })
    expect(result.status).toBe('success')
    expect(events).toEqual([
      'start:a:echoA',
      'end:a:success',
      'start:b:echoB',
      'end:b:success',
    ])
  })

  it('fires onNodeEnd with failed status when a node throws', async () => {
    const registry = new NodeRegistry()
    registry.register({
      label: 'boom', name: 'boom', version: 1, type: 'boom', category: 'Test', color: '#000', inputs: [],
      async run(): Promise<INodeOutput> {
        throw new Error('kaboom')
      },
    })
    const flow: FlowData = {
      nodes: [{ id: 'x', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'boom' } }],
      edges: [],
    }
    const events: string[] = []
    const result = await new DagExecutor(registry).execute(flow, 'in', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      onNodeStart: (n) => events.push(`start:${n.nodeId}`),
      onNodeEnd: (n) => events.push(`end:${n.nodeId}:${n.status}:${n.error}`),
    })
    expect(result.status).toBe('failed')
    expect(events).toEqual(['start:x', 'end:x:failed:kaboom'])
  })
})
