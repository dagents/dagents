import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A reproducible snapshot of a flow's JSON (spec §5.3, architecture v0.2 §5.3;
 * plan M4.1 / P1.2.T5 + P1.8.T2).
 *
 * Originally created to补 Flowise 无版本锁定的短板 (architecture v0.2 §5.3):
 * the platform owns `pipeline_versions` as the immutable content-addressed
 * snapshot — the full flow JSON plus its SHA-256, with `version_hash` UNIQUE
 * so a re-snapshot of an unchanged flow reuses the same row. `pipeline_id` is
 * the flow id.
 *
 * NOTE: The runtime consumer (`@dagents/repro`) was removed on 2026-08-01
 * (its sole caller, apps/scheduler, was merged into gateway without migrating
 * the repro integration). This entity + migration are retained for schema
 * continuity; the table currently has no runtime readers or writers. If
 * run-reproducibility is re-introduced, this is the seam to wire back in.
 *
 * Like `Run`, this entity exists for schema definition + repository typing;
 * no entity class is loaded on the hot path (same decorator-free-reads
 * rationale as `token_meta` / `runs`).
 */

@Entity({ name: 'pipeline_versions' })
@Index('idx_pipeline_versions_pipeline_id', ['pipelineId'])
@Index('idx_pipeline_versions_version_hash', ['versionHash'], { unique: true })
export class PipelineVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** Flowise flow id the snapshot was taken from (maps to `pipeline_id` in spec §5.3). */
  @Column({ name: 'pipeline_id', type: 'text' })
  pipelineId!: string

  /** SHA-256 of the canonical flow JSON — the content address + dedup key. */
  @Column({ name: 'version_hash', type: 'char', length: 64 })
  versionHash!: string

  /** The full flow JSON at snapshot time (immutable). */
  @Column({ name: 'flow_json', type: 'jsonb' })
  flowJson!: unknown

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  /** Free-form version note (optional). */
  @Column({ name: 'note', type: 'text', nullable: true })
  note!: string | null
}
