import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm'

/**
 * `run_node_journal` 行（2026-10-07 可恢复性 R1/R7，design-recover §1.1）。
 *
 * 单表两用（kind 判别）：
 *  - `decision`：节点终态的决策记录（onNodeEnd 写；无完成记录 = 重跑）——
 *    resume 种子与暖缓存复用的真相源。payload =
 *    `{ status: 'done'|'failed'|'cached', inputHash, input, output, tokens,
 *    resolvedModel, lineage?: { inheritedFromRunId, inheritedTokens } }`。
 *  - `event`：R7 事件流——payload = RunLiveFrame 原样（含 at/seq 原值）；
 *    回放 = kind='event' 行按 seq 排序。event 行的 runEnd 帧 node_id='__run__'。
 *
 * 与 run_node_spans 的分工：spans 是观测投影（(run_id, node_id) 末次覆盖，
 * console 既有消费契约），本表是唯一真相源（AD-R1/AD-R2）。同 runs 一样，
 * 本 entity 只服务 schema 定义 + 类型，运行时查询走 raw SQL（写侧
 * journal-writer / 读侧 run-node-journal.repo，均在 gateway）。
 */

export type RunNodeJournalKind = 'decision' | 'event'

/** decision 行 payload 的结构化读型（写侧单点构造，读侧 as 收窄）。 */
export interface JournalDecisionPayload {
  status: 'done' | 'failed' | 'cached'
  inputHash?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  tokens?: unknown
  resolvedModel?: string
  lineage?: { inheritedFromRunId: string; inheritedTokens?: number }
}

@Entity({ name: 'run_node_journal' })
@Index('uq_run_node_journal_run_seq', ['runId', 'seq'], { unique: true })
@Index('idx_run_node_journal_lookup', ['runId', 'nodeId', 'kind'])
export class RunNodeJournal {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** 归属 run（FK-shaped → runs.id，无硬 FK——半记录 run 不被约束阻塞）。 */
  @Column({ name: 'run_id', type: 'uuid' })
  runId!: string

  /** flow id（TEXT 对齐 spans.flow_id / runs.pipeline_id 的 de facto）。 */
  @Column({ name: 'flow_id', type: 'text' })
  flowId!: string

  /** 节点 id；event 行的 runEnd 帧 = '__run__'。 */
  @Column({ name: 'node_id', type: 'text' })
  nodeId!: string

  /** per-node 执行实例序号（AD-R4：非迭代节点恒 0；迭代 body 第 n 次执行 = n）。 */
  @Column({ type: 'integer', default: 0 })
  ordinal!: number

  @Column({ type: 'text' })
  kind!: RunNodeJournalKind

  /** per-run 单调全序（registry emit() 单点分配，AD-R5）。 */
  @Column({ type: 'bigint' })
  seq!: string

  /** event 行：nodeStart/nodeEnd/runEnd/delta；decision 行 NULL。 */
  @Column({ name: 'event_type', type: 'text', nullable: true })
  eventType!: string | null

  /** decision：决策载荷；event：RunLiveFrame 原样。 */
  @Column({ type: 'jsonb', default: {} })
  payload!: unknown

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
