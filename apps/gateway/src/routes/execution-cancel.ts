/**
 * `/api/v1/chats/:id/cancel` + `/api/v1/workflows/runs/:runId/cancel` —
 * user-initiated execution cancellation (execution-cancellation spec D5).
 *
 * The endpoint only triggers the registry's abort; the execution site owns the
 * aftermath (kill child → settle → persist + `chat:cancelled` WS broadcast).
 * 409 = no live execution for that key (already finished / never started).
 *
 * dispatch/daemon 远程任务取消已补齐（spec §7 Deferred → 2026-09-06）：
 * chat/run 取消时级联取消名下非终态 dispatch 任务（queued/claimed 直接落
 * 终态，running 打 cancel_requested 由 daemon 轮询 abort）。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { runQuery } from '@dagents/db'
import { executionRegistry } from '../execution-registry.js'
import { cancelDispatchTask } from './dispatch/service.js'

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
  // 级联：该 chat 名下（runs.chat_id）的非终态 dispatch 任务（@daemon 路径）
  const cancelledTasks = await cascadeChatDispatchTasks(id)
  if (!result.found && cancelledTasks.length === 0) {
    return fail(c, 409, 'no active execution for this chat', { chatId: id })
  }
  return ok(c, {
    chatId: id,
    status: 'cancelled',
    settled: result.settled,
    kind: result.kind,
    cancelledDispatchTasks: cancelledTasks,
  })
})

/** Mounted at /api/v1/workflows — POST /runs/:runId/cancel */
export const runCancelRoutes = new Hono()

runCancelRoutes.post('/runs/:runId/cancel', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return fail(c, 400, 'invalid run id', { runId })
  }
  const result = await executionRegistry.cancelRun(runId)
  const cancelledTasks = await cascadeRunDispatchTasks(runId)
  if (!result.found && cancelledTasks.length === 0) {
    return fail(c, 409, 'no active execution for this run', { runId })
  }
  return ok(c, {
    runId,
    status: 'cancelled',
    settled: result.settled,
    kind: result.kind,
    cancelledDispatchTasks: cancelledTasks,
  })
})

/** chat 取消的 dispatch 级联：runs.chat_id 名下的非终态任务（@daemon 路径
 *  现在落真实 runs 行，2026-09-06）。 */
async function cascadeChatDispatchTasks(chatId: string): Promise<string[]> {
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE chat_id = $1::uuid AND status IN ('running', 'pending')`,
      [chatId],
    )
    const out: string[] = []
    for (const r of records) out.push(...(await cascadeRunDispatchTasks(r.id)))
    return out
  } catch {
    return []
  }
}

/** run 取消的 dispatch 级联（幂等，失败不阻断取消主流程）。 */
async function cascadeRunDispatchTasks(runId: string): Promise<string[]> {
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM dispatch_tasks WHERE run_id = $1 AND status NOT IN ('completed', 'failed')`,
      [runId],
    )
    const out: string[] = []
    for (const r of records) {
      const res = await cancelDispatchTask(r.id)
      if (res.outcome !== 'missing') out.push(r.id)
    }
    return out
  } catch {
    return []
  }
}
