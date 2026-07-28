import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { wsHub } from '../ws-hub.js'
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
}

/**
 * Persist an assistant message for a run, mark the chat idle, and broadcast
 * `chat:done` via WebSocket. Shared by:
 *   - `internal-runs.ts` (HTTP callback from scheduler/dispatch)
 *   - `chat-execute.ts` `routeFlowCommand` (in-process @flow execution)
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
  return messageId
}
