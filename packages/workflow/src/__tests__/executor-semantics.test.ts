import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { IterationNode } from '../nodes/iteration/iteration.node.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

/**
 * 引擎脆弱语义钉死（2026-09-17 架构评审）：并行波次部分失败、迭代上限、
 * 嵌套迭代、波间取消、多输入合并的 per-source 数组与迭代元数据清理。
 * 这些是重构 runWaves/mergeInputs 前必须先钉住的行为契约。
 */

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

/** 记录收到的 input 的探针节点（断言 mergeInputs 语义用）。 */
let lastProbeInput: unknown = undefined
function makeProbeNode(name: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(nodeData: INodeData, input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      lastProbeInput = input
      return { id: nodeData.id, name, input: { raw: input }, output: { content: 'probed' } }
    },
  }
}

function makeFailNode(name: string, message: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(_nodeData: INodeData, _input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      throw new Error(message)
    },
  }
}

describe('DagExecutor 脆弱语义（并行失败）', () => {
  let registry: NodeRegistry
  beforeEach(() => {
    registry = new NodeRegistry()
  })

  it('波内一个节点失败：整 run 失败、join 不执行、成功兄弟仍留痕、错误指向失败节点', async () => {
    registry.register(makeEchoNode('goodNode', 'GOOD'))
    registry.register(makeFailNode('badNode', 'boom'))
    registry.register(makeProbeNode('joinNode'))

    const flow: FlowData = {
      nodes: [
        { id: 'good', data: { name: 'goodNode' } },
        { id: 'bad', data: { name: 'badNode' } },
        { id: 'join', data: { name: 'joinNode' } },
      ],
      edges: [
        { id: 'e1', source: 'good', target: 'join' },
        { id: 'e2', source: 'bad', target: 'join' },
      ],
    }

    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
    })

    // 整体失败 + 错误归因到失败节点
    expect(result.status).toBe('failed')
    expect(result.error).toContain('boom')
    // 成功兄弟的痕迹保留（审计价值）
    expect(result.executedNodes.some((n) => n.nodeId === 'good')).toBe(true)
    expect(result.executedNodes.some((n) => n.nodeId === 'bad')).toBe(true)
    // join 永不执行
    expect(result.executedNodes.some((n) => n.nodeId === 'join')).toBe(false)
    expect(lastProbeInput).toBeUndefined()
  })
})

describe('DagExecutor 脆弱语义（迭代）', () => {
  let registry: NodeRegistry
  beforeEach(() => {
    registry = new NodeRegistry()
    registry.register(new IterationNode())
  })

  it('超过 100 项显式报错，不再静默截断（数据丢失伪装成成功的终结）', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))
    const items = JSON.stringify(Array.from({ length: 101 }, (_, i) => `item-${i}`))
    const flow: FlowData = {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items } },
        { id: 'body', data: { name: 'bodyNode' } },
      ],
      edges: [
        { id: 'e1', source: 'it', target: 'body', sourceHandle: 'iteration' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('101')
    expect(result.error).toContain('100')
    // 一项都不跑（拒绝执行而非跑一半）
    expect(result.executedNodes.some((n) => n.nodeId === 'body')).toBe(false)
  })

  it('恰好 100 项照常执行（上限边界不误伤）', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))
    const items = JSON.stringify(Array.from({ length: 100 }, (_, i) => `item-${i}`))
    const flow: FlowData = {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items } },
        { id: 'body', data: { name: 'bodyNode' } },
      ],
      edges: [{ id: 'e1', source: 'it', target: 'body', sourceHandle: 'iteration' }],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
    })
    expect(result.status).toBe('success')
    const itRun = result.executedNodes.find((n) => n.nodeId === 'it')
    expect(itRun?.output.completedIterations).toBe(100)
  })

  it('嵌套迭代：外层每项驱动一次完整内层循环（2×2 = 4 次 body）', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))
    const flow: FlowData = {
      nodes: [
        { id: 'outer', data: { name: 'iterationAgentflow', items: '["o1", "o2"]' } },
        { id: 'inner', data: { name: 'iterationAgentflow', items: '["i1", "i2"]' } },
        { id: 'body', data: { name: 'bodyNode' } },
      ],
      edges: [
        { id: 'e1', source: 'outer', target: 'inner', sourceHandle: 'iteration' },
        { id: 'e2', source: 'inner', target: 'body', sourceHandle: 'iteration' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
    })
    expect(result.status).toBe('success')
    // 最内层 body 跑 4 次（外 2 × 内 2）
    const bodyRuns = result.executedNodes.filter((n) => n.nodeId === 'body')
    expect(bodyRuns).toHaveLength(4)
    // 内层控制器每个外层 pass 各执行一次
    const innerRuns = result.executedNodes.filter((n) => n.nodeId === 'inner')
    expect(innerRuns).toHaveLength(2)
    // 外层聚合保留两次内层聚合
    const outerRun = result.executedNodes.find((n) => n.nodeId === 'outer')
    expect(outerRun?.output.completedIterations).toBe(2)
  })

  it('循环结束后迭代元数据从运行时清除（下游 {{iterationItem}} 不再读到脏值）', async () => {
    registry.register(makeEchoNode('bodyNode', 'BODY'))
    registry.register(makeProbeNode('afterNode'))
    const flow: FlowData = {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items: '["a", "b"]' } },
        { id: 'body', data: { name: 'bodyNode' } },
        { id: 'after', data: { name: 'afterNode' } },
      ],
      edges: [
        { id: 'e1', source: 'it', target: 'body', sourceHandle: 'iteration' },
        { id: 'e2', source: 'it', target: 'after', sourceHandle: 'result' },
      ],
    }
    const state: Record<string, unknown> = {}
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state, isLastNode: false,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes.some((n) => n.nodeId === 'after')).toBe(true)
    // 引擎结果携带的 state 快照不再含迭代残留
    const finalState = result.state
    expect('iterationItem' in (finalState as Record<string, unknown>)).toBe(false)
    expect('iterationIndex' in (finalState as Record<string, unknown>)).toBe(false)
    // 对照：循环体内确实写过这些键（清理不是「从未写入」的假阳性）
    // —— 用一个不清理的引擎行为做对照不可行，改为断言聚合输出仍在
    const itRun = result.executedNodes.find((n) => n.nodeId === 'it')
    expect(itRun?.output.completedIterations).toBe(2)
  })
})

describe('DagExecutor 脆弱语义（取消）', () => {
  it('波间取消：下一波节点不再启动、run 报 cancelled', async () => {
    const registry = new NodeRegistry()
    registry.register(makeEchoNode('firstNode', 'FIRST'))
    registry.register(makeProbeNode('secondNode'))
    const flow: FlowData = {
      nodes: [
        { id: 'a', data: { name: 'firstNode' } },
        { id: 'b', data: { name: 'secondNode' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }
    const controller = new AbortController()
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
      signal: controller.signal,
      onNodeEnd: (node) => {
        // 第一波完成后（进入第二波前）触发取消
        if (node.nodeId === 'a') controller.abort()
      },
    })
    expect(result.status).toBe('cancelled')
    expect(result.executedNodes.some((n) => n.nodeId === 'b')).toBe(false)
  })
})

describe('DagExecutor 脆弱语义（N 进 1 合并）', () => {
  it('多输入合并携带 per-source inputs 数组（边序）+ content 拼接', async () => {
    const registry = new NodeRegistry()
    // 两个上游：各自带 content 与互不相同的 result 字段
    const makeSrc = (name: string, content: string, result: string): INode => ({
      label: name, name, version: 1, type: name, category: 'Test', color: '#000', inputs: [],
      async run(nodeData: INodeData): Promise<INodeOutput> {
        return { id: nodeData.id, name, input: {}, output: { content, result, status: 'done' } }
      },
    })
    registry.register(makeSrc('srcOne', '第一路产出', 'one'))
    registry.register(makeSrc('srcTwo', '第二路产出', 'two'))
    registry.register(makeProbeNode('sinkNode'))

    const flow: FlowData = {
      nodes: [
        { id: 's1', data: { name: 'srcOne' } },
        { id: 's2', data: { name: 'srcTwo' } },
        { id: 'sink', data: { name: 'sinkNode' } },
      ],
      edges: [
        { id: 'e1', source: 's1', target: 'sink' },
        { id: 'e2', source: 's2', target: 'sink' },
      ],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'seed', {
      chatId: 'c1', runId: 'r1', state: {}, isLastNode: false,
    })
    expect(result.status).toBe('success')
    // sink 收到对象（多输入合并形态），content 按边序拼接
    expect(lastProbeInput).toBeTypeOf('object')
    const merged = lastProbeInput as Record<string, unknown>
    expect(merged.content).toBe('第一路产出\n第二路产出')
    // per-source 数组按边序保留每路完整输出 —— 覆盖顺序不再决定语义
    const inputs = merged.inputs as Array<Record<string, unknown>>
    expect(inputs).toHaveLength(2)
    expect(inputs[0].result).toBe('one')
    expect(inputs[1].result).toBe('two')
    // 浅合并兼容行为：同名字段后到 edge 赢（历史语义，钉住防漂移）
    expect(merged.result).toBe('two')
  })
})
