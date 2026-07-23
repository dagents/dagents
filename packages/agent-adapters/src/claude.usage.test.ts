/**
 * Unit tests for per-model usage aggregation in `claude.ts`.
 *
 * M2.7 (P1.6.T5) acceptance: 多 model 调用, usage 各自聚合（不串/不丢）.
 *
 * These exercise `accumulateAssistantUsage` (incremental, from assistant
 * frames) and `resultUsage` (authoritative, from the result frame) directly,
 * without spawning a subprocess — so the per-model independence invariants
 * are pinned at the unit level. The end-to-end path is covered by
 * `claude.lifecycle.test.ts`'s multi-model harness mode.
 */
import { describe, it, expect } from 'vitest'
import { accumulateAssistantUsage, resultUsage } from './claude.js'
import type { TokenUsage } from '@mil/contracts'

// The internal `ClaudeMessage` / `ClaudeStreamMessage` shapes are not exported;
// structural typing lets us pass plain literals. Only the fields the functions
// read are populated.
type AsstMsg = { model?: string; usage?: Record<string, number | undefined> }
type ModelUsage = Record<string, Record<string, number | undefined>>
type ResultMsg = {
  model?: string
  usage?: Record<string, number | undefined>
  modelUsage?: ModelUsage
}

const asst = (m: AsstMsg) => m
// These literals represent result frames, so inject the `type` the
// `ClaudeStreamMessage` contract requires (the field is otherwise unused by
// `resultUsage`, but `tsc` enforces it under strict mode).
const result = (m: ResultMsg) => ({ type: 'result', ...m })

// ─── accumulateAssistantUsage ──────────────────────────────────────────────

describe('accumulateAssistantUsage', () => {
  it('accumulates a single model across multiple assistant frames', () => {
    const usage: Record<string, TokenUsage> = {}
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 10, output_tokens: 2 } }))
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 4 } }))
    expect(usage).toEqual({
      A: { inputTokens: 15, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
    })
  })

  it('keeps each model independent (不串) when frames interleave', () => {
    const usage: Record<string, TokenUsage> = {}
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 10, output_tokens: 1 } }))
    accumulateAssistantUsage(usage, asst({ model: 'B', usage: { input_tokens: 20, output_tokens: 2 } }))
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 5, output_tokens: 0 } }))
    accumulateAssistantUsage(usage, asst({ model: 'B', usage: { input_tokens: 7, output_tokens: 3 } }))
    // Each model sums only its own frames — no cross-contamination.
    expect(usage).toEqual({
      A: { inputTokens: 15, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      B: { inputTokens: 27, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('skips frames with no usage or no model without dropping prior counts (不丢)', () => {
    const usage: Record<string, TokenUsage> = {}
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 10, output_tokens: 1 } }))
    accumulateAssistantUsage(usage, asst({ model: 'A' })) // no usage block
    accumulateAssistantUsage(usage, asst({ usage: { input_tokens: 99 } })) // no model
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 5, output_tokens: 2 } }))
    expect(usage).toEqual({
      A: { inputTokens: 15, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('accumulates cache read/write tokens across frames', () => {
    const usage: Record<string, TokenUsage> = {}
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { cache_creation_input_tokens: 100 } }))
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { cache_read_input_tokens: 80, output_tokens: 2 } }))
    expect(usage).toEqual({
      A: { inputTokens: 0, outputTokens: 2, cacheReadTokens: 80, cacheWriteTokens: 100 },
    })
  })
})

// ─── resultUsage ───────────────────────────────────────────────────────────

describe('resultUsage', () => {
  it('returns each model from modelUsage independently (不串/不丢)', () => {
    const ru = resultUsage(result({
      modelUsage: {
        A: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 3 },
        B: { inputTokens: 20, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6 },
      },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 3 },
      B: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 },
    })
  })

  it('drops zero-token modelUsage entries (no spurious empty model)', () => {
    const ru = resultUsage(result({
      modelUsage: {
        A: { inputTokens: 10, outputTokens: 2 },
        empty: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('preserves a cache-only modelUsage entry (hasTokens includes cacheWrite)', () => {
    const ru = resultUsage(result({
      modelUsage: { A: { cacheCreationInputTokens: 50 } },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 50 },
    })
  })

  it('skips an empty-string model key in modelUsage', () => {
    const ru = resultUsage(result({
      modelUsage: {
        '': { inputTokens: 99, outputTokens: 99 },
        A: { inputTokens: 10, outputTokens: 2 },
      },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('falls back to top-level usage when modelUsage is absent', () => {
    const ru = resultUsage(result({
      model: 'A',
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })
  })

  it('falls back to opts.model when the result frame carries no model', () => {
    const ru = resultUsage(result({
      usage: { input_tokens: 7, output_tokens: 3 },
    }), 'requested-model')
    expect(ru).toEqual({
      'requested-model': { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('returns null when no model is available for the usage fallback', () => {
    expect(resultUsage(result({ usage: { input_tokens: 7 } }), undefined)).toBeNull()
  })

  it('returns null when usage has no token activity at all', () => {
    expect(
      resultUsage(result({ model: 'A', usage: { input_tokens: 0, output_tokens: 0 } }), undefined),
    ).toBeNull()
  })

  it('falls through to usage when modelUsage exists but is entirely empty', () => {
    // modelUsage present but every entry zero-token → must not short-circuit
    // to an empty map; it should fall through to the usage fallback.
    const ru = resultUsage(result({
      modelUsage: { empty: { inputTokens: 0, outputTokens: 0 } },
      model: 'A',
      usage: { input_tokens: 9, output_tokens: 4 },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('normalizes absent cache fields to 0 (never undefined) in the usage fallback', () => {
    const ru = resultUsage(result({
      model: 'A',
      usage: { input_tokens: 5, output_tokens: 1 },
    }), undefined)
    expect(ru).toEqual({
      A: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    // Explicit guard: the persisted shape must be JSON-stable (no undefined).
    expect(JSON.parse(JSON.stringify(ru))).toEqual(ru)
  })
})

// ─── full multi-model sequence (the 不串/不丢 invariant end-to-end at unit level) ─

describe('usage aggregation: multi-model sequence', () => {
  it('incremental accumulation is replaced by authoritative resultUsage per model', () => {
    // Simulate the execute() loop: assistant frames accumulate incrementally,
    // then the result frame's modelUsage replaces the whole map (mirrors
    // `if (ru) usage = ru`). The final map must carry each model with the
    // AUTHORITATIVE result counts, not the incremental hints, and keep the
    // two models separate.
    let usage: Record<string, TokenUsage> = {}

    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 3, output_tokens: 0 } }))
    accumulateAssistantUsage(usage, asst({ model: 'B', usage: { input_tokens: 4, output_tokens: 0 } }))
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 2, output_tokens: 0 } }))

    const ru = resultUsage(result({
      modelUsage: {
        A: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 5 },
        B: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 8 },
      },
    }), 'A')
    if (ru) usage = ru

    expect(usage).toEqual({
      A: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5 },
      B: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 8, cacheWriteTokens: 0 },
    })
    // Neither model leaked the other's incremental counts.
    expect(usage.A.inputTokens).not.toBe(5)
    expect(usage.B.inputTokens).not.toBe(4)
  })

  it('keeps incremental accumulation when the result frame carries no usage (不丢)', () => {
    // If the result frame has no modelUsage and no usage (e.g. a timeout /
    // error path), the loop keeps the incremental map rather than zeroing it.
    let usage: Record<string, TokenUsage> = {}
    accumulateAssistantUsage(usage, asst({ model: 'A', usage: { input_tokens: 10, output_tokens: 1 } }))
    accumulateAssistantUsage(usage, asst({ model: 'B', usage: { input_tokens: 20, output_tokens: 2 } }))

    const ru = resultUsage(result({}), undefined)
    if (ru) usage = ru

    expect(usage).toEqual({
      A: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      B: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })
})
