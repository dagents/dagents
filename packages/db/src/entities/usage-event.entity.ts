import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm'

/**
 * usage_events 表 entity —— 成本账单唯一真相源（AD-3 方案 D：chat /
 * workflow run / dispatch task 终态各记一条，append-only）。
 * schema 定义 + 类型来源；热路径 raw SQL（usage-events.ts）。
 */
export type UsageEventSource = 'chat' | 'workflow_run' | 'dispatch_task'

@Entity({ name: 'usage_events' })
@Index('idx_usage_events_created_at', ['createdAt'])
@Index('idx_usage_events_chat_id', ['chatId'])
@Index('idx_usage_events_run_id', ['runId'])
export class UsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @Column({ type: 'text' })
  source!: UsageEventSource

  @Column({ type: 'uuid', nullable: true })
  chatId!: string | null

  @Column({ type: 'uuid', nullable: true })
  runId!: string | null

  @Column({ type: 'uuid', nullable: true })
  taskId!: string | null

  @Column({ type: 'uuid', nullable: true })
  agentId!: string | null

  @Column({ type: 'text', nullable: true })
  flowId!: string | null

  @Column({ type: 'text', nullable: true })
  model!: string | null

  @Column({ type: 'jsonb' })
  usage!: Record<string, unknown>

  @Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
  cost!: string | null

  @Column({ type: 'boolean', default: false })
  priced!: boolean
}
