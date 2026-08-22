/**
 * `/api/v1/chats/:id/cancel` + `/api/v1/workflows/runs/:runId/cancel` —
 * user-initiated execution cancellation (execution-cancellation spec D5).
 *
 * The endpoint only triggers the registry's abort; the execution site owns the
 * aftermath (kill child → settle → persist + `chat:cancelled` WS broadcast).
 * 409 = no live execution for that key (already finished / never started).
 *
 * Deferred by design (spec §7): daemon/dispatch remote tasks have no cancel
 * path — this registry only indexes inline executions in this gateway process.
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { executionRegistry } from '../execution-registry.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** Mounted at /api/v1/chats — POST /:id/cancel */
export const chatCancelRoutes = new Hono()

chatCancelRoutes.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }
  const result = await executionRegistry.cancelChat(id)
  if (!result.found) {
    return fail(c, 409, 'no active execution for this chat', { chatId: id })
  }
  return ok(c, { chatId: id, status: 'cancelled', settled: result.settled, kind: result.kind })
})

/** Mounted at /api/v1/workflows — POST /runs/:runId/cancel */
export const runCancelRoutes = new Hono()

runCancelRoutes.post('/runs/:runId/cancel', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return fail(c, 400, 'invalid run id', { runId })
  }
  const result = await executionRegistry.cancelRun(runId)
  if (!result.found) {
    return fail(c, 409, 'no active execution for this run', { runId })
  }
  return ok(c, { runId, status: 'cancelled', settled: result.settled, kind: result.kind })
})
