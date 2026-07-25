import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

export type ChatStatus = 'idle' | 'running' | 'done' | 'failed'

@Entity({ name: 'chats' })
@Index('idx_chats_directory', ['directoryId', 'updatedAt'])
@Index('idx_chats_status', ['status'])
export class Chat {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'directory_id', type: 'uuid' })
  directoryId!: string

  @Column({ type: 'text' })
  title!: string

  @Column({ type: 'text', default: 'idle' })
  status!: ChatStatus

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId!: string | null

  @Column({ name: 'flow_id', type: 'text', nullable: true })
  flowId!: string | null

  @Column({ name: 'last_message', type: 'text', nullable: true })
  lastMessage!: string | null

  @Column({ name: 'message_count', type: 'int', default: 0 })
  messageCount!: number

  @Column({ name: 'last_run_id', type: 'uuid', nullable: true })
  lastRunId!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
