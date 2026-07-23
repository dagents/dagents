import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * One threaded message in a Lab session (spec §6.2 `lab_messages (id,
 * session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call,
 * created_at)`; plan M5b.2 / P1.10.T7; dependency table P1.2.T9).
 *
 * The Lab chat room is a threaded multi-agent conversation. A message carries
 * a `role` (who spoke), an optional `agentId` (which agent — orchestrator /
 * reader / coder / verifier / …, null for a human turn), the `body` (the
 * rendered text), and two structured blocks the design surfaces inline:
 *
 *   - `thinking` — the agent's private reasoning (rendered as an italic
 *     left-bordered note, "💭 …"). Populated from the daemon's `thinking`
 *     AgentEvent (contracts `AgentEvent` `thinking` variant) or Flowise's
 *     `agentReasoning` SSE event; null for plain turns.
 *   - `toolCall` — a structured `{ name, input, output }` blob the design
 *     renders as a mono "🛠 tool" card. Populated from the daemon's `tool-use`/
 *     `tool-result` events (contracts `AgentEvent`) collapsed into one row, or
 *     Flowise's `usedTools`/`calledTools` SSE event; null when the turn made no
 *     tool call. Stored jsonb so the shape can grow (args, duration, status).
 *
 * Threading: `parentId` is a self-reference to the message this one replies to
 * (null for a top-level turn). The MVP renders the thread as a flat
 * chronological stream grouped by day (matching design/lab.html), so `parentId`
 * is recorded for future reply indentation without driving the MVP layout —
 * `messagesToThread` walks `created_at` order. A reply link is still durable:
 * a `parent_id` set on append lets a later tree view reconstruct the structure
 * without a re-migration.
 *
 * `runId` reuses the OTel-threaded run id (M6.1) so a lab message is
 * end-to-end traceable into the gateway/dispatch/daemon/Flowise trace that
 * produced it. It is free TEXT (not a FK to `runs.id`) for the same open-id
 * posture `runs` itself takes for its ids.
 *
 * Like the other entities in this package, this exists for schema definition +
 * repository typing; runtime queries go through `runQuery` parameterised raw
 * SQL (no entity class on the hot path).
 */

/** Who authored a lab message. Open TEXT + CHECK so new agent kinds land without a migration. */
export type LabMessageRole = 'human' | 'orchestrator' | 'reader' | 'coder' | 'verifier' | 'system'

/**
 * The structured tool-call block the chat renders as a mono "🛠 tool" card.
 * Populated from the daemon's `tool-use` + `tool-result` AgentEvents (contracts)
 * collapsed into one row, or Flowise's `usedTools`/`calledTools` SSE event.
 * Stored jsonb so the shape can grow (args, duration, status) without a migration.
 */
export interface LabToolCall {
  /** Tool / function name (e.g. "read_paper", "run_sandbox", "eval_compare"). */
  name: string
  /** Input the tool was called with (a short string for the card's `.td` line). */
  input?: string
  /** Output the tool returned (a short string for the card's `.tr` line). */
  output?: string
}

@Entity({ name: 'lab_messages' })
@Index('idx_lab_messages_session', ['sessionId'])
@Index('idx_lab_messages_parent', ['parentId'])
@Index('idx_lab_messages_run_id', ['runId'])
export class LabMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  /** The session this message belongs to. FK → lab_sessions(id) ON DELETE CASCADE. */
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string

  /** Self-reference to the message this replies to (null = top-level turn). */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null

  /** Who spoke. `human` for an intervention; agent roles otherwise. */
  @Column({ type: 'text' })
  role!: LabMessageRole

  /**
   * Stable id of the agent that spoke (e.g. "orchestrator-01", "reader-04"),
   * null for a human turn. Free TEXT — the platform has no agent-identity
   * table yet (the dispatch `agent_daemons` table keys daemons, not turns).
   */
  @Column({ name: 'agent_id', type: 'text', nullable: true })
  agentId!: string | null

  /** OTel-threaded run id (M6.1) for end-to-end trace correlation; null when no run context. */
  @Column({ name: 'run_id', type: 'text', nullable: true })
  runId!: string | null

  /** The message body (the rendered text). */
  @Column({ type: 'text' })
  body!: string

  /** The agent's private reasoning (the "💭 …" italic note); null for plain turns. */
  @Column({ type: 'text', nullable: true })
  thinking!: string | null

  /** Structured `{ name, input, output }` tool-call block (jsonb); null when no tool call. */
  @Column({ name: 'tool_call', type: 'jsonb', nullable: true })
  toolCall!: LabToolCall | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
