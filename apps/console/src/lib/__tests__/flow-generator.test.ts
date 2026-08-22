/**
 * flow-generator lib tests — pure-function coverage for the agentflow
 * GenerateFlowDialog backend. Since A1 (docs/product-plan.md) the generation
 * pipeline itself lives in the gateway; what remains console-side is the
 * chat-model dropdown mapping (extraction/normalization coverage moved to
 * apps/gateway/src/__tests__/flow-generator.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { listChatModels, FALLBACK_MODEL, type ProviderLike } from '../flow-generator'

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
