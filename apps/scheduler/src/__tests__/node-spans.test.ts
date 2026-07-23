import { describe, it, expect } from 'vitest'
import { readAgentflowTrace } from '../node-span-ingest.js'
import { mapNodeSpanStatus, projectNodeSpans, type NodeSpanInput } from '../node-spans.js'

/**
 * Unit tests for the Flowise → run_node_spans projection (plan M6.4 /
 * P1.11.T5). Pure transforms: no DB, no gateway.
 *
 * These pin the shape contract the scheduler ingest + the console read rely on:
 * map Flowise `ExecutionState` → span status, project an agentflow trace array
 * into one span per node (last entry wins), and read the trace out of a
 * prediction response.
 */

describe('mapNodeSpanStatus', () => {
  it('maps Flowise states to span statuses', () => {
    expect(mapNodeSpanStatus('INPROGRESS')).toBe('running')
    expect(mapNodeSpanStatus('FINISHED')).toBe('done')
    expect(mapNodeSpanStatus('ERROR')).toBe('failed')
    expect(mapNodeSpanStatus('TERMINATED')).toBe('failed')
    expect(mapNodeSpanStatus('TIMEOUT')).toBe('failed')
    expect(mapNodeSpanStatus('STOPPED')).toBe('paused')
  })

  it('maps unknown / missing states to unknown (NOT done)', () => {
    // `unknown` is distinct from `done` so the inspector can flag an
    // unrecognised outcome rather than silently green-lighting a node.
    expect(mapNodeSpanStatus(undefined)).toBe('unknown')
    expect(mapNodeSpanStatus('WHATEVER')).toBe('unknown')
  })
})

describe('projectNodeSpans (pure projection)', () => {
  it('projects one span per node, taking the LAST entry per nodeId', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      // n1 appears twice — INPROGRESS then FINISHED; the last (done) wins.
      agentFlowExecutedData: [
        { nodeId: 'n1', nodeLabel: 'Start', status: 'INPROGRESS' },
        { nodeId: 'n2', nodeLabel: 'Agent', status: 'INPROGRESS' },
        { nodeId: 'n1', nodeLabel: 'Start', status: 'FINISHED' },
      ],
    })
    expect(spans).toHaveLength(2)
    const n1 = spans.find((s: NodeSpanInput) => s.nodeId === 'n1')!
    const n2 = spans.find((s: NodeSpanInput) => s.nodeId === 'n2')!
    expect(n1.status).toBe('done')
    expect(n1.nodeLabel).toBe('Start')
    expect(n2.status).toBe('running')
    expect(n2.executionId).toBe('ex1')
    expect(n2.flowId).toBe('f1')
    expect(n2.runId).toBe('r1')
  })

  it('reads token usage + cost + nodeType from the real Flowise output shape', () => {
    // Flowise pushes `nodeResult = node.run()` as each entry's `data`. For an
    // Agent/LLM node that return is `{ id, name, input, output: { content,
    // timeMetadata, usageMetadata } }` (vendor/.../agentflow/Agent/Agent.ts
    // `prepareOutputObject`). usageMetadata carries token counts AND, when cost
    // accounting is on, `input_cost`/`total_cost`. This fixture mirrors that
    // real shape — NOT a synthetic `{ usage, cost }` — so the projection's
    // read path (`data.output.usageMetadata`) is actually exercised. (Flowise's
    // own evaluation runner reads the same path — the cross-check that pinned
    // this shape during code review.)
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: null,
      agentFlowExecutedData: [
        {
          nodeId: 'n2',
          nodeLabel: 'Agent',
          status: 'ERROR',
          data: {
            id: 'n2',
            name: 'agentAgentflow',
            input: { messages: [] },
            output: {
              content: '',
              timeMetadata: { start: 1, end: 2, delta: 1 },
              usageMetadata: {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
                input_cost: 1.0,
                output_cost: 0.25,
                total_cost: 1.25,
              },
            },
            error: 'boom',
          },
        },
      ],
    })
    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.status).toBe('failed')
    // tokens is the whole usageMetadata blob (the per-node token/cost map)
    expect(s.tokens).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_cost: 1.0,
      output_cost: 0.25,
      total_cost: 1.25,
    })
    // cost is read from usageMetadata.total_cost
    expect(s.cost).toBe(1.25)
    // nodeType falls back to the Flowise node `name` (no React Flow type in data)
    expect(s.nodeType).toBe('agentAgentflow')
    // error is read from data.error (ERROR nodes carry it at top level of data)
    expect(s.error).toBe('boom')
  })

  it('leaves tokens/cost null for a non-agent node (no output.usageMetadata)', () => {
    // Start / Condition / Direct Reply nodes don't call an LLM, so their
    // `data.output` has no `usageMetadata`. The projection must leave
    // tokens/cost null for them (not crash, not fabricate).
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      agentFlowExecutedData: [
        {
          nodeId: 'n1',
          nodeLabel: 'Start',
          status: 'FINISHED',
          data: { id: 'n1', name: 'startAgentflow', input: {}, output: { content: 'ok' } },
        },
      ],
    })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.tokens).toBeNull()
    expect(spans[0]!.cost).toBeNull()
    expect(spans[0]!.nodeType).toBe('startAgentflow')
  })

  it('leaves timing null (Flowise records no per-node timestamps)', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      agentFlowExecutedData: [{ nodeId: 'n1', status: 'FINISHED' }],
    })
    expect(spans[0]!.startedAt).toBeNull()
    expect(spans[0]!.durationMs).toBeNull()
    // finishedAt is caller-supplied; defaults to null in the pure projection.
    expect(spans[0]!.finishedAt).toBeNull()
  })

  it('stamps finishedAt + traceId from the caller', () => {
    const finishedAt = new Date('2026-07-10T00:00:00Z')
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      agentFlowExecutedData: [{ nodeId: 'n1', status: 'FINISHED' }],
      traceId: 'trace-abc',
      finishedAt,
    })
    expect(spans[0]!.finishedAt).toBe(finishedAt)
    expect(spans[0]!.traceId).toBe('trace-abc')
  })

  it('returns [] for a non-array / empty trace', () => {
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, agentFlowExecutedData: [] }),
    ).toEqual([])
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, agentFlowExecutedData: null }),
    ).toEqual([])
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, agentFlowExecutedData: 'not-array' }),
    ).toEqual([])
  })

  it('skips malformed entries (no nodeId) without aborting the projection', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: null,
      agentFlowExecutedData: [
        { status: 'FINISHED' }, // no nodeId — skipped
        { nodeId: 'n1', status: 'FINISHED' },
        'garbage', // not an object — skipped
      ],
    })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.nodeId).toBe('n1')
  })
})

describe('readAgentflowTrace', () => {
  it('reads executionId + agentFlowExecutedData from a prediction response', () => {
    const trace = readAgentflowTrace({
      executionId: 'ex1',
      agentFlowExecutedData: [{ nodeId: 'n1', status: 'FINISHED' }],
      sessionId: 'r1',
    })
    expect(trace).not.toBeNull()
    expect(trace!.executionId).toBe('ex1')
    expect(Array.isArray(trace!.agentFlowExecutedData)).toBe(true)
  })

  it('returns null when the response carries no agentflow trace', () => {
    expect(readAgentflowTrace({ text: 'a chatflow reply' })).toBeNull()
    expect(readAgentflowTrace(null)).toBeNull()
    expect(readAgentflowTrace(undefined)).toBeNull()
  })

  it('falls back to executionData as the trace key (legacy shape)', () => {
    // The DB-side `Execution.executionData` is a JSON string, but the
    // prediction-response path (the only path that reaches `ingestRunNodeSpans`)
    // hands us an already-parsed array. `readAgentflowTrace` does NOT JSON.parse
    // a string, so a string-valued `executionData` is surfaced as-is and the
    // projection's `Array.isArray` guard skips it. This test pins that the key
    // is still *recognized* (not null) even when the value is a string — the
    // caller decides what to do with it.
    const trace = readAgentflowTrace({
      executionId: 'ex1',
      executionData: '[{"nodeId":"n1","status":"FINISHED"}]',
    })
    expect(trace).not.toBeNull()
    expect(trace!.executionId).toBe('ex1')
    // a string is surfaced verbatim (not parsed); projectNodeSpans skips it
    expect(typeof trace!.agentFlowExecutedData).toBe('string')
  })
})
