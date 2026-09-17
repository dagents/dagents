import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm'

/**
 * dispatch_tasks 表 entity —— daemon 工作队列（queued → claimed →
 * running → 终态）。schema 定义 + 类型来源；热路径 raw SQL（dispatch
 * routes + service）。
 */
export type DispatchTaskStatus = 'queued' | 'claimed' | 'running' | 'completed' | 'failed'

@Entity({ name: 'dispatch_tasks' })
@Index('idx_dispatch_tasks_status_agent', ['status', 'agentDaemonId'])
@Index('idx_dispatch_tasks_run', ['runId'])
export class DispatchTask {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  agentDaemonId!: string

  @Column({ type: 'text' })
  runId!: string

  @Column({ type: 'text' })
  prompt!: string

  @Column({ type: 'jsonb' })
  execOptions!: Record<string, unknown>

  @Column({ type: 'text', default: 'queued' })
  status!: DispatchTaskStatus

  @Column({ type: 'uuid', nullable: true })
  claimedByDaemonId!: string | null

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null

  @Column({ type: 'text', nullable: true })
  sessionId!: string | null

  @Column({ type: 'jsonb', nullable: true })
  usage!: Record<string, unknown> | null

  @Column({ type: 'integer', nullable: true })
  durationMs!: number | null

  /** gateway 侧取消意图标记（幂等，见 1720000094000）。 */
  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt!: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt!: Date | null
}
