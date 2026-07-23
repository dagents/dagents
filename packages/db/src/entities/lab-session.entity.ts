import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * A Lab experiment session (spec §6.2 `lab_sessions (id, name, desc, status,
 * workspace_id, created_at)`; plan M5b.2 / P1.10.T7; dependency table
 * P1.2.T9).
 *
 * Lab is the multi-agent collaboration room: an experiment session gathers
 * several agents (orchestrator / reader / coder / verifier / …) into one
 * threaded conversation that produces hypotheses, data, code, and reproducible
 * artifacts. A session runs in one of two modes — `auto` (agents collaborate
 * autonomously; a human message injects into the discussion) or `assist`
 * (every step waits for a human confirmation before dispatch) — toggled from
 * the chat header.
 *
 * `workspaceId` is a loose UUID reference to a `workspaces` row (the project
 * the experiment belongs to), NOT a FK: like `runs.workspace_id` (TEXT, no FK)
 * the platform keeps the binding editorial so a lab session survives a
 * workspace being archived/dropped without a cascading delete. It is nullable
 * so a free-form experiment unattached to a project is valid. `runs.workspace_id`
 * is TEXT while this is UUID — the lab read path never joins them, so the type
 * mismatch is harmless; if a later task needs the join it casts.
 *
 * `agentsCount` is an editorial rollup (how many agents are collaborating in
 * the session) the left list renders as "N agents"; it is updated when a
 * message from a new agent_id lands, not a live dispatch query. `mode` is open
 * TEXT + CHECK so a future `review` / `replay` mode can land without a
 * migration.
 *
 * Like the other entities in this package, this exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL (no entity class on the hot path — same decorator-free-reads rationale
 * as `workspaces` / `runs`).
 */
export type LabSessionStatus = 'running' | 'paused' | 'done'

/** The collaboration mode the chat header toggles. */
export type LabSessionMode = 'auto' | 'assist'

@Entity({ name: 'lab_sessions' })
@Index('idx_lab_sessions_workspace', ['workspaceId'])
@Index('idx_lab_sessions_status', ['status'])
export class LabSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** Human experiment name (e.g. "RL 论文复现 · skip-connect 替代 attention"). */
  @Column({ type: 'text' })
  name!: string

  /** Short description shown under the name in the session list. */
  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null

  /** Lifecycle: `running` sessions are active; `paused` wait for a human; `done` are archived. */
  @Column({ type: 'text', default: 'running' })
  status!: LabSessionStatus

  /**
   * Loose UUID reference to the owning workspace (NOT a FK — mirrors
   * `runs.workspace_id`'s no-FK posture). Nullable for a free-form experiment.
   */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null

  /** Collaboration mode (`auto` = agents self-organize; `assist` = human approves each step). */
  @Column({ type: 'text', default: 'auto' })
  mode!: LabSessionMode

  /** Editorial count of collaborating agents (the list "N agents" chip). */
  @Column({ name: 'agents_count', type: 'integer', default: 0 })
  agentsCount!: number

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
