import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity({ name: 'directories' })
export class Directory {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'text', unique: true })
  path!: string

  @Column({ type: 'text' })
  name!: string

  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
