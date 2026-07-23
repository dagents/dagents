import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * A project workspace (spec §5.3 `workspaces (id, name, owner_user_id)`; plan
 * M5b.1 / P1.10.T6, dependency table P1.2.T8).
 *
 * A workspace is the per-project isolation boundary for human↔agent
 * conversation: members, associated flows, produced artifacts, and a monthly
 * quota roll up under it. `runs.workspace_id`, `token_meta.workspace_id`, and
 * the dispatch `workspace_id` columns all reference a row here.
 *
 * The MVP has no SSO user table yet (P1.4.T2 lands better-auth), so
 * `ownerUserId` is a free TEXT holding the SSO subject / a stable id — same
 * open-id posture as `runs.created_by_user_id` is `uuid`, but workspaces may
 * be owned by principals that aren't platform users yet (a team label). When
 * the users table lands it can backfill + constrain this without a rewrite.
 *
 * Like the other entities in this package, this exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL, so no entity class is loaded on the hot path (same decorator-free-reads
 * rationale as `token_meta` / `runs`).
 *
 * `quota` is a jsonb blob carrying the monthly cost / runs / token caps + used
 * counters the meta panel renders (design/workspace.html "配额（本月）"). It is
 * editorial: a later worker rolls `runs` / `agent_daemon_calls` up into the
 * `used` fields; the gateway read API returns it verbatim.
 */
@Entity({ name: 'workspaces' })
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** Human project name (e.g. "论文复现 · RL"). */
  @Column({ type: 'text' })
  name!: string

  /** Short description shown under the name in the project list. */
  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null

  /**
   * Stable id of the owning principal (SSO subject, or a team label). Free
   * TEXT until the users table lands (P1.4.T2 / P1.2.T6).
   */
  @Column({ name: 'owner_user_id', type: 'text', nullable: true })
  ownerUserId!: string | null

  /** Lifecycle: `active` projects are listed; `archived` are hidden by default. */
  @Column({ type: 'text', default: 'active' })
  status!: string

  /** Monthly quota caps + used counters (cost / runs / tokens) for the meta panel. */
  @Column({ type: 'jsonb', default: {} })
  quota!: unknown

  /** Optional glyph/initials the list shows in the project chip (defaults to name[0]). */
  @Column({ type: 'text', nullable: true })
  glyph!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
