import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * Flow entity representing a visual workflow definition with nodes and edges.
 *
 * Stores the complete flow structure including node positions, edge connections,
 * and viewport state for the flow editor. Supports draft, published, and archived
 * lifecycle states.
 */
@Entity({ name: 'flows' })
@Index('idx_flows_status', ['status'])
@Index('idx_flows_name', ['name'])
export class Flow {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ length: 255 })
  name!: string

  @Column({ type: 'text', nullable: true })
  description!: string | null

  @Column({ type: 'jsonb', name: 'flow_data' })
  flowData!: {
    nodes: Array<{
      id: string
      position: { x: number; y: number }
      type?: string
      data: Record<string, unknown>
      width?: number
      height?: number
    }>
    edges: Array<{
      id: string
      source: string
      target: string
      sourceHandle?: string | null
      targetHandle?: string | null
      type?: string
      animated?: boolean
      data?: { label?: string }
      label?: string
    }>
    viewport?: { x: number; y: number; zoom: number }
  }

  @Column({ length: 32, default: 'draft' })
  status!: 'draft' | 'published' | 'archived'

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
