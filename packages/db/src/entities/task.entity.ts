import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * A platform-owned task row (spec §5.3, plan v0.3-M9.3).
 *
 * The gateway's `POST /api/v1/tasks` route materializes the design's
 * `new-task.html` submit payload (`title` / `description` /
 * `assigneeType:flow|agent|squad` / `assigneeId` / `creatorId` /
 * `workspaceId` / `contextRefs` / `priority` / `dueDate`) as one row here.
 * `assigneeType` routes the task onto one of two execution paths:
 *   - `flow`        → Path A (flow fan-out), the `path='flow'` run
 *   - `agent|squad` → Path B (direct-agent dispatch), the `path='direct'` run
 * A `runId` is minted per submission and written both here (`tasks.run_id`)
 * and onto a `runs` placeholder row (`runs.task_id` back-references this row,
 * `runs.path` records which path), so the create response
 * `{ task:{id,status,runId}, runId, path }` is honest.
 *
 * Like `Run` / `TokenMeta`, this entity exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL (see the `1720000008002` migration), so no entity class is loaded on the
 * hot path.
 *
 * No FK cascade to `workspaces` — `workspace_id` is a plain NOT NULL UUID
 * (same no-cascade posture as `agents`); workspace-deletion cleanup is the
 * application's responsibility.
 */

/** The design's `assigneeType` union (which execution path the task takes). */
export type TaskAssigneeType = 'flow' | 'agent' | 'squad'

/** The task-board status lifecycle (mirrors the `tasks_status_chk` CHECK). */
export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled'

/** The task priority (mirrors the `tasks_priority_chk` CHECK). */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

@Entity({ name: 'tasks' })
@Index('idx_tasks_workspace_status', ['workspaceId', 'status'])
@Index('idx_tasks_assignee', ['assigneeType', 'assigneeId'])
@Index('idx_tasks_parent', ['parentTaskId'])
@Index('idx_tasks_run', ['runId'])
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string

  @Column({ type: 'text' })
  title!: string

  @Column({ type: 'text', default: '' })
  description!: string

  @Column({ type: 'text', default: 'backlog' })
  status!: TaskStatus

  @Column({ type: 'text', default: 'none' })
  priority!: TaskPriority

  @Column({ name: 'assignee_type', type: 'text' })
  assigneeType!: TaskAssigneeType

  @Column({ name: 'assignee_id', type: 'text' })
  assigneeId!: string

  @Column({ name: 'creator_id', type: 'text' })
  creatorId!: string

  @Column({ name: 'parent_task_id', type: 'uuid', nullable: true })
  parentTaskId!: string | null

  @Column({ name: 'context_refs', type: 'jsonb', default: [] })
  contextRefs!: unknown[]

  @Column({ type: 'numeric', default: 0 })
  position!: number

  /** The run id minted at task creation; null until the run placeholder lands. */
  @Column({ name: 'run_id', type: 'text', nullable: true })
  runId!: string | null

  @Column({ name: 'due_date', type: 'timestamptz', nullable: true })
  dueDate!: Date | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
