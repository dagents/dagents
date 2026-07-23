import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A single execution instance (spec §5.3, architecture v0.2 §4.3).
 *
 * Flowise has no native "task instance" table — only flow definitions and chat
 * history — so the platform owns `runs` as the trackable unit of one
 * prediction execution. The fan-out worker (M3.2) creates a parent run per
 * batch and N child runs (linked via `parent_run_id`); a single-run path
 * (M3.1) creates a leaf run with no parent.
 *
 * Like `token_meta`, this entity exists for schema definition + repository
 * typing; runtime queries go through `runQuery` parameterised raw SQL, so no
 * entity class is loaded on the hot path.
 */

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * One agent-daemon call recorded against a run (spec §5.3 `agent_daemon_calls`
 * JSONB; architecture v0.2 §5.3). Populated by dispatch on each terminal
 * task transition (M6.2 / P1.11.T3): the daemon reports `usage` (tokens per
 * model) + `durationMs` + `sessionId` via `/tasks/:id/complete`, and dispatch
 * appends one entry here so the run's per-agent spend is queryable for the
 * resource panel + agents page.
 *
 * `agentDaemonId` / `dispatchTaskId` tie the call back to the agent + task;
 * `status` is the dispatch_task terminal state (`completed` | `failed`);
 * `usage` is the per-model token map the daemon aggregated; `cost` is an
 * optional monetary rollup the resource panel sums. All fields except the ids
 * are optional so a half-populated call (e.g. a failed task with no usage)
 * still records a durable link.
 */
export interface AgentDaemonCall {
  agentDaemonId?: string
  dispatchTaskId?: string
  durationMs?: number
  cost?: number
  status?: string
  /** Per-model token usage reported by the daemon (contracts `TokenUsage`). */
  usage?: Record<string, unknown>
  /** Backend session id; pass back via `ExecOptions.resumeSessionId` to resume. */
  sessionId?: string
  /** When the task reached its terminal state. Mirrors `dispatch_tasks.finished_at`. */
  finishedAt?: string
}

@Entity({ name: 'runs' })
@Index('idx_runs_workspace_status', ['workspaceId', 'status'])
@Index('idx_runs_parent', ['parentRunId'])
@Index('idx_runs_version_hash', ['pipelineVersionHash'])
export class Run {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** Human-readable run key (e.g. an external batch id / sequence number). */
  @Column({ type: 'text' })
  identifier!: string

  /** Flowise flow id the run executes (maps to `pipeline_id` in spec §5.3). */
  @Column({ name: 'pipeline_id', type: 'text' })
  pipelineId!: string

  /** Repro snapshot hash (M4); nullable until `bindRunToVersion` runs. */
  @Column({ name: 'pipeline_version_hash', type: 'char', length: 64, nullable: true })
  pipelineVersionHash!: string | null

  @Column({ type: 'text', default: 'pending' })
  status!: RunStatus

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null

  @Column({ name: 'created_by_run_id', type: 'uuid', nullable: true })
  createdByRunId!: string | null

  /** Parent run for fan-out children; null for a parent or a single run. */
  @Column({ name: 'parent_run_id', type: 'uuid', nullable: true })
  parentRunId!: string | null

  @Column({ type: 'jsonb', default: {} })
  input!: unknown

  @Column({ type: 'jsonb', nullable: true })
  output!: unknown

  @Column({ name: 'artifact_uri', type: 'text', nullable: true })
  artifactUri!: string | null

  @Column({ name: 'agent_daemon_calls', type: 'jsonb', default: [] })
  agentDaemonCalls!: AgentDaemonCall[]

  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 })
  cost!: number

  @Column({ name: 'trace_id', type: 'text', nullable: true })
  traceId!: string | null

  @Column({ name: 'workspace_id', type: 'text', nullable: true })
  workspaceId!: string | null

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null

  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs!: number | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
