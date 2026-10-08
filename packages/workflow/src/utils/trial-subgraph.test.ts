import { describe, it, expect } from 'vitest'
import {
  buildTrialSubgraph,
  buildTrialSeedRuntime,
  TRIAL_VIRTUAL_START_ID,
} from './trial-subgraph.js'
import type { FlowData, FlowNode } from '../types/flow.js'

/**
 * 试运行子图裁剪器单测（R10，design-sharp §6.2）：
 * 选中集裁剪——内部边保留/外部边剪除/虚拟 start 合成/externalUpstreams
 * 推导/选中含 start/空选中=全图；seedRuntime 形状（`{id}` 与 `{id}.output`
 * 双键）。
 */

function node(id: string, name: string): FlowNode {
  return { id, type: 'agentflowNode', data: { name } }
}

const linearFlow: FlowData = {
  nodes: [
    node('start', 'startAgentflow'),
    node('a', 'llmAgentflow'),
    node('b', 'llmAgentflow'),
    node('c', 'directReplyAgentflow'),
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'a' },
    { id: 'e2', source: 'a', target: 'b' },
    { id: 'e3', source: 'b', target: 'c' },
  ],
}

describe('buildTrialSubgraph', () => {
  it('scope 为 null/空 = 全图原样返回，零外部上游', () => {
    for (const scope of [null, undefined, { nodeIds: [] }]) {
      const r = buildTrialSubgraph(linearFlow, scope)
      expect(r.flowData).toBe(linearFlow)
      expect(r.externalUpstreams).toEqual([])
    }
  })

  it('单节点选中：合成虚拟 start + externalUpstreams 推导', () => {
    const r = buildTrialSubgraph(linearFlow, { nodeIds: ['b'] })
    const ids = r.flowData.nodes.map((n) => n.id)
    expect(ids).toEqual(['b', TRIAL_VIRTUAL_START_ID])
    // 虚拟 start 是 startAgentflow，向选中节点连一条边
    const vs = r.flowData.nodes.find((n) => n.id === TRIAL_VIRTUAL_START_ID)!
    expect(vs.data.name).toBe('startAgentflow')
    expect(r.flowData.edges).toEqual([
      { id: `__trial_edge_b`, source: TRIAL_VIRTUAL_START_ID, target: 'b' },
    ])
    // b 的入边 source a 不在选中集 → 外部上游
    expect(r.externalUpstreams).toEqual(['a'])
  })

  it('中间段选中：内部边保留、跨界边剪除、多个外部上游去重', () => {
    const flow: FlowData = {
      nodes: [
        node('start', 'startAgentflow'),
        node('x', 'llmAgentflow'),
        node('y', 'llmAgentflow'),
        node('mid', 'llmAgentflow'),
        node('z', 'directReplyAgentflow'),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'x' },
        { id: 'e2', source: 'x', target: 'mid' },
        { id: 'e3', source: 'y', target: 'mid' },
        { id: 'e4', source: 'mid', target: 'z' },
      ],
    }
    const r = buildTrialSubgraph(flow, { nodeIds: ['mid'] })
    expect(r.flowData.nodes.map((n) => n.id)).toEqual(['mid', TRIAL_VIRTUAL_START_ID])
    expect(r.externalUpstreams).toEqual(['x', 'y'])
  })

  it('选中集含 start：用原 start，不再合成虚拟节点；集内其余节点无入边时由 isStartNode 语义放行（选中即执行意图）', () => {
    const r = buildTrialSubgraph(linearFlow, { nodeIds: ['start', 'b'] })
    const ids = r.flowData.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['b', 'start'])
    expect(r.flowData.nodes.some((n) => n.id === TRIAL_VIRTUAL_START_ID)).toBe(false)
    // start→b 的边两端都在选中集？不在（e1 是 start→a）——集内无边，edges 为空
    expect(r.flowData.edges).toEqual([])
    // b 的原入边 source a 不在选中集 → 仍是外部上游（种子输入区照常渲染）
    expect(r.externalUpstreams).toEqual(['a'])
  })

  it('相邻多节点选中（P1 形状）：两端都在集内的边保留', () => {
    const r = buildTrialSubgraph(linearFlow, { nodeIds: ['b', 'c'] })
    expect(r.flowData.nodes.map((n) => n.id)).toEqual(['b', 'c', TRIAL_VIRTUAL_START_ID])
    expect(r.flowData.edges).toEqual([
      { id: 'e3', source: 'b', target: 'c' },
      { id: '__trial_edge_b', source: TRIAL_VIRTUAL_START_ID, target: 'b' },
    ])
    expect(r.externalUpstreams).toEqual(['a'])
  })

  it('选中集含保留 id __trial_start → 诚实抛错', () => {
    expect(() => buildTrialSubgraph(linearFlow, { nodeIds: [TRIAL_VIRTUAL_START_ID] })).toThrow(
      /__trial_start/,
    )
  })

  it('选中 id 不在图中 → 静默过滤为空 = 全图语义（防手滑全图跑）——显式空选中同款', () => {
    const r = buildTrialSubgraph(linearFlow, { nodeIds: ['nope'] })
    expect(r.flowData).toBe(linearFlow)
    expect(r.externalUpstreams).toEqual([])
  })

  it('迭代控制器在选中集内：闭包提取以裁剪图为 scope（body 只含选中集内可达部分）', () => {
    const flow: FlowData = {
      nodes: [
        node('start', 'startAgentflow'),
        node('it', 'iterationAgentflow'),
        node('body1', 'llmAgentflow'),
        node('body2', 'llmAgentflow'),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'it' },
        { id: 'e2', source: 'it', target: 'body1', sourceHandle: 'iteration' },
        { id: 'e3', source: 'body1', target: 'body2' },
      ],
    }
    const r = buildTrialSubgraph(flow, { nodeIds: ['it', 'body1'] })
    expect(r.flowData.nodes.map((n) => n.id)).toEqual(['it', 'body1', TRIAL_VIRTUAL_START_ID])
    expect(r.flowData.edges).toEqual([
      { id: 'e2', source: 'it', target: 'body1', sourceHandle: 'iteration' },
      { id: '__trial_edge_it', source: TRIAL_VIRTUAL_START_ID, target: 'it' },
    ])
    expect(r.externalUpstreams).toEqual(['start'])
  })
})

describe('buildTrialSeedRuntime', () => {
  it('外部上游种子注入 `{id}` 与 `{id}.output` 双形态（对齐引擎注册约定）', () => {
    const runtime = buildTrialSeedRuntime(['a', 'b'], { a: 'A 的种子', b: '' })
    expect(runtime).toEqual({
      a: { content: 'A 的种子', output: { content: 'A 的种子' } },
      b: { content: '', output: { content: '' } },
    })
    // 双形态可解析：顶层键挂 content，嵌套 output.content 同源
    expect((runtime.a as Record<string, unknown>).content).toBe('A 的种子')
    expect((runtime.a as { output: { content: string } }).output.content).toBe('A 的种子')
  })

  it('空上游列表 / 空手填 → 空 runtime 对象', () => {
    expect(buildTrialSeedRuntime([], {})).toEqual({})
    expect(buildTrialSeedRuntime(['a'], {})).toEqual({
      a: { content: '', output: { content: '' } },
    })
  })
})
