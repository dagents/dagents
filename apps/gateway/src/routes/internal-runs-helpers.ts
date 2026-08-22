import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { wsHub } from '../ws-hub.js'
import { recordUsageEvent } from '../usage-events.js'
import type { TokenUsage } from '@dagents/contracts'

const log = createLogger({ svc: 'gateway:internal-runs-helpers' })

export interface CompleteParams {
  chatId: string
  runId: string
  output: string
  status: 'completed' | 'failed'
  usage?: TokenUsage
  durationMs?: number
  cost?: number
  /**
   * AD-3 usage_event 溯源字段（chat 终态入账，方案 D a 路径）。inline
   * executor 传入；HTTP 回调 / @flow 路径没有对应信息时缺省（null）。
   */
  agentId?: string
  model?: string | null
}

/**
 * Persist an assistant message for a run, mark the chat idle, and broadcast
 * `chat:done` via WebSocket. Shared by:
 *   - `internal-runs.ts` (HTTP callback from scheduler/dispatch)
 *   - `chat-execute.ts` `routeFlowCommand` (in-process @flow execution)
 *   - `inline-executor.ts` `executeInline` (CLI chat execution)
 *
 * Additionally appends one `usage_events` row (source='chat') whenever the
 * terminal state carries token usage — the billing truth source (AD-3).
 * The event write is fire-and-forget: `recordUsageEvent` never throws and
 * never blocks the persist path.
 *
 * `runId` MUST be a real UUID — `chat_messages.run_id` is a uuid column
 * (see chat-message.entity.ts). Callers should use `randomUUID()`.
 *
 * Returns the persisted `messageId`. Throws on DB failure so callers can
 * decide how to surface the error (the HTTP route maps it to 502; the
 * in-process route logs and swallows).
 */
export async function persistComplete(params: CompleteParams): Promise<string> {
  const messageId = randomUUID()
  const metadata: Record<string, unknown> = {
    runId: params.runId,
    status: params.status,
  }
  if (params.usage) metadata.usage = params.usage
  if (params.durationMs != null) metadata.durationMs = params.durationMs
  if (params.cost != null) metadata.cost = params.cost

  await runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
    [messageId, params.chatId, params.output, params.runId, JSON.stringify(metadata)],
  )
  await runQuery(
    `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
    [params.chatId],
  )

  wsHub.broadcastChat(params.chatId, {
    type: 'chat:done',
    chatId: params.chatId,
    runId: params.runId,
    role: 'assistant',
    content: params.output,
    streaming: false,
    status: params.status,
    usage: params.usage,
    durationMs: params.durationMs,
    cost: params.cost,
  })

  log.info('persistComplete ok', { runId: params.runId, chatId: params.chatId, messageId })

  // AD-3（方案 D a 路径）：chat 终态带 usage 时追加一条 usage_events
  // （source='chat'）。recordUsageEvent 内部自行跳过全空 usage、吞掉 DB
  // 错误 —— 不 await 也不影响 persist 的返回语义。
  if (params.usage) {
    void recordUsageEvent({
      source: 'chat',
      chatId: params.chatId,
      runId: params.runId,
      agentId: params.agentId ?? null,
      model: params.model ?? null,
      usage: params.usage,
      cost: params.cost,
    })
  }
  return messageId
}

/**
 * Persist the terminal state of a user-cancelled execution: an assistant
 * message carrying status='cancelled', the chat back to idle, and a
 * `chat:cancelled` WS broadcast (execution-cancellation spec D6) so the
 * console can seal the streaming bubble. Distinct from `persistComplete` —
 * cancelled is not failed, and the client renders it differently.
 */
export async function persistCancelled(params: {
  chatId: string
  runId: string
  output?: string
  durationMs?: number
  reason?: string
}): Promise<string> {
  const messageId = randomUUID()
  const content = params.output?.trim() || '（已取消）'
  const metadata: Record<string, unknown> = {
    runId: params.runId,
    status: 'cancelled',
  }
  if (params.reason) metadata.reason = params.reason
  if (params.durationMs != null) metadata.durationMs = params.durationMs

  await runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
    [messageId, params.chatId, content, params.runId, JSON.stringify(metadata)],
  )
  await runQuery(
    `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
    [params.chatId],
  )

  wsHub.broadcastChat(params.chatId, {
    type: 'chat:cancelled',
    chatId: params.chatId,
    runId: params.runId,
    role: 'assistant',
    content,
    streaming: false,
    reason: params.reason,
  })

  log.info('persistCancelled ok', { runId: params.runId, chatId: params.chatId, messageId })
  return messageId
}
