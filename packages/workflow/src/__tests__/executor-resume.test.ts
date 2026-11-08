import { describe, it, expect } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { HumanInputPendingError } from '../engine/errors.js'
import { NodeRegistry } from '../engine/node-registry.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'
import { IterationNode } from '../nodes/iteration/iteration.node.js'
import type { IExecutedNode } from '../types/index.js'
import type { JournalDecision, JournalFacade } from '../engine/executor.js'

/**
 * 断点续跑引擎语义（design-run-checkpoint-resume.md §6.3 / §8）：
 * 种子跳过是结构保证、迭代游标续跑、HumanInputPendingError → awaiting。
 * 2026-10-07 可恢复性地基新增：种子哈希对账（AC-R1-3）、cached 钩子回放、
 * per-ordinal 迭代体种子（AC-R1-2 引擎面）、ordinal 实例序号（AD-R4）、
 * journal decision 写入接缝。
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

describe('resume：种子哈希对账 + cached 钩子回放（2026-10-07 地基）', () => {
  /** 干净跑一遍收集 journal decisions，产出「种子 + 种子哈希」的标准路径。 */
  async function runOnceCollect(
    registry: NodeRegistry,
    flow: FlowData,
    hooks: {
      onNodeEnd?: (n: IExecutedNode) => void
      journal?: JournalFacade
    } = {},
  ) {
    const decisions: JournalDecision[] = []
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-h',
      state: {},
      isLastNode: false,
      onNodeEnd: hooks.onNodeEnd,
      journal:
        hooks.journal ?? {
          recordDecision: (e) => decisions.push(e),
          lookup: async () => null,
        },
    })
    return { result, decisions }
  }

  it('种子哈希一致：跳过执行且发 nodeEnd(cached) 钩子 + cached decision', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    const flow: FlowData = {
      nodes: [
        { id: 'a', data: { name: 'nodeA' } },
        { id: 'b', data: { name: 'nodeB' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }

    // 第一次跑：收集 a 的 decision（status=done + inputHash）
    const first = await runOnceCollect(registry, flow)
    const aDecision = first.decisions.find((d) => d.nodeId === 'a')
    expect(aDecision?.status).toBe('done')
    expect(typeof aDecision?.inputHash).toBe('string')

    // 第二次跑（resume 语义）：seedHashes 命中 → a 跳过 + cached 钩子。
    // 种子 = 第一次跑 a 的真实输出（decision 行携带）。重置 calls 计数以
    // 单独观测第二次跑的执行面。
    a.calls.length = 0
    const ends: IExecutedNode[] = []
    const decisions2: JournalDecision[] = []
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-h2',
      state: {},
      isLastNode: false,
      resume: {
        seedOutputs: { a: (aDecision!.output ?? {}) as Record<string, unknown> },
        seedHashes: { a: aDecision!.inputHash! },
        seedSource: { kind: 'resume', fromRunId: 'r-h' },
      },
      onNodeEnd: (n) => ends.push(n),
      journal: { recordDecision: (e) => decisions2.push(e), lookup: async () => null },
    })

    expect(result.status).toBe('success')
    expect(a.calls).toHaveLength(0) // 结构保证：未重执行
    // cached 钩子：a 以 cached 终态回放（不进 executedNodes —— 记账口径）
    const cachedEnd = ends.find((n) => n.nodeId === 'a')
    expect(cachedEnd?.status).toBe('cached')
    expect(cachedEnd?.ordinal).toBe(0)
    expect(ends.find((n) => n.nodeId === 'a' && n.status === 'success')).toBeUndefined()
    expect(result.executedNodes.find((n) => n.nodeId === 'a')).toBeUndefined()
    // journal：a 记 cached decision 且携带 lineage（谱系指向来源 run）
    const cachedDecision = decisions2.find((d) => d.nodeId === 'a')
    expect(cachedDecision?.status).toBe('cached')
    expect(cachedDecision?.lineage).toEqual({ inheritedFromRunId: 'r-h' })
    expect(cachedDecision?.inputHash).toBe(aDecision!.inputHash)
    // b 真实执行（done decision + ordinal 0）
    const bDecision = decisions2.find((d) => d.nodeId === 'b')
    expect(bDecision?.status).toBe('done')
  })

  it('AC-R1-3：种子哈希不一致 → 结构化失败（nodeId + expected/got），run failed', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    const flow: FlowData = {
      nodes: [
        { id: 'a', data: { name: 'nodeA' } },
        { id: 'b', data: { name: 'nodeB' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-h3',
      state: {},
      isLastNode: false,
      resume: {
        seedOutputs: { a: { content: 'STALE' } },
        // 上游输入变了 → 重算 hash 必然对不上一个伪造的旧 hash
        seedHashes: { a: '0'.repeat(40) },
      },
    })
    expect(result.status).toBe('failed')
    // 结构化错误：nodeId + expected/got 双 hash 都进 message（AC-R1-3）
    expect(result.error).toContain('「a」')
    expect(result.error).toContain('0000000000') // expected（伪造旧 hash 前缀）
  })

  it('无 seedHashes 的老种子（checkpoint 兜底）跳过校验照旧种子化', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const c = spyNode('nodeC')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    registry.register(c)
    const executor = new DagExecutor(registry)
    const result = await executor.execute(chainFlow(), 'go', {
      chatId: 'c1',
      runId: 'r-h4',
      state: {},
      isLastNode: false,
      resume: { seedOutputs: { a: { content: 'A-SEEDED' } } },
    })
    expect(result.status).toBe('success')
    expect(a.calls).toHaveLength(0)
  })
})

describe('resume：per-ordinal 迭代体种子（AC-R1-2 引擎面）', () => {
  function iterFlow(): FlowData {
    return {
      nodes: [
        { id: 'it', data: { name: 'iterationAgentflow', items: '["i1", "i2", "i3"]' } },
        { id: 'b', data: { name: 'bodyNode' } },
      ],
      edges: [{ id: 'e1', source: 'it', target: 'b', sourceHandle: 'iteration' }],
    }
  }

  /**
   * 断点场景：3 项，第 1 项（index 0）已完成（completed=1，产出在
   * itemOutputs）；第 2 项（index 1）执行到一半崩溃——body 节点 b 已完成，
   * 其输出在 journal 的 per-ordinal decision 行里，gateway 组装为
   * itemNodeOutputs[1]。resume 后：index 0 不进循环（前缀聚合）；index 1
   * 的 b 预填短路（cached）；index 2 正常执行。
   */
  function partialResumeProgress() {
    return {
      completed: 1,
      itemOutputs: [{ content: 'B:i1' }] as Array<Record<string, unknown>>,
      itemNodeOutputs: [
        {},
        { b: { content: 'B:i2-partial' } as Record<string, unknown> },
      ] as Array<Record<string, Record<string, unknown>>>,
    }
  }

  it('itemNodeOutputs 预填：断点项（i≥completed）的 body 节点零重跑，聚合完整', async () => {
    const body = spyNode('bodyNode', (input) => ({ content: `B:${String(input).slice(0, 12)}` }))
    const registry = new NodeRegistry()
    registry.register(new IterationNode())
    registry.register(body)

    const executor = new DagExecutor(registry)
    const result = await executor.execute(iterFlow(), 'seed', {
      chatId: 'c1',
      runId: 'r-i1',
      state: {},
      isLastNode: false,
      resume: {
        seedOutputs: {},
        iterationProgress: { it: partialResumeProgress() },
      },
    })

    expect(result.status).toBe('success')
    // 前缀项（0）不进循环；断点项（1）body 预填短路；活项（2）执行一次
    expect(body.calls).toHaveLength(1)
    expect(body.calls[0]).toBe('i3') // 只有第 3 项真实执行
    const itRun = result.executedNodes.find((n) => n.nodeId === 'it')
    expect(itRun?.output.completedIterations).toBe(3)
    const iterations = itRun?.output.iterations as Array<{ content: string }>
    expect(iterations).toHaveLength(3)
    // 聚合：前缀原值 + 断点项预填产出 + 活项真实产出
    expect(iterations[0]?.content).toBe('B:i1')
    expect(iterations[1]?.content).toBe('B:i2-partial')
    expect(iterations[2]?.content).toBe('B:i3')
  })

  it('ordinal 分配（AD-R4）：断点项种子占位与活项执行号不撞；控制器恒 0', async () => {
    const ends: IExecutedNode[] = []
    const body = spyNode('bodyNode', (input) => ({ content: `B:${String(input).slice(0, 12)}` }))
    const registry = new NodeRegistry()
    registry.register(new IterationNode())
    registry.register(body)

    const executor = new DagExecutor(registry)
    const result = await executor.execute(iterFlow(), 'seed', {
      chatId: 'c1',
      runId: 'r-i2',
      state: {},
      isLastNode: false,
      onNodeEnd: (n) => ends.push(n),
      resume: {
        seedOutputs: {},
        iterationProgress: { it: partialResumeProgress() },
      },
    })

    expect(result.status).toBe('success')
    // b 的事件：断点项（i=1）cached 占 ordinal 0，活项（i=2）占 1 —— 每
    // (nodeId, ordinal) 一档，journal decision 键不撞
    const bEnds = ends.filter((n) => n.nodeId === 'b').map((n) => n.ordinal).sort((x, y) => x - y)
    expect(bEnds).toEqual([0, 1])
    expect(ends.find((n) => n.nodeId === 'b' && n.status === 'cached')?.ordinal).toBe(0)
    expect(ends.find((n) => n.nodeId === 'b' && n.status === 'success')?.ordinal).toBe(1)
    // 根图控制器（非迭代 body）恒 0
    expect(ends.find((n) => n.nodeId === 'it')?.ordinal).toBe(0)
  })

  it('无预填的连续迭代：body 第 n 次执行 = n（单层下恰等于项索引）', async () => {
    const ends: IExecutedNode[] = []
    const body = spyNode('bodyNode', (input) => ({ content: `B:${String(input).slice(0, 12)}` }))
    const registry = new NodeRegistry()
    registry.register(new IterationNode())
    registry.register(body)

    const executor = new DagExecutor(registry)
    const result = await executor.execute(iterFlow(), 'seed', {
      chatId: 'c1',
      runId: 'r-i3',
      state: {},
      isLastNode: false,
      onNodeEnd: (n) => ends.push(n),
    })

    expect(result.status).toBe('success')
    const bOrdinals = ends
      .filter((n) => n.nodeId === 'b')
      .map((n) => n.ordinal)
      .sort((x, y) => x - y)
    expect(bOrdinals).toEqual([0, 1, 2])
  })

  it('普通节点 ordinal 恒 0（含失败重跑记录）', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const c = spyNode('nodeC')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    registry.register(c)
    const ends: IExecutedNode[] = []
    const executor = new DagExecutor(registry)
    await executor.execute(chainFlow(), 'go', {
      chatId: 'c1',
      runId: 'r-i4',
      state: {},
      isLastNode: false,
      onNodeEnd: (n) => ends.push(n),
    })
    expect(ends.filter((n) => n.nodeId === 'a').every((n) => n.ordinal === 0)).toBe(true)
  })
})

describe('resume：journal decision 写入接缝（§3.1(e)）', () => {
  it('done/failed 终态各记一档，含 inputHash；非终态（挂起）不记', async () => {
    const good = spyNode('nodeA')
    const bad: INode = {
      label: 'bad', name: 'badNode', version: 1, type: 'bad', category: 'Test', color: '#000', inputs: [],
      async run(): Promise<INodeOutput> {
        throw new Error('boom-journal')
      },
    }
    const registry = new NodeRegistry()
    registry.register(good)
    registry.register(bad)
    const flow: FlowData = {
      nodes: [
        { id: 'g', data: { name: 'nodeA' } },
        { id: 'x', data: { name: 'badNode' } },
      ],
      edges: [],
    }
    const decisions: JournalDecision[] = []
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-j1',
      state: {},
      isLastNode: false,
      journal: { recordDecision: (e) => decisions.push(e), lookup: async () => null },
    })
    expect(result.status).toBe('failed')
    const doneRow = decisions.find((d) => d.nodeId === 'g')
    expect(doneRow?.status).toBe('done')
    expect(doneRow?.inputHash).toMatch(/^[0-9a-f]{40}$/)
    expect(doneRow?.ordinal).toBe(0)
    const failedRow = decisions.find((d) => d.nodeId === 'x')
    expect(failedRow?.status).toBe('failed')
    expect(decisions).toHaveLength(2)
  })

  it('computeInputHash 引擎口径可复算：同 flow 同输入两次跑同 hash（跨 run 可比）', async () => {
    const a = spyNode('nodeA')
    const registry = new NodeRegistry()
    registry.register(a)
    const flow: FlowData = {
      nodes: [{ id: 'a', data: { name: 'nodeA', inputs: { note: '配置' } } }],
      edges: [],
    }
    const r1 = await runWithJournal(registry, flow, 'run-1')
    const r2 = await runWithJournal(registry, flow, 'run-2')
    expect(r1[0]?.inputHash).toBe(r2[0]?.inputHash)

    function runWithJournal(
      reg: NodeRegistry,
      f: FlowData,
      runId: string,
    ): Promise<JournalDecision[]> {
      const out: JournalDecision[] = []
      const executor = new DagExecutor(reg)
      return executor
        .execute(f, 'go', {
          chatId: 'c1', runId, state: {}, isLastNode: false,
          journal: { recordDecision: (e) => out.push(e), lookup: async () => null },
        })
        .then(() => out)
    }
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

describe('resume：cached 继承 token（PRD R2.3，2026-10-08 修复）', () => {
  it('seedTokens 携带前驱用量 → cached nodeEnd.tokens 记继承值 + lineage.inheritedTokens（AC-R2-3 引擎面）', async () => {
    const a = spyNode('nodeA')
    const b = spyNode('nodeB')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(b)
    registry.register(spyNode('nodeC'))
    const flow = chainFlow()

    // 干净跑收集 hash（种子组装的标准路径）
    const seeded = new Map<string, string>()
    const journalCollect: JournalFacade = {
      recordDecision: (e) => {
        if (e.status === 'done' && e.inputHash) seeded.set(e.nodeId, e.inputHash)
      },
      lookup: async () => null,
    }
    await new DagExecutor(registry).execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-t1',
      state: {},
      isLastNode: false,
      journal: journalCollect,
    })

    const cachedNodes: IExecutedNode[] = []
    const decisions: JournalDecision[] = []
    a.calls.splice(0) // 第一轮的执行记录清空——第二轮的跳过断言才干净
    const executor = new DagExecutor(registry)
    const result = await executor.execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-t2',
      state: {},
      isLastNode: false,
      onNodeEnd: (n) => {
        if (n.status === 'cached') cachedNodes.push(n)
      },
      journal: {
        recordDecision: (e) => decisions.push(e),
        lookup: async () => null,
      },
      resume: {
        // 只种子 a（前驱），b/c 真实执行
        seedOutputs: { a: { content: 'nodeA-out' } },
        seedHashes: { a: seeded.get('a')! },
        seedTokens: {
          a: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
        },
        seedSource: { kind: 'warm-cache', fromRunId: 'r-t1' },
      },
    })

    expect(result.status).toBe('success')
    expect(a.calls).toHaveLength(0) // 种子跳过
    // cached nodeEnd 的 tokens = 继承值（span 记账面——双口径的继承侧）
    expect(cachedNodes).toHaveLength(1)
    expect(cachedNodes[0]!.nodeId).toBe('a')
    expect(cachedNodes[0]!.tokens).toMatchObject({ total_tokens: 200 })
    // journal cached decision：lineage 带 inheritedTokens（对账可查）
    const cachedDecision = decisions.find((d) => d.status === 'cached')!
    expect(cachedDecision.nodeId).toBe('a')
    expect(cachedDecision.lineage).toMatchObject({
      inheritedFromRunId: 'r-t1',
      inheritedTokens: 200,
    })
    expect(cachedDecision.tokens).toMatchObject({ total_tokens: 200 })
  })

  it('无 seedTokens（老种子）→ cached tokens 恒 null、lineage 无 inheritedTokens（兼容面）', async () => {
    const a = spyNode('nodeA')
    const registry = new NodeRegistry()
    registry.register(a)
    registry.register(spyNode('nodeB'))
    registry.register(spyNode('nodeC'))
    const flow = chainFlow()

    const seeded = new Map<string, string>()
    await new DagExecutor(registry).execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-t3',
      state: {},
      isLastNode: false,
      journal: {
        recordDecision: (e) => {
          if (e.status === 'done' && e.inputHash) seeded.set(e.nodeId, e.inputHash)
        },
        lookup: async () => null,
      },
    })

    const cachedNodes: IExecutedNode[] = []
    const decisions: JournalDecision[] = []
    const result = await new DagExecutor(registry).execute(flow, 'go', {
      chatId: 'c1',
      runId: 'r-t4',
      state: {},
      isLastNode: false,
      onNodeEnd: (n) => {
        if (n.status === 'cached') cachedNodes.push(n)
      },
      journal: {
        recordDecision: (e) => decisions.push(e),
        lookup: async () => null,
      },
      resume: {
        seedOutputs: { a: { content: 'nodeA-out' } },
        seedHashes: { a: seeded.get('a')! },
        // 无 seedTokens：老种子路径
      },
    })
    expect(result.status).toBe('success')
    expect(cachedNodes[0]!.tokens).toBeNull()
    const cachedDecision = decisions.find((d) => d.status === 'cached')!
    expect(cachedDecision.lineage).toBeUndefined()
  })
})
