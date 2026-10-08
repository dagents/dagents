import { describe, it, expect } from 'vitest'
import { validateFlowTopology } from './validate-topology.js'
import { allNodes } from '../nodes/index.js'

/** AI-generated shape: registry name in `type`, config flat in `data`. */
function genNode(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, data }
}

/** Canvas-saved shape: registry name in `data.name`, `type` is a React Flow
 * render type the engine never reads. */
function canvasNode(id: string, name: string, data: Record<string, unknown> = {}) {
  return { id, type: 'agentflowNode', position: { x: 0, y: 0 }, data: { name, ...data } }
}

describe('validateFlowTopology', () => {
  it('accepts a valid small DAG (generator shape) with no warnings', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow', { variables: {} }),
        genNode('llm', 'llmAgentflow', { model: 'gpt-4', prompt: 'hi' }),
        genNode('reply', 'directReplyAgentflow', { text: 'done' }),
      ],
      edges: [
        { source: 'start', target: 'llm' },
        { source: 'llm', target: 'reply' },
      ],
    })
    expect(result).toEqual({
      ok: true,
      data: {
        nodes: [
          genNode('start', 'startAgentflow', { variables: {} }),
          genNode('llm', 'llmAgentflow', { model: 'gpt-4', prompt: 'hi' }),
          genNode('reply', 'directReplyAgentflow', { text: 'done' }),
        ],
        edges: [
          { id: 'start-llm', source: 'start', target: 'llm' },
          { id: 'llm-reply', source: 'llm', target: 'reply' },
        ],
      },
      warnings: [],
      errors: [],
    })
  })

  it('accepts the canvas shape where the registry name lives in data.name', () => {
    const result = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('agent', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
      ],
      edges: [{ id: 'e1', source: 'start', target: 'agent' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual([])
  })

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'nodes', [], true]) {
      const result = validateFlowTopology(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('errors when nodes is empty', () => {
    const result = validateFlowTopology({ nodes: [], edges: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/no nodes/)
  })

  it('errors when no startAgentflow node exists', () => {
    const result = validateFlowTopology({
      nodes: [genNode('llm', 'llmAgentflow'), genNode('reply', 'directReplyAgentflow')],
      edges: [{ source: 'llm', target: 'reply' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.message).toMatch(/startAgentflow/)
    }
  })

  // ── cycle detection（2026-09-22：生成器曾产出 condition 回边环，DAG 引擎
  //    9ms 内零 span 失败且无任何可检视痕迹 —— 环必须在生成校验门拦下）──

  it('errors on a condition back-edge cycle and names the offending path', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('fix', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
        genNode('test', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
        genNode('cond', 'conditionAgentflow'),
        genNode('done', 'directReplyAgentflow', { content: 'ok' }),
      ],
      edges: [
        { source: 'start', target: 'fix' },
        { source: 'fix', target: 'test' },
        { source: 'test', target: 'cond' },
        { source: 'cond', target: 'fix' }, // 「直到修完」回边 → 环
        { source: 'cond', target: 'done' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => /cycle detected/.test(e.message))
      expect(cycleErr).toBeDefined()
      expect(cycleErr?.message).toMatch(/iterationAgentflow/) // 修复指引在错误里
      expect(cycleErr?.message).toMatch(/fix → test → cond → fix|cond → fix → test → cond/)
    }
  })

  it('names a true cycle when the residual walk meets a tail dead-end first', () => {
    // 环 a→b→a + 环外尾巴 b→c，且 b 的出边序把 c 排在 a 前 —— 不剪枝的
    // 游走会先踏进尾巴死胡同，cur 落 undefined 产出垃圾路径
    // （架构 review 2026-09-23 不符合 2）。
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('a', 'llmAgentflow'),
        genNode('b', 'llmAgentflow'),
        genNode('c', 'directReplyAgentflow'),
      ],
      edges: [
        { source: 'start', target: 'a' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' }, // 边序陷阱：尾巴先行
        { source: 'b', target: 'a' }, // 回边成环
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => /cycle detected/.test(e.message))
      expect(cycleErr).toBeDefined()
      expect(cycleErr?.node).toBe('a') // 具名路径首节点在环上，不是 undefined
      expect(cycleErr?.message).toMatch(/cycle detected \(a → b → a\)/)
    }
  })

  it('errors on a self-loop', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('a', 'llmAgentflow')],
      edges: [
        { source: 'start', target: 'a' },
        { source: 'a', target: 'a' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => /cycle detected \(a → a\)/.test(e.message))).toBe(true)
    }
  })

  it('accepts a fork/join DAG (no cycle) and a bounded iteration body', () => {
    const dag = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('iter', 'iterationAgentflow', { inputs: { items: '[1, 2, 3]' } }),
        genNode('body', 'llmAgentflow'),
        genNode('join', 'directReplyAgentflow', { content: 'done' }),
      ],
      edges: [
        { source: 'start', target: 'iter' },
        { source: 'iter', target: 'body' },
        { source: 'body', target: 'join' },
      ],
    })
    expect(dag.ok).toBe(true)
  })

  it('errors when multiple startAgentflow nodes exist', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('s1', 'startAgentflow'),
        genNode('s2', 'startAgentflow'),
        genNode('llm', 'llmAgentflow'),
      ],
      edges: [
        { source: 's1', target: 'llm' },
        { source: 's2', target: 'llm' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/s1.*s2/)
  })

  it('errors on edges referencing missing node ids', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('llm', 'llmAgentflow')],
      edges: [{ id: 'e1', source: 'start', target: 'ghost' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.edge).toBe('e1')
      expect(result.errors[0]?.message).toMatch(/ghost/)
    }
  })

  it('errors on unknown node types', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('x', 'bananaAgentflow')],
      edges: [{ source: 'start', target: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.node).toBe('x')
      expect(result.errors[0]?.message).toMatch(/bananaAgentflow/)
    }
  })

  it('errors on nodes with no type at all', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), { id: 'x', data: {} }],
      edges: [{ source: 'start', target: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.node).toBe('x')
  })

  it('accepts every registered node type', () => {
    // Guards the whitelist derivation: every name in the registry assembly
    // must validate, so adding a node type never breaks existing flows.
    const nodes = allNodes().map((node, i) => genNode(`n${i}`, node.name))
    const edges = nodes.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id }))
    const result = validateFlowTopology({ nodes, edges })
    expect(result.ok).toBe(true)
  })

  it('warns on orphan nodes but keeps the flow runnable', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('llm', 'llmAgentflow'),
        genNode('orphan', 'httpAgentflow', { url: 'https://example.com' }),
      ],
      edges: [{ source: 'start', target: 'llm' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([
        { node: 'orphan', message: expect.stringMatching(/orphan/) },
      ])
    }
  })

  it('does not warn for a lone node or an unconnected start node', () => {
    expect(validateFlowTopology({ nodes: [genNode('only', 'startAgentflow')] })).toEqual({
      ok: true,
      data: { nodes: [genNode('only', 'startAgentflow')], edges: [] },
      warnings: [],
      errors: [],
    })

    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('llm', 'llmAgentflow')],
      edges: [],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Missing edges default to [] — everything except the start node is orphaned.
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]?.node).toBe('llm')
    }
  })

  it('platformAgent 缺 agentId（平铺/嵌套/空白）= repairable 档：进 errors 但 ok 不变（2026-10-07 R9c 升档）', () => {
    const missing = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { systemPrompt: 'work' }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    // repairable 不改变 ok 性（不阻断保存，AC-R9-4）
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.errors).toHaveLength(1)
      expect(missing.errors[0]?.node).toBe('pa')
      expect(missing.errors[0]?.severity).toBe('repairable')
      expect(missing.errors[0]?.repair).toContain('Inspector')
      expect(missing.warnings).toEqual([])
    }

    const blank = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('pa', 'platformAgentAgentflow', { agentId: '  ' }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(blank.ok).toBe(true)
    if (blank.ok) expect(blank.errors[0]?.node).toBe('pa')

    const nested = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('pa', 'platformAgentAgentflow', { inputs: { agentId: '' } }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(nested.ok).toBe(true)
    if (nested.ok) expect(nested.errors[0]?.node).toBe('pa')
  })

  it('repairable 与 error 同数组全量返回、互不遮蔽（AC-R9-4 前半）', () => {
    // 同一 flow：成环（error）+ platformAgent 缺 agentId（repairable）
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow'),
        genNode('a', 'llmAgentflow'),
        genNode('b', 'llmAgentflow'),
      ],
      edges: [
        { source: 'start', target: 'pa' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => /cycle/.test(e.message))
      const repairable = result.errors.find((e) => e.severity === 'repairable')
      expect(cycleErr).toBeDefined()
      expect(cycleErr?.severity ?? 'error').toBe('error')
      expect(repairable?.node).toBe('pa')
      expect(repairable?.repair).toBeTruthy()
    }
  })

  it('模板占位符引用未知名 → repairable 带定位与指引；已知根键零误报', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('up', 'llmAgentflow', { prompt: 'upstream' }),
        genNode('llm', 'llmAgentflow', {
          prompt:
            '上游说：{{up.content}}；别名：{{$start.input}}；迭代：{{iterationItem}}；流程：{{$flow.chatId}}；预供：{{humanInputs.x}}；未知：{{ghostRef.field}}',
        }),
      ],
      edges: [
        { source: 'start', target: 'up' },
        { source: 'up', target: 'llm' },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const ph = result.errors.find((e) => /unknown template variable/.test(e.message))
      expect(ph).toBeDefined()
      expect(ph?.node).toBe('llm')
      expect(ph?.severity).toBe('repairable')
      expect(ph?.message).toContain('ghostRef')
      // 已知根键（up/别名/迭代/flow/humanInputs）不进未知列表
      expect(ph?.message).not.toContain('iterationItem')
      expect(ph?.message).not.toContain('humanInputs')
    }
  })

  it('does not warn when agentId is set (flat or nested)', () => {
    const flat = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(flat.ok).toBe(true)
    if (flat.ok) expect(flat.warnings).toEqual([])

    const nested = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { inputs: { agentId: 'uuid-2' } }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(nested.ok).toBe(true)
    if (nested.ok) expect(nested.warnings).toEqual([])
  })

  it('maps shape failures to errors, attaching the offending node id', () => {
    const result = validateFlowTopology({
      nodes: [{ id: 'n1', type: 'startAgentflow', data: 'not an object' }],
      edges: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.node).toBe('n1')
      expect(result.errors[0]?.message).toMatch(/invalid flow data/)
    }
  })

  // ── R4 权限声明规则（2026-10-07，AC-R4-3）─────────────────────────────
  // 非法声明 = error（不可执行，与环检测同体验：错误带 node 定位 → 画布标红）；
  // 缺席/合法声明不产生任何诊断（缺席策略由运行期网关策略裁决）。

  it('域名格式错 / 白名单非数组 → errors 带 node 定位', () => {
    const result = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('h1', 'httpAgentflow', { inputs: { allowedDomains: ['api.test:8080'] } }),
        canvasNode('c1', 'customFunctionAgentflow', { inputs: { allowedCommands: 'oops' } }),
      ],
      edges: [
        { source: 'start', target: 'h1' },
        { source: 'h1', target: 'c1' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const permErrors = result.errors.filter((e) => e.message.includes('allowed'))
      expect(permErrors).toHaveLength(2)
      expect(permErrors[0]?.node).toBe('h1')
      expect(permErrors[0]?.message).toMatch(/allowedDomains 声明非法/)
      expect(permErrors[1]?.node).toBe('c1')
      expect(permErrors[1]?.message).toMatch(/allowedCommands 声明非法/)
    }
  })

  it('条目超限 / 条目非法形状 → errors（fail-closed 拒千条目清单）', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `d${i}.test`)
    const result = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('h1', 'httpAgentflow', { allowedDomains: tooMany }),
        canvasNode('c1', 'customFunctionAgentflow', { allowedCommands: ['ok', 42] }),
      ],
      edges: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.node === 'h1' && /超过上限 32/.test(e.message))).toBe(true)
      expect(result.errors.some((e) => e.node === 'c1' && /条目应为字符串/.test(e.message))).toBe(
        true,
      )
    }
  })

  it('合法声明与缺席 → 零额外诊断（warnings 全量收集原则不破坏）', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow', { variables: {} }),
        genNode('h1', 'httpAgentflow', { url: 'https://api.test', allowedDomains: ['api.test'] }),
        genNode('h2', 'httpAgentflow', { url: 'https://plain.test' }), // 缺席：warn 期放行
        genNode('c1', 'customFunctionAgentflow', {
          functionCode: 'return 1',
          allowedCommands: ['git'],
        }),
        genNode('c2', 'customFunctionAgentflow', { functionCode: 'return 2' }), // 缺席：通道不存在
      ],
      edges: [
        { source: 'start', target: 'h1' },
        { source: 'h1', target: 'h2' },
        { source: 'h2', target: 'c1' },
        { source: 'c1', target: 'c2' },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual([])
  })
})
