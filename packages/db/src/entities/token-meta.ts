import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

/**
 * Local metadata for a new-api token (spec §6.2, plan M2.8 / P1.2.T7).
 *
 * new-api is the system of record for the token *key* and its quota/lifecycle
 * status — the gateway proxies new-api's `/api/token/*` CRUD so the frontend
 * never talks to new-api directly. This table holds only the local editorial
 * metadata new-api does not store: a human label, the owning workspace, and the
 * result of the gateway's own health probe.
 *
 * ⚠️ The raw key is NEVER stored here. `newapi_token_id` is the int id new-api
 * assigns to the token row; the key itself lives only in new-api (and is
 * returned masked by new-api's API, so it never reaches this table either).
 */
export type TokenHealthStatus =
  // probe has not run yet, or new-api reports the token enabled
  | 'unknown'
  | 'active'
  // new-api status=2 (manually disabled) — treat as disabled, not rate-limited
  | 'disabled'
  // new-api status=3 (expired)
  | 'expired'
  // new-api status=4 (quota exhausted)
  | 'exhausted'
  // upstream returned 429 on the last probe — transient, distinct from disabled
  | 'rate_limited'
  // probe could not reach new-api / unexpected response — health unknown
  | 'error'

@Entity({ name: 'token_meta' })
@Index('idx_token_meta_workspace', ['workspaceId'])
@Index('idx_token_meta_status', ['status'])
export class TokenMeta {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** new-api's integer token id (tokens.id) — the join key to new-api. */
  @Index({ unique: true })
  @Column({ name: 'newapi_token_id', type: 'bigint' })
  newapiTokenId!: number

  /** Human label shown in the console. Mirrors new-api `name` but owned here. */
  @Column({ name: 'name', type: 'text' })
  name!: string

  /** new-api group the token belongs to (e.g. "default"). */
  @Column({ name: 'group', type: 'text', default: 'default' })
  group!: string

  /** Free-form operator note — local-only, new-api has no equivalent. */
  @Column({ name: 'remark', type: 'text', nullable: true })
  remark!: string | null

  /** Console visibility ("private" | "workspace" | "public"). Local-only. */
  @Column({ name: 'visibility', type: 'text', default: 'workspace' })
  visibility!: string

  /** Owning workspace; null for platform-scoped tokens. */
  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null

  /** Last probe result — written by the health-probe worker (P1.4.T8). */
  @Column({ name: 'status', type: 'text', default: 'unknown' })
  status!: TokenHealthStatus

  /** When the probe last ran (UTC). null until the first probe completes. */
  @Column({ name: 'last_probed_at', type: 'timestamptz', nullable: true })
  lastProbedAt!: Date | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
