import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { NodeSpanInput } from './node-spans.js'

/**
 * `run_node_spans` repository (plan M6.4 / P1.11.T5).
 *
 * All access goes through `runQuery` parameterised raw SQL — same decorator-
 * free-reads rationale as `runs` / `audit_log`: the `RunNodeSpan` entity exists
 * for schema + typing, not runtime queries.
 */

const log = createLogger({ svc: 'scheduler:node-spans' })

/**
 * Persist projected node spans for a run. Deletes the run's prior spans first
 * (a re-run replaces, not appends) then inserts the new batch in one statement.
 * Best-effort: a DB failure is logged and swallowed so it never re-fails a
 * completed run — node-level trace is an observability projection, not a
 * run-lifecycle concern (same posture as the M6.6 audit hook).
 *
 * Returns the number of spans written. An empty `spans` array is a no-op (no
 * DELETE, no INSERT): callers that need to clear a run's stale rows on a
 * re-run that produced no nodes should call with the new (empty) projection
 * after deleting themselves, or rely on the projection returning at least the
 * nodes the run did touch.
 */
export async function writeRunNodeSpans(spans: readonly NodeSpanInput[]): Promise<number> {
  if (spans.length === 0) return 0
  const runId = spans[0]!.runId
  try {
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = $1`, [runId])
  } catch (err) {
    log.warn('delete prior node spans failed', { runId, error: String(err) })
    return 0
  }

  // One parameterised multi-row INSERT. Values are laid out as
  // (run_id, flow_id, execution_id, node_id, node_label, node_type, status,
  //  started_at, finished_at, duration_ms, tokens, cost, error, trace_id) per
  // row; params are $1..$14, $15..$28, … — `(i-1)*14 + col`.
  const COLS = 14
  const placeholders: string[] = []
  const params: unknown[] = []
  spans.forEach((s, i) => {
    const b = i * COLS
    placeholders.push(
      `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}, $${b + 14})`,
    )
    params.push(
      s.runId,
      s.flowId,
      s.executionId,
      s.nodeId,
      s.nodeLabel,
      s.nodeType,
      s.status,
      s.startedAt,
      s.finishedAt,
      s.durationMs,
      s.tokens != null ? JSON.stringify(s.tokens) : null,
      s.cost,
      s.error,
      s.traceId,
    )
  })

  try {
    await runQuery(
      `INSERT INTO run_node_spans
         (run_id, flow_id, execution_id, node_id, node_label, node_type,
          status, started_at, finished_at, duration_ms, tokens, cost,
          error, trace_id)
       VALUES ${placeholders.join(', ')}`,
      params,
    )
  } catch (err) {
    log.warn('insert node spans failed', { runId, count: spans.length, error: String(err) })
    return 0
  }
  return spans.length
}

/** Row shape returned by `listRunNodeSpans`. */
export interface RunNodeSpanRow {
  id: string
  runId: string
  flowId: string
  executionId: string | null
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  status: string
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  tokens: unknown
  /** NUMERIC → pg returns string; left as-is for the caller to coerce. */
  cost: string | null
  error: string | null
  traceId: string | null
  input: unknown
  output: unknown
  createdAt: Date
}

/**
 * List a run's node spans, in first-seen order (creation order). Used by the
 * console read API to render the DAG node inspector without re-reading live
 * execution data on every render.
 */
export async function listRunNodeSpans(runId: string): Promise<RunNodeSpanRow[]> {
  const { records } = await runQuery<RunNodeSpanRow>(
    `SELECT id, run_id AS "runId", flow_id AS "flowId", execution_id AS "executionId",
            node_id AS "nodeId", node_label AS "nodeLabel", node_type AS "nodeType",
            status, started_at AS "startedAt", finished_at AS "finishedAt",
            duration_ms AS "durationMs", tokens, cost, error, trace_id AS "traceId",
            input, output, created_at AS "createdAt"
       FROM run_node_spans
      WHERE run_id = $1
      ORDER BY created_at`,
    [runId],
  )
  return records
}
