import { describe, it, expect, vi } from 'vitest'
import { computeCost, MODEL_PRICES, parsePriceOverrides } from '../pricing.js'

describe('MODEL_PRICES baseline', () => {
  it('covers anthropic + openai + deepseek + moonshot + qwen entries', () => {
    for (const model of [
      'claude-sonnet-4-20250514',
      'sonnet',
      'gpt-4o',
      'gpt-4o-mini',
      'deepseek-chat',
      'deepseek-reasoner',
      'moonshot-v1-8k',
      'qwen-max',
      'qwen-plus',
    ]) {
      expect(MODEL_PRICES[model], model).toBeDefined()
      expect(MODEL_PRICES[model].input).toBeGreaterThanOrEqual(0)
      expect(MODEL_PRICES[model].output).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('computeCost', () => {
  it('returns undefined when usage is undefined', () => {
    expect(computeCost(undefined, 'sonnet')).toBeUndefined()
  })

  it('computes cost for known anthropic models', () => {
    // sonnet: $3 / 1M input, $15 / 1M output
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, 'sonnet')).toBeCloseTo(18, 5) // 3 + 15
    expect(computeCost(usage, 'haiku')).toBeCloseTo(4.8, 5) // 0.8 + 4
  })

  it('computes cost for multi-vendor baseline entries', () => {
    // gpt-4o: $2.5 / 1M input, $10 / 1M output
    expect(computeCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-4o')).toBeCloseTo(2.5, 5)
    // deepseek-chat: $0.27 in / $1.1 out
    expect(
      computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'deepseek-chat'),
    ).toBeCloseTo(1.37, 5)
    // qwen-turbo: $0.05 in / $0.2 out
    expect(computeCost({ inputTokens: 2_000_000, outputTokens: 0 }, 'qwen-turbo')).toBeCloseTo(0.1, 5)
  })

  it('returns undefined for unknown model (no fabricated cost)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, 'unknown-model')).toBeUndefined()
  })

  it('returns undefined when model is undefined', () => {
    expect(computeCost({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeUndefined()
  })

  it('returns undefined for all-zero usage', () => {
    expect(computeCost({ inputTokens: 0, outputTokens: 0 }, 'sonnet')).toBeUndefined()
  })

  it('caller override takes priority over the baseline table', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const override = { sonnet: { input: 1, output: 2 } }
    expect(computeCost(usage, 'sonnet', override)).toBeCloseTo(3, 5) // 1 + 2, not 3 + 15
  })

  it('caller override can price an otherwise-unknown model', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(
      computeCost(usage, 'my-local-model', { 'my-local-model': { input: 0.5, output: 0.5 } }),
    ).toBeCloseTo(1, 5)
  })
})

describe('DAGENTS_PRICE_OVERRIDES env', () => {
  it('env override beats the baseline table (module reloaded with env set)', async () => {
    const prev = process.env.DAGENTS_PRICE_OVERRIDES
    process.env.DAGENTS_PRICE_OVERRIDES = JSON.stringify({ sonnet: { input: 1, output: 1 } })
    try {
      vi.resetModules()
      const { computeCost: freshComputeCost } = await import('../pricing.js')
      const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
      expect(freshComputeCost(usage, 'sonnet')).toBeCloseTo(2, 5) // 1 + 1, not 3 + 15
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_PRICE_OVERRIDES
      else process.env.DAGENTS_PRICE_OVERRIDES = prev
      vi.resetModules()
      // Re-import the cached module graph the other tests in this file use.
      await import('../pricing.js')
    }
  })

  it('bad JSON does not crash parsing — overrides are ignored', () => {
    expect(parsePriceOverrides('{not json')).toEqual({})
    expect(parsePriceOverrides('')).toEqual({})
    expect(parsePriceOverrides(undefined)).toEqual({})
    expect(parsePriceOverrides('["array"]')).toEqual({})
  })

  it('malformed entries are skipped, valid ones kept', () => {
    const parsed = parsePriceOverrides(
      JSON.stringify({
        'good-model': { input: 1, output: 2 },
        'negative': { input: -1, output: 2 },
        'missing-output': { input: 1 },
        'not-a-number': { input: '1', output: 2 },
      }),
    )
    expect(parsed).toEqual({ 'good-model': { input: 1, output: 2 } })
  })

  it('module import survives a bad env value (import does not throw)', async () => {
    const prev = process.env.DAGENTS_PRICE_OVERRIDES
    process.env.DAGENTS_PRICE_OVERRIDES = '%%%not-json%%%'
    try {
      vi.resetModules()
      const mod = await import('../pricing.js')
      // Falls back to the baseline table.
      const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
      expect(mod.computeCost(usage, 'sonnet')).toBeCloseTo(18, 5)
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_PRICE_OVERRIDES
      else process.env.DAGENTS_PRICE_OVERRIDES = prev
      vi.resetModules()
      await import('../pricing.js')
    }
  })
})
