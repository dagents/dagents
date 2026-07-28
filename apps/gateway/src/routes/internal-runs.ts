import { Hono } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import type { TokenUsage } from '@dagents/contracts'
import { persistComplete } from './internal-runs-helpers.js'

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

  try {
    const messageId = await persistComplete({
      chatId: body.chatId,
      runId,
      output: body.output,
      status: body.status,
      usage: body.usage,
      durationMs: body.durationMs,
      cost: body.cost,
    })
    return c.json({ success: true, data: { messageId } })
  } catch (err) {
    log.error('internal complete persist failed', { runId, chatId: body.chatId, error: String(err) })
    return c.json({ success: false, error: 'persist failed' }, 502)
  }
})
