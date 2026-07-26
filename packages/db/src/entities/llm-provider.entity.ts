import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

export type LlmProviderStatus = 'active' | 'disabled'

@Entity({ name: 'llm_providers' })
@Index('idx_llm_providers_directory', ['directoryId'])
@Index('idx_llm_providers_status', ['status'])
export class LlmProvider {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'directory_id', type: 'uuid', nullable: true })
  directoryId!: string | null

  @Column({ type: 'text' })
  name!: string

  @Column({ name: 'provider_type', type: 'text', default: 'openai_compatible' })
  providerType!: string

  @Column({ name: 'base_url', type: 'text' })
  baseUrl!: string

  @Column({ name: 'api_key', type: 'text' })
  apiKey!: string

  @Column({ name: 'default_model', type: 'text' })
  defaultModel!: string

  @Column({ type: 'jsonb', default: '[]' })
  models!: unknown[]

  @Column({ type: 'text', default: 'active' })
  status!: LlmProviderStatus

  @Column({ type: 'text', nullable: true })
  remark!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
