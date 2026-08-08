import { describe, it, expect } from 'vitest'
import { aggregateUsage, computeCost } from '../inline-executor.js'

describe('aggregateUsage', () => {
  it('returns undefined for empty usage map', () => {
    expect(aggregateUsage({})).toBeUndefined()
  })

  it('sums inputTokens and outputTokens across models', () => {
    const result = aggregateUsage({
      'sonnet': { inputTokens: 100, outputTokens: 50 },
      'haiku': { inputTokens: 200, outputTokens: 100 },
    })
    expect(result).toEqual({ inputTokens: 300, outputTokens: 150 })
  })

  it('sums optional cacheReadTokens and cacheWriteTokens when present', () => {
    const result = aggregateUsage({
      'sonnet': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      'haiku': { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 },
    })
    expect(result).toEqual({ inputTokens: 300, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 5 })
  })

  it('omits cache fields when no model has them', () => {
    const result = aggregateUsage({
      'sonnet': { inputTokens: 100, outputTokens: 50 },
    })
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 })
    expect(result!.cacheReadTokens).toBeUndefined()
  })
})

describe('computeCost', () => {
  it('returns undefined when usage is undefined', () => {
    expect(computeCost(undefined, 'sonnet')).toBeUndefined()
  })

  it('computes cost for sonnet pricing', () => {
    // sonnet: $3 / 1M input, $15 / 1M output
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, 'sonnet')).toBeCloseTo(18, 5) // 3 + 15
  })

  it('computes cost for haiku pricing', () => {
    // haiku: $0.8 / 1M input, $4 / 1M output
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, 'haiku')).toBeCloseTo(4.8, 5) // 0.8 + 4
  })

  it('returns undefined for unknown model (no fabricated cost)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, 'unknown-model')).toBeUndefined()
  })

  it('returns undefined when model is undefined', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(usage, undefined)).toBeUndefined()
  })
})
