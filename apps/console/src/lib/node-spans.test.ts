import { describe, it, expect } from 'vitest'
import { toRunNodeSpan, mapSpanStatus, type SchedulerNodeSpanRow } from './node-spans'

/**
 * Unit tests for the scheduler → console node-span transform (M6.4 /
 * P1.11.T5). Pure: no fetch, no gateway.
 *
 * Pins the shape contract the console API route + the inspector rely on: a
 * scheduler `run_node_spans` row (NUMERIC cost as string, status domain) maps
 * onto the console `RunNodeSpan` (numeric cost, console status), and unknown
 * statuses degrade to `unknown` rather than crashing the inspector.
 */

const baseRow: SchedulerNodeSpanRow = {
  nodeId: 'n1',
  nodeLabel: 'Start',
  nodeType: 'customNode',
  status: 'done',
  startedAt: null,
  finishedAt: '2026-07-10T01:00:00.000Z',
  durationMs: null,
  tokens: null,
  cost: null,
  error: null,
  traceId: null,
}

describe('mapSpanStatus', () => {
  it('passes the known statuses through', () => {
    expect(mapSpanStatus('running')).toBe('running')
    expect(mapSpanStatus('done')).toBe('done')
    expect(mapSpanStatus('failed')).toBe('failed')
    expect(mapSpanStatus('paused')).toBe('paused')
    expect(mapSpanStatus('unknown')).toBe('unknown')
  })

  it('degrades an unrecognized status to unknown', () => {
    expect(mapSpanStatus('queued')).toBe('unknown')
    expect(mapSpanStatus('idle')).toBe('unknown')
    expect(mapSpanStatus('WHATEVER')).toBe('unknown')
  })
})

describe('toRunNodeSpan', () => {
  it('coerces a NUMERIC-as-string cost to a number', () => {
    const span = toRunNodeSpan({ ...baseRow, cost: '0.420000' })
    expect(span.cost).toBe(0.42)
  })

  it('leaves cost null when the row has none', () => {
    const span = toRunNodeSpan({ ...baseRow, cost: null })
    expect(span.cost).toBeNull()
  })

  it('nulls an unparseable cost string rather than NaN-ing', () => {
    const span = toRunNodeSpan({ ...baseRow, cost: 'not-a-number' })
    expect(span.cost).toBeNull()
  })

  it('reads token usage + error + traceId verbatim', () => {
    const span = toRunNodeSpan({
      ...baseRow,
      status: 'failed',
      tokens: { 'gpt-4': { prompt_tokens: 100, completion_tokens: 50 } },
      cost: '1.25',
      error: 'boom',
      traceId: 'trace-abc',
    })
    expect(span.status).toBe('failed')
    expect(span.tokens).toEqual({ 'gpt-4': { prompt_tokens: 100, completion_tokens: 50 } })
    expect(span.cost).toBe(1.25)
    expect(span.error).toBe('boom')
    expect(span.traceId).toBe('trace-abc')
  })
})
