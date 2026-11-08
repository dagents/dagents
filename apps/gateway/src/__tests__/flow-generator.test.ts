/**
 * flow-generator tests — the unified AI generation pipeline (A1/A2/A5).
 *
 * Covers the pure extraction/normalization helpers (moved here from the
 * console BFF) plus the generateFlow orchestration with injected deps:
 * first-pass success, repair round rescue, EXPLICIT validation failure
 * (the old silent three-node fallback is gone), and engine errors.
 * Every outcome must land in generator_attempts telemetry.
 */
import { describe, it, expect } from 'vitest'
import {
  extractJson,
  normalizeToCanonicalFlow,
  parseSelectedModel,
  buildWorkflowGeneratorPrompt,
  buildRepairInstruction,
  combineEngineFailure,
  generateFlow,
  type GenerateDeps,
  type GeneratorAttemptRow,
} from '../routes/flow-generator.js'

// ── fixtures ──────────────────────────────────────────────────────────────

/** A flow that passes topology validation on the first try. */
function validFlowJson() {
  return {
    nodes: [
      {
        id: 'node_1',
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: { name: 'startAgentflow', label: 'Start' },
      },
      {
        id: 'node_2',
        type: 'customNode',
        position: { x: 250, y: 0 },
        data: { name: 'llmAgentflow', label: 'LLM', model: '', systemPrompt: 'x' },
      },
      {
        id: 'node_3',
        type: 'customNode',
        position: { x: 500, y: 0 },
        data: { name: 'directReplyAgentflow', label: 'Reply', content: 'ok' },
      },
    ],
    edges: [
      { id: 'e1', source: 'node_1', target: 'node_2' },
      { id: 'e2', source: 'node_2', target: 'node_3' },
    ],
  }
}

/** Missing the mandatory startAgentflow — fails validation, repair can't fix. */
function startlessFlowJson() {
  return {
    nodes: [
      {
        id: 'node_1',
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: { name: 'llmAgentflow', label: 'LLM' },
      },
      {
        id: 'node_2',
        type: 'customNode',
        position: { x: 250, y: 0 },
        data: { name: 'directReplyAgentflow', label: 'Reply', content: '' },
      },
    ],
    edges: [{ id: 'e1', source: 'node_1', target: 'node_2' }],
  }
}

function makeDeps(overrides: Partial<GenerateDeps> = {}) {
  const attempts: GeneratorAttemptRow[] = []
  const deps: GenerateDeps = {
    loadAgents: async () => [],
    loadSkills: async () => [],
    callEngine: async () => ({ text: JSON.stringify(validFlowJson()), engineUsed: 'test-engine' }),
    recordAttempt: async (a) => {
      attempts.push(a)
    },
    ...overrides,
  }
  return { deps, attempts }
}

// ── extractJson ───────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('strips markdown fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('finds JSON embedded in prose', () => {
    expect(extractJson('好的，这是流程：{"nodes":[]} 希望有帮助')).toEqual({ nodes: [] })
  })

  it('throws when no JSON is present', () => {
    expect(() => extractJson('完全没有 JSON')).toThrow()
  })
})

// ── normalizeToCanonicalFlow ──────────────────────────────────────────────

describe('normalizeToCanonicalFlow', () => {
  it('coerces vendor/alias types into canonical customNode + data.name', () => {
    const { flowData } = normalizeToCanonicalFlow({
      nodes: [
        { id: 'n1', type: 'start', position: { x: 0, y: 0 } },
        { id: 'n2', type: 'agent', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    })
    // D8：agent 别名映射 llm（零依赖可跑），loop 映射 iteration（保留的循环原语）
    expect(flowData.nodes.map((n) => n.data.name)).toEqual(['startAgentflow', 'llmAgentflow'])
    expect(flowData.nodes.every((n) => n.type === 'customNode')).toBe(true)
    expect(flowData.edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2' }])
  })

  it('passes canonical customNode + data.name input through', () => {
    const { flowData, droppedNodes } = normalizeToCanonicalFlow(validFlowJson())
    expect(droppedNodes).toEqual([])
    expect(flowData.nodes).toHaveLength(3)
    expect(flowData.nodes[0]!.data.name).toBe('startAgentflow')
  })

  it('drops unknown-type nodes (reported) and their dangling edges', () => {
    const { flowData, droppedNodes } = normalizeToCanonicalFlow({
      nodes: [
        { id: 'n1', type: 'startAgentflow', position: { x: 0, y: 0 } },
        { id: 'bad', type: 'totallyUnknownNode', position: { x: 1, y: 1 } },
      ],
      edges: [
        { source: 'n1', target: 'bad' },
        { source: 'bad', target: 'n1' },
      ],
    })
    expect(flowData.nodes).toHaveLength(1)
    expect(flowData.edges).toHaveLength(0)
    expect(droppedNodes).toEqual(['bad'])
  })

  it('fills grid positions, object data, unique ids, and keeps handle fields', () => {
    const { flowData } = normalizeToCanonicalFlow({
      nodes: [
        { id: 'n1', type: 'llmAgentflow' },
        { id: 'n1', type: 'llmAgentflow', data: 'not-an-object' }, // duplicate id
      ],
      edges: [{ source: 'n1', target: 'n1_1', sourceHandle: 'true', targetHandle: 'in' }],
    })
    expect(flowData.nodes[0]!.position).toEqual({ x: 0, y: 0 })
    expect(flowData.nodes[1]!.position!.x).toBe(300)
    expect(flowData.nodes[0]!.id).toBe('n1')
    expect(flowData.nodes[1]!.id).not.toBe('n1') // de-duplicated
    expect(flowData.edges[0]!.sourceHandle).toBe('true')
    expect(flowData.edges[0]!.targetHandle).toBe('in')
    expect(flowData.nodes.every((n) => typeof n.data === 'object' && !Array.isArray(n.data))).toBe(
      true,
    )
  })

  it('returns empty arrays for non-object LLM output', () => {
    expect(normalizeToCanonicalFlow(null).flowData).toEqual({ nodes: [], edges: [] })
    expect(normalizeToCanonicalFlow('hello').flowData).toEqual({ nodes: [], edges: [] })
  })
})

// ── parseSelectedModel ────────────────────────────────────────────────────

describe('parseSelectedModel', () => {
  it('maps agent::<id> to the agent engine', () => {
    expect(parseSelectedModel('agent::abc-123')).toEqual({ kind: 'agent', agentId: 'abc-123' })
  })

  it('maps providerId::model to the provider engine', () => {
    expect(parseSelectedModel('p1::gpt-4o')).toEqual({
      kind: 'provider',
      providerId: 'p1',
      model: 'gpt-4o',
    })
  })

  it('maps gateway-default / undefined / empty agent:: to auto (CLI-first baseline)', () => {
    expect(parseSelectedModel('gateway-default')).toEqual({ kind: 'auto' })
    expect(parseSelectedModel(undefined)).toEqual({ kind: 'auto' })
    expect(parseSelectedModel('agent::')).toEqual({ kind: 'auto' })
  })
})

// ── buildRepairInstruction ────────────────────────────────────────────────

describe('buildRepairInstruction', () => {
  it('numbers every error and demands JSON-only output', () => {
    const text = buildRepairInstruction(['缺少 start 节点', '[n2] 边引用不存在的节点'])
    expect(text).toContain('1. 缺少 start 节点')
    expect(text).toContain('2. [n2] 边引用不存在的节点')
    expect(text).toContain('只输出 JSON')
  })
})

// ── generateFlow orchestration ────────────────────────────────────────────

describe('generateFlow', () => {
  it('first-pass success: no repair, success telemetry, canonical flowData', async () => {
    const { deps, attempts } = makeDeps()
    const result = await generateFlow(
      { userDesc: '三步开发流', source: 'chat', chatId: undefined },
      deps,
    )

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.repairRounds).toBe(0)
      expect(result.engineUsed).toBe('test-engine')
      expect(result.flowData.nodes[0]!.data.name).toBe('startAgentflow')
    }
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.outcome).toBe('success')
    expect(attempts[0]!.repairRounds).toBe(0)
  })

  it('relayouts overlapping engine coordinates into a non-overlapping topology layout', async () => {
    // LLM 典型坏输出：分叉节点全挤在同一 y=0 —— 修复前会原样透传到画布叠放
    const stacked = {
      nodes: [
        {
          id: 'node_1',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'startAgentflow', label: 'Start' },
        },
        {
          id: 'node_2',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'llmAgentflow', label: 'A', model: '', systemPrompt: 'x' },
        },
        {
          id: 'node_3',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'llmAgentflow', label: 'B', model: '', systemPrompt: 'y' },
        },
        {
          id: 'node_4',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'directReplyAgentflow', label: 'Reply', content: 'ok' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node_1', target: 'node_2' },
        { id: 'e2', source: 'node_1', target: 'node_3' },
        { id: 'e3', source: 'node_2', target: 'node_4' },
        { id: 'e4', source: 'node_3', target: 'node_4' },
      ],
    }
    const { deps } = makeDeps({
      callEngine: async () => ({ text: JSON.stringify(stacked), engineUsed: 'test-engine' }),
    })
    const result = await generateFlow({ userDesc: '分叉流', source: 'canvas' }, deps)

    expect(result.status).toBe('success')
    if (result.status !== 'success') return
    const positions = result.flowData.nodes.map((n) => n.position!)
    // 无重叠不变量：任意两节点横向 ≥ 360 或纵向 ≥ 150（画布节点 280×80 物理放不下）
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = Math.abs(positions[i]!.x - positions[j]!.x)
        const dy = Math.abs(positions[i]!.y - positions[j]!.y)
        expect(dx >= 360 || dy >= 150).toBe(true)
      }
    }
    // 菱形拓扑：两个分支对称张开、汇合点回中轴
    const byId = new Map(result.flowData.nodes.map((n) => [n.id, n.position!]))
    expect(byId.get('node_2')!.y).toBe(-75)
    expect(byId.get('node_3')!.y).toBe(75)
    expect(byId.get('node_4')!.y).toBe(0)
  })

  it('repair round rescues a broken first output', async () => {
    const outputs = ['这不是 JSON', JSON.stringify(validFlowJson())]
    let call = 0
    const calls: unknown[][] = []
    const { deps, attempts } = makeDeps({
      callEngine: async (_engine, messages) => {
        calls.push(messages)
        return { text: outputs[call++]!, engineUsed: 'test-engine' }
      },
    })

    const result = await generateFlow({ userDesc: '修一下', source: 'chat' }, deps)

    expect(result.status).toBe('success')
    if (result.status === 'success') expect(result.repairRounds).toBe(1)
    // The repair call carries the failed output + the error list back to the engine
    expect(calls).toHaveLength(2)
    const repairMessages = calls[1]! as { role: string; content: string }[]
    expect(repairMessages.some((m) => m.role === 'assistant')).toBe(true)
    expect(repairMessages.some((m) => m.content.includes('未通过平台校验'))).toBe(true)
    expect(attempts[0]!.repairRounds).toBe(1)
    expect(attempts[0]!.outcome).toBe('success')
  })

  it('validation failure is EXPLICIT — no silent fallback flow, errors listed, telemetry recorded', async () => {
    const { deps, attempts } = makeDeps({
      callEngine: async () => ({
        text: JSON.stringify(startlessFlowJson()),
        engineUsed: 'test-engine',
      }),
    })

    const result = await generateFlow({ userDesc: '没有 start 的流', source: 'chat' }, deps)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stage).toBe('validation')
      expect(result.repairRounds).toBe(1) // one repair round attempted
      expect(result.validationErrors!.length).toBeGreaterThan(0)
    }
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.outcome).toBe('failed_validation')
    expect(attempts[0]!.validationErrors.length).toBeGreaterThan(0)
  })

  it('alias output is rescued by normalization (start → startAgentflow passes validation)', async () => {
    const aliased = {
      nodes: [
        { id: 'n1', type: 'start' },
        { id: 'n2', type: 'directreply' },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    }
    const { deps } = makeDeps({
      callEngine: async () => ({
        text: '```json\n' + JSON.stringify(aliased) + '\n```',
        engineUsed: 'cli',
      }),
    })
    const result = await generateFlow({ userDesc: '别名测试', source: 'canvas' }, deps)
    expect(result.status).toBe('success')
  })

  it('engine error → stage llm with llm_error telemetry', async () => {
    const { deps, attempts } = makeDeps({
      callEngine: async () => {
        throw new Error('spawn failed: claude not found')
      },
    })
    const result = await generateFlow({ userDesc: 'x', source: 'chat' }, deps)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stage).toBe('llm')
      expect(result.error).toContain('claude not found')
    }
    expect(attempts[0]!.outcome).toBe('llm_error')
    expect(attempts[0]!.engine).toBe('n/a')
  })
})

// ── combineEngineFailure ──────────────────────────────────────────────────

describe('combineEngineFailure', () => {
  it('leads with the CLI root cause and appends the HTTP fallback error', () => {
    const err = combineEngineFailure(
      new Error(
        'CLI agent 未完成（failed）：API Error: Unable to connect to API (ConnectionRefused)',
      ),
      new Error('No active LLM provider configured. Add one in the LLM Providers settings.'),
    )
    expect(err.message).toBe(
      'CLI 生成失败：CLI agent 未完成（failed）：API Error: Unable to connect to API (ConnectionRefused)' +
        '；HTTP 兜底也不可用：No active LLM provider configured. Add one in the LLM Providers settings.',
    )
  })

  it('strips the redundant "Error: " prefix from both messages', () => {
    const err = combineEngineFailure(new Error('a'), new Error('b'))
    expect(err.message.startsWith('CLI 生成失败：a；')).toBe(true)
    expect(err.message).not.toContain('Error:')
  })
})

// ── R4 权限声明 · 生成器半边（2026-10-08 测试补齐，AC-R4-6）────────────────
// 钉「模板中心与生成器产物全量带声明」的三段链条：prompt 教 LLM 产出声明 →
// normalize 保真透传（不丢字段）→ 声明非法进修复轮（校验器强制而非自觉）。

describe('R4 权限声明（生成器半边）', () => {
  it('prompt 规则教 LLM 产出声明：http 节点 allowedDomains + customFunction $exec 白名单（§3.4.1）', () => {
    const prompt = buildWorkflowGeneratorPrompt('测试描述', [], [])
    // http 节点域名清单规则（请求与重定向都受清单约束）
    expect(prompt).toContain('httpAgentflow')
    expect(prompt).toContain('data.inputs.allowedDomains')
    expect(prompt).toMatch(/redirects are rejected on any other host/)
    // customFunction $exec 白名单规则（缺席 = 通道不可用）
    expect(prompt).toContain('data.inputs.allowedCommands')
    expect(prompt).toContain('$exec() is unavailable without it')
  })

  it('normalizeToCanonicalFlow 保真透传权限声明（§3.4.2 ...data 展开钉子——平铺形态）', () => {
    const raw = {
      nodes: [
        { id: 'node_1', type: 'customNode', data: { name: 'startAgentflow', label: 'Start' } },
        {
          id: 'node_2',
          type: 'customNode',
          data: {
            name: 'httpAgentflow',
            label: '查 API',
            url: 'https://api.github.com/x',
            allowedDomains: ['api.github.com'],
          },
        },
        {
          id: 'node_3',
          type: 'customNode',
          data: {
            name: 'customFunctionAgentflow',
            label: '跑命令',
            functionCode: 'return 1',
            allowedCommands: ['git', 'rg'],
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'node_1', target: 'node_2' },
        { id: 'e2', source: 'node_2', target: 'node_3' },
      ],
    }
    const { flowData, droppedNodes } = normalizeToCanonicalFlow(raw)
    expect(droppedNodes).toEqual([])
    const http = flowData.nodes.find((n) => n.id === 'node_2')?.data as Record<string, unknown>
    const fn = flowData.nodes.find((n) => n.id === 'node_3')?.data as Record<string, unknown>
    // 逐字保真：改名/丢字段 = 生成产物声明静默蒸发（下游守卫拒跑 / $exec 消失）
    expect(http.allowedDomains).toEqual(['api.github.com'])
    expect(fn.allowedCommands).toEqual(['git', 'rg'])
  })

  it('嵌套 data.inputs 形态的声明同样保真（AI 常给嵌套形态）', () => {
    const raw = {
      nodes: [
        { id: 'node_1', type: 'customNode', data: { name: 'startAgentflow', label: 'Start' } },
        {
          id: 'node_2',
          type: 'customNode',
          data: {
            name: 'httpAgentflow',
            label: 'H',
            inputs: { url: 'https://api.test/x', allowedDomains: ['api.test'] },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'node_1', target: 'node_2' }],
    }
    const { flowData } = normalizeToCanonicalFlow(raw)
    const http = flowData.nodes.find((n) => n.id === 'node_2')?.data as {
      inputs?: Record<string, unknown>
    }
    expect(http.inputs?.allowedDomains).toEqual(['api.test'])
  })

  it('修复循环吃声明错误：invalid allowedDomains → repair 轮收到声明错误 → 修正后成功（§3.4.4）', async () => {
    const withDeclaration = (domains: unknown) => ({
      nodes: [
        {
          id: 'node_1',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'startAgentflow', label: 'Start' },
        },
        {
          id: 'node_2',
          type: 'customNode',
          position: { x: 250, y: 0 },
          data: {
            name: 'httpAgentflow',
            label: '查 API',
            url: 'https://api.github.com/x',
            allowedDomains: domains,
          },
        },
        {
          id: 'node_3',
          type: 'customNode',
          position: { x: 500, y: 0 },
          data: { name: 'directReplyAgentflow', label: 'Reply', content: 'ok' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node_1', target: 'node_2' },
        { id: 'e2', source: 'node_2', target: 'node_3' },
      ],
    })
    // 首产物：声明写成非数组（invalid）；修复产物：合法数组。拓扑本身合法
    // ——第一轮唯一 error 是权限声明（生成侧「全量带声明」由校验器强制）
    const outputs = [
      JSON.stringify(withDeclaration('api.github.com')),
      JSON.stringify(withDeclaration(['api.github.com'])),
    ]
    let call = 0
    const calls: { role: string; content: string }[][] = []
    const { deps, attempts } = makeDeps({
      callEngine: async (_engine, messages) => {
        calls.push(messages as { role: string; content: string }[])
        return { text: outputs[call++]!, engineUsed: 'test-engine' }
      },
    })

    const result = await generateFlow({ userDesc: '查仓库', source: 'chat' }, deps)

    expect(result.status).toBe('success')
    if (result.status === 'success') expect(result.repairRounds).toBe(1)
    // repair 指令携带的是**声明错误**（错误文案含 allowedDomains 字面量）
    expect(calls).toHaveLength(2)
    const repairContent = calls[1]!.map((m) => m.content).join('\n')
    expect(repairContent).toContain('allowedDomains 声明非法')
    expect(attempts[0]!.outcome).toBe('success')
    // 最终产物的声明逐字保留
    if (result.status === 'success') {
      const http = result.flowData.nodes.find((n) => n.id === 'node_2')?.data as Record<
        string,
        unknown
      >
      expect(http.allowedDomains).toEqual(['api.github.com'])
    }
  })
})
