import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * Who or what performed a sensitive operation (spec §1.4 gateway 职责 #5
 * "审计日志（敏感操作）"; plan M6.6 / P1.4.T6; risk R15).
 *
 * The gateway is the single choke point for key / permission / version-lock /
 * token-rotation mutations, so it owns the audit trail. An `actor` is either a
 * human user (authenticated via SSO, identified by `x-user-id` /
 * `x-client-id` headers the SSO middleware stamps) or a system principal (the
 * gateway itself, or an internal service driving a rotation). `actor_type` is
 * kept as open TEXT with a CHECK so new principal kinds (agent, daemon) can be
 * added without a migration, mirroring `runs.status`.
 */
export type AuditActorType = 'user' | 'system'

/**
 * The kind of object a sensitive operation targeted. Open TEXT + CHECK for the
 * same extensibility reason as `actor_type` — new audited resources (workspace,
 * agent_daemon, …) land without a migration.
 */
export type AuditTargetType = 'token' | 'pipeline_version' | 'llm_provider'

/**
 * One durable audit record for a sensitive operation (spec §1.4 gateway 职责 #5;
 * plan M6.6 / P1.4.T6; risk R15 — token-rotation misuse needs an audit trail).
 *
 * Like `token_meta` / `runs`, this entity exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL in the gateway, so no entity class is loaded on the hot path.
 *
 * `run_id` reuses the OTel-threaded run id (M6.1) so an audit record can be
 * correlated end-to-end with the trace that performed it. `detail` is a jsonb
 * blob for operation-specific context (e.g. which fields a token PUT changed,
 * which version hash a lock pinned) — never the raw key.
 */
@Entity({ name: 'audit_log' })
@Index('idx_audit_log_created_at', ['createdAt'])
@Index('idx_audit_log_actor', ['actorType', 'actorId'])
@Index('idx_audit_log_target', ['targetType', 'targetId'])
@Index('idx_audit_log_run_id', ['runId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** Who performed the op: 'user' (SSO-authed) or 'system' (gateway/internal). */
  @Column({ name: 'actor_type', type: 'text' })
  actorType!: AuditActorType

  /** Stable id of the actor (user id, or a system label like 'gateway'). */
  @Column({ name: 'actor_id', type: 'text' })
  actorId!: string

  /** The sensitive action, e.g. 'token.create' / 'token.update' / 'token.delete' / 'pipeline_version.lock'. */
  @Column({ name: 'action', type: 'text' })
  action!: string

  /** Kind of object targeted ('token' | 'pipeline_version' | …). */
  @Column({ name: 'target_type', type: 'text' })
  targetType!: AuditTargetType

  /** Id of the target object (new-api token id, version hash, …). Stored as text to mix id shapes. */
  @Column({ name: 'target_id', type: 'text' })
  targetId!: string

  /** OTel-threaded run id (M6.1) for end-to-end trace correlation; null when no run context. */
  @Column({ name: 'run_id', type: 'text', nullable: true })
  runId!: string | null

  /** Owning workspace; null for platform-scoped ops. */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null

  /** Operation-specific context (changed fields, pinned hash, …). NEVER the raw key. */
  @Column({ name: 'detail', type: 'jsonb', default: {} })
  detail!: unknown

  /** Caller IP (best-effort, from x-forwarded-for / remote addr). */
  @Column({ name: 'ip', type: 'text', nullable: true })
  ip!: string | null

  /** Caller User-Agent (best-effort). */
  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
