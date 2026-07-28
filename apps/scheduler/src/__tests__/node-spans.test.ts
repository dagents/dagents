import { describe, it, expect } from 'vitest'
import { readNodeTrace } from '../node-span-ingest.js'
import { mapNodeSpanStatus, projectNodeSpans, type NodeSpanInput } from '../node-spans.js'

/**
 * Unit tests for the node-span projection. Pure transforms: no DB, no gateway.
 *
 * These pin the shape contract the scheduler ingest + the console read rely on:
 * map execution state → span status, project a node trace array into one span
 * per node (last entry wins), and read the trace out of a prediction response.
 */

describe('mapNodeSpanStatus', () => {
  it('maps execution states to span statuses', () => {
    expect(mapNodeSpanStatus('INPROGRESS')).toBe('running')
    expect(mapNodeSpanStatus('FINISHED')).toBe('done')
    expect(mapNodeSpanStatus('ERROR')).toBe('failed')
    expect(mapNodeSpanStatus('TERMINATED')).toBe('failed')
    expect(mapNodeSpanStatus('TIMEOUT')).toBe('failed')
    expect(mapNodeSpanStatus('STOPPED')).toBe('paused')
  })

  it('maps unknown / missing states to unknown (NOT done)', () => {
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
      nodeTrace: [
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

  it('reads token usage + cost + nodeType from the engine output shape', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: null,
      nodeTrace: [
        {
          nodeId: 'n2',
          nodeLabel: 'Agent',
          status: 'ERROR',
          data: {
            id: 'n2',
            name: 'agentNode',
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
    expect(s.tokens).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_cost: 1.0,
      output_cost: 0.25,
      total_cost: 1.25,
    })
    expect(s.cost).toBe(1.25)
    expect(s.nodeType).toBe('agentNode')
    expect(s.error).toBe('boom')
  })

  it('leaves tokens/cost null for nodes without output.usageMetadata', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      nodeTrace: [
        {
          nodeId: 'n1',
          nodeLabel: 'Start',
          status: 'FINISHED',
          data: { id: 'n1', name: 'startNode', input: {}, output: { content: 'ok' } },
        },
      ],
    })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.tokens).toBeNull()
    expect(spans[0]!.cost).toBeNull()
    expect(spans[0]!.nodeType).toBe('startNode')
  })

  it('leaves timing null when trace has no per-node timestamps', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      nodeTrace: [{ nodeId: 'n1', status: 'FINISHED' }],
    })
    expect(spans[0]!.startedAt).toBeNull()
    expect(spans[0]!.durationMs).toBeNull()
    expect(spans[0]!.finishedAt).toBeNull()
  })

  it('stamps finishedAt + traceId from the caller', () => {
    const finishedAt = new Date('2026-07-10T00:00:00Z')
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: 'ex1',
      nodeTrace: [{ nodeId: 'n1', status: 'FINISHED' }],
      traceId: 'trace-abc',
      finishedAt,
    })
    expect(spans[0]!.finishedAt).toBe(finishedAt)
    expect(spans[0]!.traceId).toBe('trace-abc')
  })

  it('returns [] for a non-array / empty trace', () => {
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, nodeTrace: [] }),
    ).toEqual([])
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, nodeTrace: null }),
    ).toEqual([])
    expect(
      projectNodeSpans({ runId: 'r1', flowId: 'f1', executionId: null, nodeTrace: 'not-array' }),
    ).toEqual([])
  })

  it('skips malformed entries (no nodeId) without aborting the projection', () => {
    const spans = projectNodeSpans({
      runId: 'r1',
      flowId: 'f1',
      executionId: null,
      nodeTrace: [
        { status: 'FINISHED' },
        { nodeId: 'n1', status: 'FINISHED' },
        'garbage',
      ],
    })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.nodeId).toBe('n1')
  })
})

describe('readNodeTrace', () => {
  it('reads executionId + nodeTrace from a prediction response (legacy agentFlowExecutedData shape)', () => {
    const trace = readNodeTrace({
      executionId: 'ex1',
      agentFlowExecutedData: [{ nodeId: 'n1', status: 'FINISHED' }],
      sessionId: 'r1',
    })
    expect(trace).not.toBeNull()
    expect(trace!.executionId).toBe('ex1')
    expect(Array.isArray(trace!.nodeTrace)).toBe(true)
  })

  it('returns null when the response carries no node trace', () => {
    expect(readNodeTrace({ text: 'a chatflow reply' })).toBeNull()
    expect(readNodeTrace(null)).toBeNull()
    expect(readNodeTrace(undefined)).toBeNull()
  })

  it('falls back to executionData as the trace key (legacy shape)', () => {
    const trace = readNodeTrace({
      executionId: 'ex1',
      executionData: '[{"nodeId":"n1","status":"FINISHED"}]',
    })
    expect(trace).not.toBeNull()
    expect(trace!.executionId).toBe('ex1')
    expect(typeof trace!.nodeTrace).toBe('string')
  })
})
