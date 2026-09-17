import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm'

/**
 * dispatch_task_events 表 entity —— 每任务的流式消息/进度事件，
 * (task_id, seq) 唯一索引保证有序（1720000095000）。
 */
@Entity({ name: 'dispatch_task_events' })
@Index('uq_dispatch_task_events_task_seq', ['taskId', 'seq'], { unique: true })
export class DispatchTaskEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  taskId!: string

  @Column({ type: 'text' })
  kind!: 'message' | 'progress' | 'status'

  @Column({ type: 'integer' })
  seq!: number

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date
}
