import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRunQuery = vi.fn()

vi.mock('@dagents/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

// Import AFTER the mock is registered.
import {
  recordUsageEvent,
  hasTokens,
  aggregateExecutedNodesUsage,
  aggregateModelUsage,
} from '../usage-events.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunQuery.mockResolvedValue({ records: [], affected: 1 })
})

describe('hasTokens', () => {
  it('accepts both usage shapes (contracts + openai keys)', () => {
    expect(hasTokens({ inputTokens: 10, outputTokens: 0 })).toBe(true)
    expect(hasTokens({ prompt_tokens: 0, completion_tokens: 5 })).toBe(true)
  })

  it('rejects empty / zero / non-object usage', () => {
    expect(hasTokens(null)).toBe(false)
    expect(hasTokens({})).toBe(false)
    expect(hasTokens({ inputTokens: 0, outputTokens: 0 })).toBe(false)
    expect(hasTokens({ inputTokens: 0, prompt_tokens: 0, outputTokens: 0 })).toBe(false)
  })
})

describe('recordUsageEvent', () => {
  it('inserts with source/usage/cost and priced=true when cost is present', async () => {
    await recordUsageEvent({
      source: 'chat',
      chatId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      agentId: '33333333-3333-3333-3333-333333333333',
      model: 'sonnet',
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: 0.00105,
    })

    expect(mockRunQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockRunQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO usage_events')
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/) // generated uuid id
    expect(params[1]).toBe('chat')
    expect(params[2]).toBe('11111111-1111-1111-1111-111111111111') // chat_id
    expect(params[3]).toBe('22222222-2222-2222-2222-222222222222') // run_id
    expect(params[4]).toBeNull() // task_id
    expect(params[5]).toBe('33333333-3333-3333-3333-333333333333') // agent_id
    expect(params[6]).toBeNull() // flow_id
    expect(params[7]).toBe('sonnet') // model
    expect(JSON.parse(params[8] as string)).toEqual({ inputTokens: 100, outputTokens: 50 })
    expect(params[9]).toBe(0.00105) // cost
    expect(params[10]).toBe(true) // priced
  })

  it('writes cost=null + priced=false when cost is unknown', async () => {
    await recordUsageEvent({
      source: 'workflow_run',
      flowId: 'flow-1',
      usage: { inputTokens: 10, outputTokens: 0 },
    })
    const [, params] = mockRunQuery.mock.calls[0] as [string, unknown[]]
    expect(params[1]).toBe('workflow_run')
    expect(params[9]).toBeNull()
    expect(params[10]).toBe(false)
  })

  it('skips the insert entirely when usage carries no tokens', async () => {
    await recordUsageEvent({ source: 'chat', usage: { inputTokens: 0, outputTokens: 0 }, cost: 1 })
    expect(mockRunQuery).not.toHaveBeenCalled()
  })

  it('nulls non-uuid run_id (custom x-run-id) instead of failing', async () => {
    await recordUsageEvent({
      source: 'workflow_run',
      runId: 'my-custom-run-id',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const [, params] = mockRunQuery.mock.calls[0] as [string, unknown[]]
    expect(params[3]).toBeNull()
  })

  it('never throws when the DB insert fails (telemetry must not break execution)', async () => {
    mockRunQuery.mockRejectedValueOnce(new Error('db down'))
    await expect(
      recordUsageEvent({ source: 'dispatch_task', usage: { inputTokens: 5, outputTokens: 5 } }),
    ).resolves.toBeUndefined()
  })
})

describe('aggregateExecutedNodesUsage (workflow run rollup)', () => {
  it('sums node tokens across both token shapes and node costs', () => {
    const rollup = aggregateExecutedNodesUsage([
      { tokens: { prompt_tokens: 100, completion_tokens: 50 }, cost: 0.001 },
      { tokens: { inputTokens: 10, outputTokens: 5 }, cost: 0.0002 },
      { tokens: null, cost: null }, // non-LLM node
    ])
    expect(rollup.usage).toEqual({ inputTokens: 110, outputTokens: 55 })
    expect(rollup.cost).toBeCloseTo(0.0012, 8)
    expect(rollup.priced).toBe(true)
  })

  it('marks the run unpriced when a token-bearing node has no cost', () => {
    const rollup = aggregateExecutedNodesUsage([
      { tokens: { inputTokens: 100, outputTokens: 50 }, cost: 0.001 },
      { tokens: { inputTokens: 10, outputTokens: 5 }, cost: null }, // engine has no price
    ])
    expect(rollup.usage).toEqual({ inputTokens: 110, outputTokens: 55 })
    expect(rollup.cost).toBeNull()
    expect(rollup.priced).toBe(false)
  })

  it('returns cost null for a run with no tokens at all', () => {
    const rollup = aggregateExecutedNodesUsage([{ tokens: null, cost: null }])
    expect(rollup.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(rollup.cost).toBeNull()
    expect(rollup.priced).toBe(false)
  })
})

describe('aggregateModelUsage (dispatch rollup)', () => {
  it('sums per-model tokens and computes cost via the pricing table', () => {
    const rollup = aggregateModelUsage({
      sonnet: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, // 3 + 15 = 18
      haiku: { inputTokens: 1_000_000, outputTokens: 0 }, // 0.8
    })
    expect(rollup.usage).toEqual({ inputTokens: 2_000_000, outputTokens: 1_000_000 })
    expect(rollup.cost).toBeCloseTo(18.8, 5)
  })

  it('returns cost null when any model is unpriced (no partial sums)', () => {
    const rollup = aggregateModelUsage({
      sonnet: { inputTokens: 100, outputTokens: 100 },
      'totally-unknown': { inputTokens: 100, outputTokens: 100 },
    })
    expect(rollup.usage).toEqual({ inputTokens: 200, outputTokens: 200 })
    expect(rollup.cost).toBeNull()
  })

  it('handles missing / malformed usage maps', () => {
    expect(aggregateModelUsage(undefined).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(aggregateModelUsage(null).cost).toBeNull()
    expect(aggregateModelUsage({ junk: 'not-an-object' }).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})
