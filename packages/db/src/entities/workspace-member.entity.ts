import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A workspace ↔ member link (spec §6.2 `workspace_members (workspace_id,
 * user_id, role)`; plan M5b.1 / P1.10.T6; dependency table P1.2.T8).
 *
 * One row per (workspace, member) pair. `memberId` is a free TEXT stable id
 * (SSO subject / a team label) until the users table lands — same open-id
 * posture as `workspaces.owner_user_id`. `role` is open TEXT + CHECK so the
 * design's owner / editor / viewer set can grow without a migration.
 *
 * `displayName` + `initial` are local editorial fields the meta panel renders
 * (the platform has no user profile table yet, so the member's label lives
 * here). When SSO lands these can be sourced from the user record instead.
 *
 * Like the other entities in this package, this exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL (no entity class on the hot path).
 */
export type WorkspaceMemberRole = 'owner' | 'editor' | 'viewer'

@Entity({ name: 'workspace_members' })
@Index('idx_workspace_members_workspace', ['workspaceId'])
@Index('idx_workspace_members_member', ['memberId'])
@Index('idx_workspace_members_workspace_member', ['workspaceId', 'memberId'], { unique: true })
export class WorkspaceMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string

  /**
   * Stable id of the member (SSO subject / team label). Free TEXT until the
   * users table lands (P1.4.T2 / P1.2.T6).
   */
  @Column({ name: 'member_id', type: 'text' })
  memberId!: string

  /** Display name shown in the meta panel (local editorial; no user table yet). */
  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName!: string | null

  /** Avatar initial(s) the meta panel renders (local editorial). */
  @Column({ type: 'text', nullable: true })
  initial!: string | null

  /** Membership role (owner / editor / viewer). Open TEXT + CHECK for extensibility. */
  @Column({ type: 'text', default: 'viewer' })
  role!: WorkspaceMemberRole

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
