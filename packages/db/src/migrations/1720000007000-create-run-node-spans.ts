import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M6.4 — run_node_spans table (spec §5.3 节点级 trace; plan M6.4 / P1.11.T5).
 *
 * M6.1 threads one OTel traceId across the gateway→flowise→daemon→LLM chain at
 * the *service* level. M6.4 adds the *node* level: each node a Flowise agentflow
 * executes becomes a queryable span tied back to the run, so the AgentFlows
 * browse page can show per-node status + duration without re-reading Flowise's
 * live `executionData` on every render.
 *
 * The scheduler sources spans from Flowise's `Execution.executionData` (an
 * array of `IAgentflowExecutedData`) after a run completes, matching the run by
 * the `sessionId === runId` convention M3.2 threads. Flowise remains the
 * execution engine; this table is the platform's durable, queryable projection
 * of a run's node trace.
 *
 * Mirrors the raw-SQL-1:1 style of the runs / audit_log migrations: the
 * scheduler writes this table with parameterised raw SQL via `runQuery`; the
 * entity class exists for schema definition + repository typing and is not
 * loaded on the runtime query path (same decorator-free-reads rationale as
 * `runs`).
 *
 * `status` is open TEXT + CHECK so new node lifecycle states can be added
 * without a migration — same pattern as `runs.status`. `run_id` is a uuid
 * FK-shaped reference to `runs.id` (no hard FK: a run row is the unit of
 * correlation, and a span written for a half-recorded run must not be blocked
 * by a constraint).
 *
 * Indexes:
 *   - (run_id)                 list a run's node spans (the inspector read)
 *   - (run_id, node_id)        lookup a single node's span within a run
 *   - (flow_id)                flow-scoped "what ran on this flow" queries
 */
export class CreateRunNodeSpans1720000007000 implements MigrationInterface {
  name = 'CreateRunNodeSpans1720000007000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "run_node_spans" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id"        UUID NOT NULL,
        "flow_id"       TEXT NOT NULL,
        "execution_id"  TEXT,
        "node_id"       TEXT NOT NULL,
        "node_label"    TEXT,
        "node_type"     TEXT,
        "status"        TEXT NOT NULL,
        "started_at"    TIMESTAMPTZ,
        "finished_at"   TIMESTAMPTZ,
        "duration_ms"   INTEGER,
        "tokens"        JSONB,
        "cost"          NUMERIC(18,6),
        "error"         TEXT,
        "trace_id"      TEXT,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT run_node_spans_status_chk
          CHECK ("status" IN ('running','done','failed','paused','unknown'))
      )
    `)
    await qr.query(`CREATE INDEX idx_run_node_spans_run ON "run_node_spans" ("run_id")`)
    await qr.query(
      `CREATE INDEX idx_run_node_spans_run_node ON "run_node_spans" ("run_id", "node_id")`,
    )
    await qr.query(`CREATE INDEX idx_run_node_spans_flow ON "run_node_spans" ("flow_id")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "run_node_spans"`)
  }
}
