import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { wsHub } from '../ws-hub.js'
import type { TokenUsage } from '@dagents/contracts'

const log = createLogger({ svc: 'gateway:internal-runs' })

export const internalRunsRoutes = new Hono()

interface CompleteBody {
  chatId: string
  output: string
  status: 'completed' | 'failed'
  usage?: TokenUsage
  durationMs?: number
  cost?: number
}

const completeBodySchema = z.object({
  chatId: z.string().uuid(),
  output: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  durationMs: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
})

/**
 * Internal endpoint called by scheduler/dispatch after a run completes.
 * Writes the assistant message + broadcasts chat:done via WS.
 *
 * Auth: requires x-internal-token header matching INTERNAL_CALLBACK_TOKEN env.
 *
 * ⚠️ Security note: the gateway listens on 0.0.0.0 by default (see index.ts:
 * `serve({ fetch, port })` with no `hostname`), so this endpoint IS externally
 * reachable — `x-internal-token` is the ONLY application-layer protection.
 * Therefore `INTERNAL_CALLBACK_TOKEN` MUST be a strong random secret, and
 * operators SHOULD restrict `/internal/*` at the network layer (firewall /
 * service mesh / reverse-proxy allowlist) in production.
 */
internalRunsRoutes.post('/runs/:runId/complete', async (c) => {
  const token = c.req.header('x-internal-token')
  const expected = process.env.INTERNAL_CALLBACK_TOKEN
  if (!expected || token !== expected) {
    return c.json({ success: false, error: 'unauthorized' }, 401)
  }

  const runId = c.req.param('runId')
  let parsed
  try {
    parsed = completeBodySchema.safeParse(await c.req.json())
  } catch {
    return c.json({ success: false, error: 'invalid json' }, 400)
  }
  if (!parsed.success) {
    return c.json({ success: false, error: 'invalid body', details: parsed.error.flatten() }, 400)
  }
  const body: CompleteBody = parsed.data

  const messageId = randomUUID()
  const metadata: Record<string, unknown> = {
    runId,
    status: body.status,
  }
  if (body.usage) metadata.usage = body.usage
  if (body.durationMs != null) metadata.durationMs = body.durationMs
  if (body.cost != null) metadata.cost = body.cost

  try {
    await runQuery(
      `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4::uuid, $5, NOW())`,
      [messageId, body.chatId, body.output, runId, JSON.stringify(metadata)],
    )
    await runQuery(
      `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
      [body.chatId],
    )
  } catch (err) {
    log.error('internal complete persist failed', { runId, chatId: body.chatId, error: String(err) })
    return c.json({ success: false, error: 'persist failed' }, 502)
  }

  wsHub.broadcastChat(body.chatId, {
    type: 'chat:done',
    chatId: body.chatId,
    runId,
    role: 'assistant',
    content: body.output,
    streaming: false,
    status: body.status,
    usage: body.usage,
    durationMs: body.durationMs,
    cost: body.cost,
  })

  log.info('internal complete ok', { runId, chatId: body.chatId, messageId })
  return c.json({ success: true, data: { messageId } })
})
