import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm'

/**
 * daemons 表 entity（schema 定义 + 类型来源）。
 *
 * 2026-09-17 补齐：dispatch 表族此前只有 migration 没有 entity（entity
 * 覆盖率 ~1/3，新人无法从 entities/ 推断库结构）。与既有 entity 同款
 * 约定：schema 定义 + repository typing，热路径仍走 runQuery 参数化
 * raw SQL（见 run.entity.ts 头注释）。
 */
export type DaemonStatus = 'online' | 'offline' | 'draining'

@Entity({ name: 'daemons' })
@Index('idx_daemons_status', ['status'])
export class Daemon {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'text' })
  label!: string

  @Column({ type: 'text', nullable: true })
  endpoint!: string | null

  @Column({ type: 'text', default: 'online' })
  status!: DaemonStatus

  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeatAt!: Date | null

  @Column({ type: 'jsonb', default: [] })
  capabilities!: unknown[]

  @Column({ type: 'uuid', nullable: true })
  workspaceId!: string | null

  @Column({ type: 'text' })
  token!: string

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date
}
