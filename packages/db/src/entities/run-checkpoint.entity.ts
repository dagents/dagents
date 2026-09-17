import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * run_checkpoints 表 entity（断点续跑 §6.1）—— 执行控制态快照。
 * schema 定义 + 类型来源；热路径 raw SQL（run-checkpoints.repo.ts）。
 * 与 run_node_spans 的职责分离：spans=观测态（末次覆盖），checkpoint=控制态。
 */
export type RunCheckpointStatus = 'running' | 'awaiting_input' | 'resumable' | 'terminal'

export interface CheckpointAwaiting {
  nodeId: string
  prompt: string
  inputType: string
  options: unknown[]
  /** 应答时限（ISO）；过期由 boot sweep 收敛为 failed。 */
  deadlineAt: string
}

@Entity({ name: 'run_checkpoints' })
@Index('idx_run_checkpoints_status', ['status'])
export class RunCheckpoint {
  /** 首个 run 的 id；续跑更新此行而不建新行（谱系见 runs.resumed_from_run_id）。 */
  @PrimaryColumn({ type: 'uuid' })
  runId!: string

  @Column({ type: 'uuid' })
  flowId!: string

  @Column({ type: 'text' })
  status!: RunCheckpointStatus

  /** 拓扑指纹（节点 id/类型/出边 序列化 SHA-1）—— 续跑护栏。 */
  @Column({ type: 'text', name: 'topo_hash' })
  topoHash!: string

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>

  /** status='awaiting_input' 时的挂起载荷。 */
  @Column({ type: 'jsonb', nullable: true })
  awaiting!: CheckpointAwaiting | null

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}
