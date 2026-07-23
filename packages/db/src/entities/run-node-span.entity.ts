import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * One persisted node-level span for a Flowise run (spec §5.3 节点级 trace;
 * plan M6.4 / P1.11.T5).
 *
 * M6.1 threads one OTel traceId across the gateway→flowise→daemon→LLM chain at
 * the *service* level. M6.4 adds the *node* level: each node a Flowise agentflow
 * executes (Start / Agent / Iteration / Condition / HTTP / Direct Reply / …)
 * becomes a queryable span tied back to the run, so the AgentFlows browse page
 * can show per-node status + duration + token/cost without re-reading Flowise's
 * live `executionData` on every render.
 *
 * The span is sourced from Flowise's `Execution.executionData` — an array of
 * `IAgentflowExecutedData` (`{ nodeId, nodeLabel, data, previousNodeIds,
 * status }`). The scheduler ingests that array after a run completes (matching
 * the run by the `sessionId === runId` convention M3.2 threads) and writes one
 * row per node entry here. Flowise remains the execution engine; this table is
 * the platform's durable, queryable projection of a run's node trace.
 *
 * Like `runs` / `audit_log`, this entity exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL, so no entity class is loaded on the hot path.
 */

export type NodeSpanStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'paused'
  // A node the execution reached but Flowise left without a recognised state
  // (kept distinct from `done` so the inspector can flag an unknown outcome).
  | 'unknown'

@Entity({ name: 'run_node_spans' })
@Index('idx_run_node_spans_run', ['runId'])
@Index('idx_run_node_spans_run_node', ['runId', 'nodeId'])
@Index('idx_run_node_spans_flow', ['flowId'])
export class RunNodeSpan {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** The run this node span belongs to (FK-shaped → runs.id). */
  @Column({ name: 'run_id', type: 'uuid' })
  runId!: string

  /** Flowise flow id the run executed (denormalised from runs.pipeline_id for flow-scoped queries). */
  @Column({ name: 'flow_id', type: 'text' })
  flowId!: string

  /** Flowise execution id the span was sourced from (links back to Flowise's Execution row). */
  @Column({ name: 'execution_id', type: 'text', nullable: true })
  executionId!: string | null

  /** React Flow node id (the `nodeId` in `IAgentflowExecutedData`). */
  @Column({ name: 'node_id', type: 'text' })
  nodeId!: string

  /** Display label (Flowise `nodeLabel`). */
  @Column({ name: 'node_label', type: 'text', nullable: true })
  nodeLabel!: string | null

  /** React Flow node `type` (e.g. `customNode`, `Agent`); null when not surfaced. */
  @Column({ name: 'node_type', type: 'text', nullable: true })
  nodeType!: string | null

  /** Mapped node-card status (see `mapNodeSpanStatus`). */
  @Column({ name: 'status', type: 'text' })
  status!: NodeSpanStatus

  /** When the node started (Flowise does not record per-node start; null when unknown). */
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null

  /** When the node finished (Flowise execution updatedDate, null when unknown). */
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null

  /** Node wall-clock duration in ms, when derivable. */
  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs!: number | null

  /** Per-model token usage reported for the node (`Record<string, TokenUsage>`); null when none. */
  @Column({ name: 'tokens', type: 'jsonb', nullable: true })
  tokens!: unknown

  /** Monetary cost for the node, when reported. NUMERIC → pg returns string; coerce at read. */
  @Column({ name: 'cost', type: 'numeric', precision: 18, scale: 6, nullable: true })
  cost!: number | string | null

  /** Error message for a failed/terminated node; null on success. */
  @Column({ name: 'error', type: 'text', nullable: true })
  error!: string | null

  /** OTel traceId the run participated in (M6.1), for end-to-end trace correlation. */
  @Column({ name: 'trace_id', type: 'text', nullable: true })
  traceId!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
