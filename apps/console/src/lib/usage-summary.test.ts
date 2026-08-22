import { describe, it, expect } from 'vitest'
import { formatUsd, formatTokens, dayBars } from './usage-summary'

/**
 * Pure-transform tests for the billing page data layer (方案 D / AD-3).
 * No network / React — matching agents-catalog.test.ts's node-env pattern.
 */

describe('formatUsd', () => {
  it('formats plain amounts with two decimals', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(1.004)).toBe('$1.00')
    expect(formatUsd(1.006)).toBe('$1.01')
  })

  it('shows <$0.01 for tiny non-zero amounts instead of rounding to zero', () => {
    expect(formatUsd(0.001)).toBe('<$0.01')
    expect(formatUsd(0.004)).toBe('<$0.01')
  })

  it('returns — for missing / non-finite values', () => {
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(undefined)).toBe('—')
    expect(formatUsd(Number.NaN)).toBe('—')
  })
})

describe('formatTokens', () => {
  it('formats small counts as-is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands and millions with suffixes', () => {
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(12_340)).toBe('12.3k')
    expect(formatTokens(999_999)).toBe('1000.0k')
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(2_340_000)).toBe('2.3M')
  })

  it('returns — for missing / non-finite values', () => {
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(undefined)).toBe('—')
  })
})

describe('dayBars', () => {
  it('normalizes bar widths to the max daily cost', () => {
    const bars = dayBars([
      { date: '2026-08-20', cost: 10, tokens: 1000 },
      { date: '2026-08-21', cost: 5, tokens: 500 },
      { date: '2026-08-22', cost: 0, tokens: 0 },
    ])
    expect(bars[0]).toEqual({ date: '2026-08-20', costLabel: '$10.00', pct: 100 })
    expect(bars[1].pct).toBe(50)
    expect(bars[2].pct).toBe(0)
    expect(bars[2].costLabel).toBe('$0.00')
  })

  it('keeps a hairline width for non-zero-but-tiny days', () => {
    const bars = dayBars([
      { date: '2026-08-20', cost: 100, tokens: 1 },
      { date: '2026-08-21', cost: 0.001, tokens: 1 },
    ])
    expect(bars[1].pct).toBe(1)
    expect(bars[1].costLabel).toBe('<$0.01')
  })

  it('handles an empty window', () => {
    expect(dayBars([])).toEqual([])
  })

  it('returns zero widths when every day is zero cost', () => {
    const bars = dayBars([
      { date: '2026-08-20', cost: 0, tokens: 100 },
      { date: '2026-08-21', cost: 0, tokens: 0 },
    ])
    expect(bars.map((b) => b.pct)).toEqual([0, 0])
  })
})
