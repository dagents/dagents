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

/**
 * runs.status 词表（2026-10-07 可恢复性地基对齐九值，与迁移 1720000111000
 * 的 CHECK 同源）：`awaiting_input/partial_success/budget_exceeded` 是引擎
 * 既有产出（此前 TS 词表落后于 DB CHECK）；`stopped` 是 R3 状态机新终态
 * （boot sweep / 用户取消写新）。`cancelled` 显式保留——存量行写新读旧
 * （NFR-1），新写方一律落 stopped + stop_reason。
 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'partial_success'
  | 'budget_exceeded'
  | 'failed'
  | 'stopped'
  | 'cancelled'

/**
 * runs.stop_reason 词表（AD-R7，R3 状态机）：stopped 行 user（旧 cancelled
 * 写新）/ interrupted（boot sweep）/ superseded（chat 域 latest-wins）；failed
 * 行 model（默认）/ provider（pin 拒绝降级）；其余状态行恒 NULL。五值无死值。
 */
export type RunStopReason = 'user' | 'interrupted' | 'superseded' | 'model' | 'provider'

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

  /**
   * Repro snapshot hash (M4); nullable. The runtime consumer (`@dagents/repro`)
   * was removed on 2026-08-01 — this column is currently always NULL. Retained
   * for schema continuity; re-wire if run-reproducibility is re-introduced.
   */
  @Column({ name: 'pipeline_version_hash', type: 'char', length: 64, nullable: true })
  pipelineVersionHash!: string | null

  @Column({ type: 'text', default: 'pending' })
  status!: RunStatus

  /**
   * 中止/失败来源（R3 状态机，迁移 1720000111000）：见 RunStopReason 词表。
   * 非 stopped/failed 行恒 NULL；存量行零回填。
   */
  @Column({ name: 'stop_reason', type: 'text', nullable: true })
  stopReason!: RunStopReason | null

  /**
   * persona 创建期冻结快照（R8/AD-R6，迁移 1720000111000）：
   * `{ [agentId]: { instructions, model, kind, skills } }`——resume 跨进程
   * 注入闭包 fetcher 的持久载体；可选同批承载会话映射
   * `sessions: { [deriveSessionId]: backendSessionId }`（§1.2）。
   */
  @Column({ name: 'frozen_agents', type: 'jsonb', nullable: true })
  frozenAgents!: Record<string, unknown> | null

  /** run 级模型快照（R8，迁移 1720000111000）：`{ [nodeId]: resolvedModel }`。 */
  @Column({ type: 'jsonb', nullable: true })
  models!: Record<string, string> | null

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null

  @Column({ name: 'created_by_run_id', type: 'uuid', nullable: true })
  createdByRunId!: string | null

  /** Parent run for fan-out children; null for a parent or a single run. */
  @Column({ name: 'parent_run_id', type: 'uuid', nullable: true })
  parentRunId!: string | null

  // ── 活跃列（gateway 用 raw SQL 读写，entity 此前漏声明 —— 2026-08-16 补齐） ──

  /** 派发任务 id（dispatch_tasks.id，任务↔运行联动迁移 1720000008002）。 */
  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId!: string | null

  /** 关联 agent（agent_daemons.id）。 */
  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId!: string | null

  /** 运行工作目录（agent 执行 cwd）。 */
  @Column({ type: 'text', nullable: true })
  path!: string | null

  /** 关联聊天（chat-tables 迁移 1720000009000）。 */
  @Column({ name: 'chat_id', type: 'uuid', nullable: true })
  chatId!: string | null

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
