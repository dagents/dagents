import { describe, it, expect, vi } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { HumanInputPendingError } from '../engine/errors.js'
import { NodeRegistry } from '../engine/node-registry.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'
import { IterationNode } from '../nodes/iteration/iteration.node.js'

/**
 * 断点续跑引擎语义（design-run-checkpoint-resume.md §6.3 / §8）：
 * 种子跳过是结构保证、迭代游标续跑、HumanInputPendingError → awaiting。
 */

function spyNode(name: string, impl?: (input: unknown) => Record<string, unknown>): INode & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    label: name, name, version: 1, type: name, category: 'Test', color: '#000', inputs: [],
    async run(nodeData: INodeData, input: unknown): Promise<INodeOutput> {
      calls.push(input)
      const output = impl ? impl(input) : { content: `${name}-out` }
      return { id: nodeData.id, name, input: { raw: input }, output }
    },
  }
}

function chainFlow(): FlowData {
  return {
    nodes: [
      { id: 'a', data: { name: 'nodeA' } },
      { id: 'b', data: { name: 'nodeB' } },
      { id: 'c', data: { name: 'nodeC' } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  }
}

describe('resume：种子跳过（结构保证，非 best-effort）', () => {
  it('seedOutputs 命中的节点 run() 不被调用，下游收到种子产出', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const c = spyNode('nodeC')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    registry.register(c)

    const executor = new DagExecutor(registry)
    const result = await executor.execute(chainFlow(), 'ignored', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
      resume: {
        seedOutputs: { a: { content: 'A-SEEDED' } },
      },
    })

    expect(result.status).toBe('success')
    // 结构保证：A 不重执行（零 token 重跑的引擎侧证明）
    expect(a.calls).toHaveLength(0)
    // B 收到的是种子产出，不是重新跑出来的
    expect(b.calls[0]).toBe('A-SEEDED')
    expect(c.calls).toHaveLength(1)
  })

  it('失败节点起下游重算：种子只保 A，B/C 重跑', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const c = spyNode('nodeC')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    registry.register(c)
    const executor = new DagExecutor(registry)
    const result = await executor.execute(chainFlow(), 'go', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
      resume: { seedOutputs: { a: { content: 'A-SEEDED' } } },
    })
    expect(result.status).toBe('success')
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
    expect(c.calls).toHaveLength(1)
  })

  it('种子节点计入 finalOutput 判定（续跑后无新节点执行时产出仍正确）', async () => {
    const a = spyNode('nodeA')
    const registry = new NodeRegistry()
    registry.register(a)
    const executor = new DagExecutor(registry)
    const result = await executor.execute(
      { nodes: [{ id: 'a', data: { name: 'nodeA' } }], edges: [] },
      'go',
      {
        chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
        resume: { seedOutputs: { a: { content: 'ONLY-SEEDED' } } },
      },
    )
    expect(result.status).toBe('success')
    expect(a.calls).toHaveLength(0)
    expect(result.finalOutput).toEqual({ content: 'ONLY-SEEDED' })
  })

  it('seedRuntime 预填充 runtime（humanInputs 应答回流依赖此路径）', async () => {
    let seenState: Record<string, unknown> = {}
    const probe: INode = {
      label: 'p', name: 'probeNode', version: 1, type: 'probe', category: 'Test', color: '#000', inputs: [],
      async run(_n: INodeData, _i: unknown, options: IExecutionContext): Promise<INodeOutput> {
        seenState = options.state
        return { id: 'p', name: 'probeNode', input: {}, output: { content: 'ok' } }
      },
    }
    const registry = new NodeRegistry()
    registry.register(probe)
    const executor = new DagExecutor(registry)
    await executor.execute(
      { nodes: [{ id: 'p', data: { name: 'probeNode' } }], edges: [] },
      'go',
      {
        chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
        resume: {
          seedOutputs: {},
          seedRuntime: { humanInputs: { '确认?': '好的' } },
        },
      },
    )
    expect((seenState.humanInputs as Record<string, string>)['确认?']).toBe('好的')
  })
})

describe('resume：迭代项级游标', () => {
  it('从游标项继续，已完项产出直接进聚合（不重跑）', async () => {
    const body = spyNode('bodyNode', (input) => ({ content: `B:${String(input).slice(0, 12)}` }))
    const registry = new NodeRegistry()
    registry.register(new IterationNode())
    registry.register(body)

    const flow: FlowData = {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items: '["i1", "i2", "i3"]' } },
        { id: 'b', data: { name: 'bodyNode' } },
      ],
      edges: [{ id: 'e1', source: 'it', target: 'b', sourceHandle: 'iteration' }],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
      resume: {
        // 控制器不种子化（种子化=整个迭代已完成，body 一项都不跑）——
        // checkpoint 恢复的真实形态：控制器重跑 planning（解析 items），
        // 游标让 body 从第 3 项续。
        seedOutputs: {},
        iterationProgress: { it: { completed: 2, itemOutputs: [{ content: 'B:i1' }, { content: 'B:i2' }] } },
      },
    })

    expect(result.status).toBe('success')
    // 只有第 3 项执行了 body
    expect(body.calls).toHaveLength(1)
    // 聚合含全部 3 项
    const itRun = result.executedNodes.find((n) => n.nodeId === 'it')
    expect(itRun?.output.completedIterations).toBe(3)
    expect((itRun?.output.iterations as unknown[])).toHaveLength(3)
  })
})

describe('resume：HumanInputPendingError → awaiting', () => {
  it('resolver reject PendingError → status=awaiting + 载荷完整', async () => {
    const hi: INode = {
      label: 'hi', name: 'hiNode', version: 1, type: 'hi', category: 'Test', color: '#000', inputs: [],
      async run(_n, _i, options): Promise<INodeOutput> {
        const answer = await options.humanInputResolver!('确认方案？', 'select', ['A', 'B'])
        return { id: 'hi', name: 'hiNode', input: {}, output: { content: answer } }
      },
    }
    const downstream = spyNode('afterNode')
    const registry = new NodeRegistry()
    registry.register(hi)
    registry.register(downstream)
    const flow: FlowData = {
      nodes: [
        { id: 'h', data: { name: 'hiNode' } },
        { id: 'd', data: { name: 'afterNode' } },
      ],
      edges: [{ id: 'e1', source: 'h', target: 'd' }],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
      humanInputResolver: async () => {
        throw new HumanInputPendingError('确认方案？', 'select', ['A', 'B'])
      },
    })

    expect(result.status).toBe('awaiting')
    expect(result.awaiting).toMatchObject({
      nodeId: 'h',
      prompt: '确认方案？',
      inputType: 'select',
      options: ['A', 'B'],
    })
    // 下游未执行
    expect(downstream.calls).toHaveLength(0)
  })
})

describe('resume：onCheckpoint 快照钩子', () => {
  it('终态前必发快照；种子节点出现在快照 outputs 里', async () => {
    const a = spyNode('nodeA')
    const registry = new NodeRegistry()
    registry.register(a)
    const snapshots: Array<Record<string, unknown>> = []
    const executor = new DagExecutor(registry)
    await executor.execute(
      { nodes: [{ id: 'a', data: { name: 'nodeA' } }], edges: [] },
      'go',
      {
        chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
        resume: { seedOutputs: { a: { content: 'SEEDED' } } },
        onCheckpoint: (s) => snapshots.push(s as unknown as Record<string, unknown>),
      },
    )
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const last = snapshots[snapshots.length - 1] as { outputs: Record<string, unknown> }
    expect(last.outputs.a).toEqual({ content: 'SEEDED' })
  })

  it('失败时快照带 failedAt 现场', async () => {
    const bad: INode = {
      label: 'bad', name: 'badNode', version: 1, type: 'bad', category: 'Test', color: '#000', inputs: [],
      async run(): Promise<INodeOutput> {
        throw new Error('boom-resume')
      },
    }
    const registry = new NodeRegistry()
    registry.register(bad)
    const shots: Array<{ failedAt?: { nodeId: string; error: string } }> = []
    const executor = new DagExecutor(registry)
    await executor.execute(
      { nodes: [{ id: 'x', data: { name: 'badNode' } }], edges: [] },
      'go',
      { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false, onCheckpoint: (s) => shots.push(s) },
    )
    expect(shots[shots.length - 1]?.failedAt).toMatchObject({ nodeId: 'x', error: 'boom-resume' })
  })
})
