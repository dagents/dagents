import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'

@Entity({ name: 'chat_messages' })
@Index('idx_chat_messages_chat', ['chatId', 'createdAt'])
@Index('idx_chat_messages_run', ['runId'])
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'chat_id', type: 'uuid' })
  chatId!: string

  @Column({ type: 'text' })
  role!: ChatMessageRole

  @Column({ type: 'text' })
  content!: string

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId!: string | null

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
