import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { ingestRunNodeSpans } from '../node-span-ingest.js'

/**
 * M6.4 node-span ingest + read integration (plan §Task M6.4 / P1.11.T5).
 *
 * Drives the real `run_node_spans` table (docker-compose Postgres) through the
 * scheduler's ingest path: insert a run row, ingest a workflow engine prediction
 * output with node trace, assert the projected spans land one-per-node (last
 * entry wins) with token/cost/error best-effort, and that a re-ingest REPLACES
 * rather than appends. No gateway / no live engine — the prediction output is a
 * fixture.
 */
describe('M6.4 node-span ingest + read', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })
  beforeEach(async () => {
    await runQuery(`DELETE FROM run_node_spans`)
  })

  it('projects one span per node (last entry wins) + reads token/cost/error', async () => {
    const runId = randomUUID()
    const flowId = 'flow-e2e'
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input) VALUES ($1, $2, $3, 'completed', '{}'::jsonb)`,
      [runId, runId, flowId],
    )

    // Workflow engine prediction-output shape: each executed-node entry's
    // `data` is the node's execution result (`{ id, name, input, output: {
    // content, timeMetadata, usageMetadata } }`). usageMetadata carries token
    // counts + `total_cost` when cost accounting is on. ERROR nodes carry
    // `data.error`.
    const output = {
      executionId: 'ex-1',
      sessionId: runId,
      agentFlowExecutedData: [
        { nodeId: 'n1', nodeLabel: 'Start', status: 'INPROGRESS', data: { id: 'n1', name: 'startNode', output: { content: 'ok' } } },
        {
          nodeId: 'n2',
          nodeLabel: 'Agent',
          status: 'ERROR',
          data: {
            id: 'n2',
            name: 'agentNode',
            output: {
              content: '',
              usageMetadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15, total_cost: 0.42 },
            },
            error: 'boom',
          },
        },
        { nodeId: 'n1', nodeLabel: 'Start', status: 'FINISHED', data: { id: 'n1', name: 'startNode', output: { content: 'ok' } } },
      ],
    }
    const n = await ingestRunNodeSpans({ runId, flowId, output, traceId: 'trace-xyz', finishedAt: new Date('2026-07-10T01:00:00Z') })
    expect(n).toBe(2)

    const { records } = await runQuery<{ node_id: string; status: string; error: string | null; cost: string | null; trace_id: string | null; tokens: unknown; node_type: string | null }>(
      `SELECT node_id, status, error, cost, trace_id, tokens, node_type FROM run_node_spans WHERE run_id=$1 ORDER BY node_id`,
      [runId],
    )
    expect(records).toHaveLength(2)
    const n1 = records.find((r) => r.node_id === 'n1')!
    const n2 = records.find((r) => r.node_id === 'n2')!
    expect(n1.status).toBe('done') // last entry (FINISHED) wins, not INPROGRESS
    expect(n2.status).toBe('failed')
    expect(n2.error).toBe('boom')
    // NUMERIC(18,6) → pg returns the value scaled to 6 decimals as a string;
    // 0.42 lands as '0.420000'. Coerce + compare numerically so the scale
    // formatting doesn't make the assertion brittle.
    expect(Number(n2.cost)).toBe(0.42)
    expect(n2.trace_id).toBe('trace-xyz')
    expect(n2.tokens).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15, total_cost: 0.42 })
    expect(n2.node_type).toBe('agentNode') // data.name, the closest type-like field
    // n1 (Start) has no usageMetadata → tokens/cost null
    expect(n1.tokens).toBeNull()
    expect(n1.cost).toBeNull()

    await runQuery(`DELETE FROM run_node_spans WHERE run_id=$1`, [runId])
    await runQuery(`DELETE FROM runs WHERE id=$1`, [runId])
  })

  it('re-ingest REPLACES (delete + insert), not appends', async () => {
    const runId = randomUUID()
    const flowId = 'flow-replace'
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input) VALUES ($1, $2, $3, 'completed', '{}'::jsonb)`,
      [runId, runId, flowId],
    )

    await ingestRunNodeSpans({
      runId,
      flowId,
      output: { executionId: 'ex-1', agentFlowExecutedData: [{ nodeId: 'n1', status: 'FINISHED', data: { name: 'startNode' } }, { nodeId: 'n2', status: 'FINISHED', data: { name: 'agentNode' } }] },
      // traceId=null keeps the row deterministic (no active span in this test)
      traceId: null,
    })
    const { records: first } = await runQuery<{ n: number }>(`SELECT count(*)::int AS n FROM run_node_spans WHERE run_id=$1`, [runId])
    expect(first[0].n).toBe(2)

    // re-ingest with a single node — prior 2 must be cleared, 1 inserted
    await ingestRunNodeSpans({
      runId,
      flowId,
      output: { executionId: 'ex-2', agentFlowExecutedData: [{ nodeId: 'n3', status: 'FINISHED', data: { name: 'directReplyNode' } }] },
      traceId: null,
    })
    const { records: second } = await runQuery<{ n: number }>(`SELECT count(*)::int AS n FROM run_node_spans WHERE run_id=$1`, [runId])
    expect(second[0].n).toBe(1)

    await runQuery(`DELETE FROM run_node_spans WHERE run_id=$1`, [runId])
    await runQuery(`DELETE FROM runs WHERE id=$1`, [runId])
  })

  it('no-op when the prediction output carries no node trace', async () => {
    const runId = randomUUID()
    const n = await ingestRunNodeSpans({ runId, flowId: 'f', output: { text: 'a chatflow reply' } })
    expect(n).toBe(0)
  })
})
