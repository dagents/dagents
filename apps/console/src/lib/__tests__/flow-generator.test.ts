/**
 * flow-generator lib tests — pure-function coverage for the agentflow
 * GenerateFlowDialog backend (chatmodels mapping + generate normalization).
 */
import { describe, it, expect } from 'vitest'
import {
  listChatModels,
  resolveProvider,
  extractJson,
  normalizeGeneratedFlow,
  buildAgentPrompt,
  isAgentModel,
  AGENT_MODEL_PREFIX,
  FALLBACK_MODEL,
  type ProviderLike,
} from '../flow-generator'

const PROVIDERS: ProviderLike[] = [
  {
    id: 'p1',
    name: 'OpenAI 兼容',
    providerType: 'openai',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    status: 'active',
  },
  {
    id: 'p2',
    name: '无模型 Provider',
    providerType: 'anthropic',
    defaultModel: null,
    models: [],
    status: 'inactive',
  },
]

describe('listChatModels', () => {
  it('maps provider models to providerId::model entries', () => {
    const models = listChatModels(PROVIDERS)
    expect(models.map((m) => m.name)).toEqual(['p1::gpt-4o-mini', 'p1::gpt-4o'])
    expect(models[0]!.label).toContain('OpenAI 兼容')
    expect(models[0]!.label).toContain('gpt-4o-mini')
  })

  it('uses defaultModel when the models array is empty', () => {
    const models = listChatModels([{ id: 'p3', name: 'D', defaultModel: 'x1', models: [] }])
    expect(models).toHaveLength(1)
    expect(models[0]!.name).toBe('p3::x1')
  })

  it('falls back to the default entry when nothing is configured', () => {
    expect(listChatModels([])).toEqual([FALLBACK_MODEL])
  })

  it('appends platform agents as agent:: entries after provider models', () => {
    const models = listChatModels(
      [{ id: 'p1', name: 'P', defaultModel: 'm1', models: ['m1'], status: 'active' }],
      [
        { id: 'a1', name: '论文阅读', kind: 'claude' },
        { id: 'a2', name: '网页抓取', kind: 'remote' },
      ],
    )
    expect(models.map((m) => m.name)).toEqual(['p1::m1', 'agent::a1', 'agent::a2'])
    expect(models[1]!.label).toBe('论文阅读 · Agent')
    expect(models[1]!.category).toBe('agent')
  })

  it('lists agents alone when no provider is configured', () => {
    const models = listChatModels([], [{ id: 'a1', name: 'X', kind: 'claude' }])
    expect(models).toHaveLength(1)
    expect(models[0]!.name).toBe('agent::a1')
  })
})

describe('isAgentModel', () => {
  it('matches agent:: prefixed names only', () => {
    expect(isAgentModel(`${AGENT_MODEL_PREFIX}abc`)).toBe(true)
    expect(isAgentModel('p1::gpt-4o')).toBe(false)
    expect(isAgentModel('gateway-default')).toBe(false)
    expect(isAgentModel(undefined)).toBe(false)
  })
})

describe('buildAgentPrompt', () => {
  it('combines the generator instructions with the question in one prompt', () => {
    const prompt = buildAgentPrompt('构建一个搜索流程')
    expect(prompt).toContain('AgentFlow 编排专家')
    expect(prompt).toContain('startAgentflow')
    // 指令在前、需求在末尾（提示词首行也含"用户需求"字样，用 lastIndexOf 断言顺序）
    expect(prompt.lastIndexOf('用户需求：构建一个搜索流程')).toBeGreaterThan(prompt.indexOf('只输出 JSON'))
  })
})

describe('resolveProvider', () => {
  it('resolves providerId::model back to the provider', () => {
    const r = resolveProvider(PROVIDERS, 'p1::gpt-4o')
    expect(r?.provider.id).toBe('p1')
    expect(r?.model).toBe('gpt-4o')
  })

  it('gateway-default / unknown name → first active provider with its default model', () => {
    const r = resolveProvider(PROVIDERS, 'gateway-default')
    expect(r?.provider.id).toBe('p1')
    expect(r?.model).toBe('gpt-4o-mini')
  })

  it('returns null with no providers', () => {
    expect(resolveProvider([], undefined)).toBeNull()
  })
})

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

describe('normalizeGeneratedFlow', () => {
  it('coerces common type aliases and passes canonical types through', () => {
    const flow = normalizeGeneratedFlow({
      nodes: [
        { id: 'n1', type: 'start', position: { x: 0, y: 0 } },
        { id: 'n2', type: 'agentAgentflow', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    })
    expect(flow.nodes.map((n) => n.type)).toEqual(['startAgentflow', 'agentAgentflow'])
    expect(flow.edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2', type: 'agentflowEdge' }])
  })

  it('drops unknown-type nodes and edges that reference them', () => {
    const flow = normalizeGeneratedFlow({
      nodes: [
        { id: 'n1', type: 'startAgentflow', position: { x: 0, y: 0 } },
        { id: 'bad', type: 'totallyUnknownNode', position: { x: 1, y: 1 } },
      ],
      edges: [
        { source: 'n1', target: 'bad' },
        { source: 'bad', target: 'n1' },
      ],
    })
    expect(flow.nodes).toHaveLength(1)
    expect(flow.edges).toHaveLength(0)
  })

  it('fills grid positions, object data, and unique ids for sparse nodes', () => {
    const flow = normalizeGeneratedFlow({
      nodes: [{ type: 'llmAgentflow' }, { id: 'n1', type: 'llmAgentflow', data: 'not-an-object' }],
    })
    expect(flow.nodes[0]!.position).toEqual({ x: 0, y: 0 })
    expect(flow.nodes[1]!.position.x).toBe(300)
    expect(flow.nodes[0]!.id).toBe('n1')
    expect(flow.nodes[1]!.id).not.toBe('n1') // de-duplicated
    expect(flow.nodes.every((n) => typeof n.data === 'object' && n.data !== null && !Array.isArray(n.data))).toBe(true)
  })

  it('returns empty arrays for non-object LLM output', () => {
    expect(normalizeGeneratedFlow(null)).toEqual({ nodes: [], edges: [] })
    expect(normalizeGeneratedFlow('hello')).toEqual({ nodes: [], edges: [] })
  })
})
