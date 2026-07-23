import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A reproducible snapshot of a Flowise flow's JSON (spec §5.3, architecture v0.2
 * §5.3; plan M4.1 / P1.2.T5 + P1.8.T2).
 *
 * Flowise has no native version locking (architecture v0.2 §5.3 "补 Flowise 无
 * 版本锁定的短板"), so the platform owns `pipeline_versions` as the immutable
 * content-addressed snapshot: the full flow JSON plus its SHA-256, with
 * `version_hash` UNIQUE so a re-snapshot of an unchanged flow reuses the same
 * row instead of duplicating it. `pipeline_id` is the Flowise flow id.
 *
 * Like `Run`, this entity exists for schema definition + repository typing;
 * runtime queries go through `runQuery` parameterised raw SQL in `packages/repro`,
 * so no entity class is loaded on the hot path (same decorator-free-reads
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
