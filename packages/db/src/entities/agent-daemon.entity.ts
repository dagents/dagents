import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

/**
 * agent_daemons 表 entity —— agent 与承载 daemon 的桥接表（或
 * inline-executor 的 executable_path 登记，daemon_id 可空，见
 * migration 1720000016000）。schema 定义 + 类型来源；热路径 raw SQL。
 */
@Entity({ name: 'agent_daemons' })
export class AgentDaemon {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'text' })
  name!: string

  @Column({ type: 'text' })
  kind!: string

  /** null = inline-executor agent（网关直接 spawn，无 daemon 进程）。 */
  @Column({ type: 'uuid', nullable: true })
  daemonId!: string | null

  @Column({ type: 'jsonb', default: {} })
  capabilityDescriptor!: Record<string, unknown>

  @Column({ type: 'text', nullable: true })
  executablePath!: string | null

  @Column({ type: 'jsonb', default: [] })
  defaultArgs!: unknown[]

  @Column({ type: 'uuid', nullable: true })
  workspaceId!: string | null

  @Column({ type: 'text', nullable: true })
  visibility!: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}
