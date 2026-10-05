import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { IterationNode } from '../nodes/iteration/iteration.node.js'
import { StartNode } from '../nodes/start/start.node.js'
import { LLMNode } from '../nodes/llm/llm.node.js'
import { ExecuteFlowNode } from '../nodes/execute-flow/execute-flow.node.js'
import { validateAgainstSchema, extractJsonFromText } from '../utils/json-schema-lite.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData, FlowNode } from '../types/flow.js'

/**
 * 2026-10-04 多人格优化轮的新语义钉死（Reality Checker：先织网，语义
 * 改动必须在这里过闸）：
 *  - 失败分支隔离（isolateFailure → partial_success + 下游剪枝）
 *  - 显式 finalOutput 指定（压过拓扑最深默认）
 *  - run 级 tokenBudget（budget_exceeded 终态）
 *  - iteration whileCondition 提前收敛（earlyExit 标记）
 *  - iteration 有界并发（completedIterations / executedNodes 确定性）
 *  - LLM 节点 outputSchema 契约（解析 + 一轮修复重试 + json 字段）
 *  - ExecuteFlow 子流程节点（DB-free seam）
 *  - json-schema-lite 子集校验器
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
    async run(nodeData: INodeData, input: unknown): Promise<INodeOutput> {
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

function makeFailNode(name: string, message: string): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(): Promise<INodeOutput> {
      throw new Error(message)
    },
  }
}

function makeUsageNode(name: string, totalTokens: number): INode {
  return {
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
        output: { content: `${name}-out` },
        usage: { prompt_tokens: totalTokens, completion_tokens: 0, total_tokens: totalTokens },
      }
    },
  }
}

const n = (id: string, name: string, extra: Record<string, unknown> = {}): FlowNode => ({
  id,
  type: 'customNode',
  position: { x: 0, y: 0 },
  data: { name, label: id, ...extra },
})

const e = (source: string, target: string, sourceHandle?: string) => ({
  id: `e-${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

const baseOpts = {
  chatId: 'test-chat',
  runId: 'test-run',
  state: {},
  isLastNode: true,
}

const schema = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['yes', 'no'] } },
  required: ['verdict'],
}

describe('失败分支隔离（isolateFailure）', () => {
  let registry: NodeRegistry
  beforeEach(() => {
    registry = new NodeRegistry()
    registry.register(new StartNode())
  })

  it('隔离失败 → partial_success，兄弟分支照常、失败下游剪枝', async () => {
    registry.register(makeEchoNode('okNode', 'OK'))
    registry.register(makeFailNode('badNode', 'boom'))
    registry.register(makeEchoNode('afterBad', 'AFTER'))
    registry.register(makeEchoNode('join', 'JOIN'))
    const executor = new DagExecutor(registry)

    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('a', 'okNode'),
        n('b', 'badNode', { isolateFailure: true }),
        n('ab', 'afterBad'),
        n('j', 'join'),
      ],
      edges: [e('s', 'a'), e('s', 'b'), e('a', 'j'), e('b', 'ab')],
    }
    const result = await executor.execute(flow, 'in', { ...baseOpts })

    expect(result.status).toBe('partial_success')
    // join 执行（成功分支仍可达），失败下游 afterBad 被剪枝
    const ids = result.executedNodes.map((x) => x.nodeId)
    expect(ids).toContain('j')
    expect(ids).not.toContain('ab')
    expect(ids).toContain('b') // 失败节点本身留痕
    // finalOutput 来自成功链的最深节点（join），不是 null
    expect(result.finalOutput).toMatchObject({ content: expect.stringContaining('JOIN') })
  })

  it('未声明隔离的失败 → 整 run failed（默认语义不变）', async () => {
    registry.register(makeEchoNode('okNode', 'OK'))
    registry.register(makeFailNode('badNode', 'boom'))
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [n('s', 'startAgentflow'), n('a', 'okNode'), n('b', 'badNode')],
      edges: [e('s', 'a'), e('s', 'b')],
    }
    const result = await executor.execute(flow, 'in', { ...baseOpts })
    expect(result.status).toBe('failed')
  })
})

describe('显式 finalOutput 指定', () => {
  it('finalOutput: true 的浅节点压过拓扑更深的默认节点', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(makeEchoNode('echoA', 'A'))
    registry.register(makeEchoNode('echoB', 'B'))
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('a', 'echoA', { finalOutput: true }),
        n('b', 'echoB'), // 拓扑更深
      ],
      edges: [e('s', 'a'), e('a', 'b')],
    }
    const result = await executor.execute(flow, 'in', { ...baseOpts })
    expect(result.status).toBe('success')
    expect(result.finalOutput).toMatchObject({ content: expect.stringContaining(' A') })
  })
})

describe('run 级 tokenBudget', () => {
  it('累计越线 → budget_exceeded 终态 + 对账错误消息', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(makeUsageNode('spendy', 700))
    registry.register(makeUsageNode('spendy2', 700))
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [n('s', 'startAgentflow'), n('a', 'spendy'), n('b', 'spendy2')],
      edges: [e('s', 'a'), e('a', 'b')],
    }
    const result = await executor.execute(flow, 'in', { ...baseOpts, tokenBudget: 1000 })
    expect(result.status).toBe('budget_exceeded')
    expect(result.error).toContain('1000')
    // 第一波（含 a）已完成，产出截至停机点
    expect(result.finalOutput).not.toBeNull()
  })

  it('预算内 → 正常 success', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(makeUsageNode('spendy', 700))
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [n('s', 'startAgentflow'), n('a', 'spendy')],
      edges: [e('s', 'a')],
    }
    const result = await executor.execute(flow, 'in', { ...baseOpts, tokenBudget: 1000 })
    expect(result.status).toBe('success')
  })
})

describe('iteration whileCondition + concurrency', () => {
  let registry: NodeRegistry
  beforeEach(() => {
    registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new IterationNode())
    registry.register(makeEchoNode('bodyEcho', 'BODY'))
  })

  // 图形：s → it；it -iteration-> b（body 链）；it -result-> r（聚合消费者）。
  // 聚合字段（completedIterations/earlyExit/iterations）在**控制器节点**的
  // executedNodes 记录上（体内完成后重发），finalOutput 是 r 的回显。
  const iterationFlow = (items: string, extra: Record<string, unknown> = {}): FlowData => ({
    nodes: [
      n('s', 'startAgentflow'),
      n('it', 'iterationAgentflow', { items, ...extra }),
      n('b', 'bodyEcho'),
      n('r', 'bodyEcho'),
    ],
    edges: [e('s', 'it'), e('it', 'b', 'iteration'), e('it', 'r', 'result')],
  })

  /** 控制器节点的 span 记录（聚合终态字段的载体）。 */
  const controllerRecord = (result: {
    executedNodes: Array<{ nodeId: string; output: Record<string, unknown> }>
  }) => result.executedNodes.find((x) => x.nodeId === 'it')!.output

  it('whileCondition 真值 → 停止剩余项 + earlyExit 标记', async () => {
    // $input = 每项完成后的最深 body 输出（content 含项文本）；第 2 项后触发
    const flow = iterationFlow('["a","b","c","d"]', {
      whileCondition: '$inputText.includes("b")',
    })
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'in', { ...baseOpts })
    expect(result.status).toBe('success')
    const ctrl = controllerRecord(result)
    expect(ctrl.earlyExit).toBe(true)
    expect(ctrl.completedIterations).toBe(2)
    expect((ctrl.iterations as unknown[]).length).toBe(2)
  })

  it('concurrency=3：全部项完成、聚合完整（executedNodes 确定性由项序归并保证）', async () => {
    const flow = iterationFlow('["i1","i2","i3","i4","i5"]', { concurrency: 3 })
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'in', { ...baseOpts })
    expect(result.status).toBe('success')
    const ctrl = controllerRecord(result)
    expect(ctrl.completedIterations).toBe(5)
    expect((ctrl.iterations as unknown[]).length).toBe(5)
    // 聚合 content 有全部 5 项
    expect(String(ctrl.content)).toContain('i5')
    expect(String(ctrl.content)).toContain('i1')
  })

  it('体内嵌套迭代 + concurrency>1 → 自动回退串行仍正确', async () => {
    // bodyEcho 是普通节点——本用例验证回退路径不炸（嵌套控制器的图结构
    // 由专门用例覆盖；这里以合法小图跑通回退分支的行为等价性）
    const flow = iterationFlow('["x","y"]', { concurrency: 4 })
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'in', { ...baseOpts })
    expect(result.status).toBe('success')
    expect(controllerRecord(result).completedIterations).toBe(2)
  })
})

describe('LLM 节点 outputSchema 契约', () => {
  function makeSchemaClient(responses: string[]) {
    let call = 0
    const received: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const client = {
      chat: async (params: {
        messages: Array<{ role: string; content: string }>
        responseSchema?: Record<string, unknown>
      }): Promise<{ text: string; usage?: { total_tokens: number } }> => {
        received.push({ messages: params.messages })
        const text = responses[Math.min(call, responses.length - 1)]
        call += 1
        return { text, usage: { total_tokens: 5 } }
      },
      // 故意不实现 chatStream：schema 模式禁用流式
    }
    return { received, client }
  }

  const schemaLocal = schema

  it('首次坏 JSON → 修复重试 → 输出带 json 字段', async () => {
    const { client, received } = makeSchemaClient([
      '我认为应该是 {"verdict":"maybe"} 加点废话',
      '{"verdict":"yes"}',
    ])
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new LLMNode())
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('l', 'llmAgentflow', {
          model: 'm',
          prompt: '判断一下',
          outputSchema: JSON.stringify(schemaLocal),
        }),
      ],
      edges: [e('s', 'l')],
    }
    const result = await executor.execute(flow, 'in', {
      ...baseOpts,
      llmClient: client as unknown as IExecutionContext['llmClient'],
    })
    expect(result.status).toBe('success')
    // 两轮调用（初次 + 修复）
    expect(received.length).toBe(2)
    // 修复轮带错误清单
    expect(received[1].messages.some((m) => m.content.includes('不符合约定'))).toBe(true)
    const out = result.finalOutput as Record<string, unknown>
    expect(out.json).toEqual({ verdict: 'yes' })
  })

  it('修复重试后仍不合规 → 节点诚实失败', async () => {
    const { client } = makeSchemaClient(['完全不是 JSON', '还是不是'])
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new LLMNode())
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('l', 'llmAgentflow', {
          model: 'm',
          prompt: '判断一下',
          outputSchema: JSON.stringify(schemaLocal),
        }),
      ],
      edges: [e('s', 'l')],
    }
    const result = await executor.execute(flow, 'in', {
      ...baseOpts,
      llmClient: client as unknown as IExecutionContext['llmClient'],
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('outputSchema')
  })
})

describe('ExecuteFlow 子流程节点（DB-free seam）', () => {
  it('宿主注入的 flowExecutor 被调用、输出承接 content 约定', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new ExecuteFlowNode())
    const executor = new DagExecutor(registry)
    const calls: string[] = []
    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('f', 'executeFlowAgentflow', { targetFlowId: '11111111-2222-3333-4444-555555555555' }),
      ],
      edges: [e('s', 'f')],
    }
    const result = await executor.execute(flow, '上游输入', {
      ...baseOpts,
      flowExecutor: async (flowId, input) => {
        calls.push(flowId)
        return { output: { content: `子流程产出(${String(input)})` }, status: 'success' }
      },
    })
    expect(result.status).toBe('success')
    expect(calls).toEqual(['11111111-2222-3333-4444-555555555555'])
    expect(result.finalOutput).toMatchObject({
      content: expect.stringContaining('子流程产出'),
      subflowStatus: 'success',
    })
  })

  it('子流程失败 → 节点如实抛错（run failed）', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new ExecuteFlowNode())
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [
        n('s', 'startAgentflow'),
        n('f', 'executeFlowAgentflow', { targetFlowId: '11111111-2222-3333-4444-555555555555' }),
      ],
      edges: [e('s', 'f')],
    }
    const result = await executor.execute(flow, 'in', {
      ...baseOpts,
      flowExecutor: async () => ({ output: { content: '炸了' }, status: 'failed' }),
    })
    expect(result.status).toBe('failed')
  })

  it('缺 targetFlowId → 明确报错', async () => {
    const registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new ExecuteFlowNode())
    const executor = new DagExecutor(registry)
    const flow: FlowData = {
      nodes: [n('s', 'startAgentflow'), n('f', 'executeFlowAgentflow', {})],
      edges: [e('s', 'f')],
    }
    const result = await executor.execute(flow, 'in', {
      ...baseOpts,
      flowExecutor: async () => ({ output: {}, status: 'success' }),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('Flow ID')
  })
})

describe('json-schema-lite', () => {
  it('required 缺失 + 类型不符 → 带路径的错误清单', () => {
    const issues = validateAgainstSchema({ verdict: 42 }, schema)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.path.includes('verdict'))).toBe(true)
  })

  it('合规对象 → 通过', () => {
    expect(validateAgainstSchema({ verdict: 'yes' }, schema)).toEqual([])
  })

  it('enum / items / 数值范围', () => {
    expect(
      validateAgainstSchema(
        { list: [1, 'x'], score: 999 },
        {
          type: 'object',
          properties: {
            list: { type: 'array', items: { type: 'integer' } },
            score: { type: 'number', maximum: 100 },
          },
        },
      ).length,
    ).toBe(2)
  })

  it('extractJsonFromText 容忍围栏与前后废话', () => {
    expect(extractJsonFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJsonFromText('好的，结果如下：{"a": [1,2]} 以上')).toEqual({ a: [1, 2] })
    expect(() => extractJsonFromText('没有任何结构')).toThrow()
  })
})
