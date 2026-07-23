import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A workspace ↔ flow association (spec §6.2 `workspace_flows (workspace_id,
 * pipeline_id)`; plan M5b.1 / P1.10.T6; dependency table P1.2.T8).
 *
 * A project links zero or more Flowise agentflows it runs against. `pipelineId`
 * is the Flowise flow id (maps to `runs.pipeline_id` / `pipeline_versions.pipeline_id`),
 * NOT a FK to a local table — Flowise owns flow definitions, the platform only
 * records the binding. The meta panel renders each linked flow's name/status
 * (fetched live from Flowise by the gateway read API, not stored here).
 *
 * One row per (workspace, pipeline) pair — UNIQUE so re-linking a flow is
 * idempotent. `note` is an optional local label ("论文批量复现流水线").
 *
 * Like the other entities in this package, this exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL (no entity class on the hot path).
 */
@Entity({ name: 'workspace_flows' })
@Index('idx_workspace_flows_workspace', ['workspaceId'])
@Index('idx_workspace_flows_pipeline', ['pipelineId'])
@Index('idx_workspace_flows_workspace_pipeline', ['workspaceId', 'pipelineId'], { unique: true })
export class WorkspaceFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string

  /** Flowise flow id the workspace links (maps to runs.pipeline_id). */
  @Column({ name: 'pipeline_id', type: 'text' })
  pipelineId!: string

  /** Optional local note for the linked flow ("论文批量复现流水线 · v2.3.1"). */
  @Column({ type: 'text', nullable: true })
  note!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
