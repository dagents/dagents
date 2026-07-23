import { Hono } from 'hono'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import { ok, fail } from '../app.js'
import { appendAgentDaemonCall } from '../runs-usage.js'
import { createLogger } from '@mil/shared'

/**
 * Task lifecycle routes (spec §1.5.T5):
 *   POST /tasks/:id/start
 *   POST /tasks/:id/progress    { summary, step, total }
 *   POST /tasks/:id/messages    { messages: AgentEvent[] }
 *   POST /tasks/:id/complete    { output, sessionId?, usage, durationMs }
 *   POST /tasks/:id/fail        { error, failureReason, sessionId? }
 *
 * Plus the read-only result lookup (spec §1.5 line 412):
 *   GET  /tasks/:id             → { status, result?, failureReason?, sessionId?, ... }
 *
 * Messages/progress land in `dispatch_task_events` (ordered by `seq`, computed
 * via a per-task MAX(seq)+1 so concurrent batches keep a monotonic sequence).
 * Terminal endpoints (complete/fail) stamp `status` + `finished_at` + `result`
 * / `failure_reason`; a task already in a terminal state rejects the
 * transition (409) so a late duplicate report can't clobber the result.
 *
 * M6.2 / P1.11.T3: on a terminal transition the daemon's `usage` (per-model
 * tokens) + `durationMs` + `sessionId` are appended to the owning run's
 * `runs.agent_daemon_calls` so the resource panel + agents drawer can read
 * per-run spend. The append is best-effort (a task whose `run_id` has no
 * `runs` row is skipped) and never re-fails the task: the terminal UPDATE
 * commits first, then `appendAgentDaemonCall` runs after — a DB blip here
 * leaves the task completed and only drops the run-level rollup.
 *
 * `runQuery` returns the structured `{ records, affected }` shape so we branch
 * on `affected` for 404/409-vs-204 and read `records` where a RETURNING/status
 * lookup is needed. `result`/`usage` columns are JSONB — TypeORM's pg driver
 * already parses them to objects, so the GET endpoint returns them verbatim
 * without re-stringifying (no double-encoding).
 */
export const tasksRoutes = new Hono()
const log = createLogger({ svc: 'dispatch:tasks' })

const progressSchema = z.object({
  summary: z.string().min(1),
  step: z.number().int().min(0),
  total: z.number().int().min(0),
})

const messagesSchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1),
})

const completeSchema = z.object({
  output: z.string(),
  sessionId: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().int().min(0),
})

const failSchema = z.object({
  error: z.string().min(1),
  failureReason: z.string().min(1),
  sessionId: z.string().optional(),
})

/** Load a task's status; returns null when the task id doesn't exist. */
async function getTaskStatus(id: string): Promise<string | null> {
  const { records } = await runQuery<{ status: string }>(
    `SELECT status FROM dispatch_tasks WHERE id = $1`,
    [id],
  )
  return records[0]?.status ?? null
}

/**
 * Read-only task lookup (spec §1.5 line 412). Flowise's DispatchInvoke node
 * polls this to resolve a task's terminal result after invoke→claim→complete.
 *
 * `result` is the JSONB blob stamped by `/complete` (`{ output, sessionId,
 * usage }`) or `/fail` (`{ error, failureReason }`); the pg driver already
 * parses JSONB into JS objects, so we forward `result` verbatim and let `null`
 * pass through for non-terminal tasks — never re-stringify, or the caller sees
 * a string-of-a-string. `finished_at` is `null` until a terminal transition.
 */
tasksRoutes.get('/tasks/:id', async (c) => {
  const id = c.req.param('id')
  const { records } = await runQuery<{
    status: string
    result: unknown
    failure_reason: string | null
    session_id: string | null
    created_at: Date
    finished_at: Date | null
  }>(
    `SELECT status, result, failure_reason, session_id, created_at, finished_at
       FROM dispatch_tasks
      WHERE id = $1`,
    [id],
  )
  const row = records[0]
  if (!row) return fail(c, 404, 'task not found', { taskId: id })

  return ok(c, {
    id,
    status: row.status,
    result: row.result ?? null,
    failureReason: row.failure_reason ?? null,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
  })
})

tasksRoutes.post('/tasks/:id/start', async (c) => {
  const id = c.req.param('id')
  const { affected } = await runQuery(
    `UPDATE dispatch_tasks
       SET status = 'running', started_at = COALESCE(started_at, NOW())
     WHERE id = $1 AND status IN ('claimed', 'running')`,
    [id],
  )
  if (!affected) {
    const status = await getTaskStatus(id)
    if (status === null) return fail(c, 404, 'task not found', { taskId: id })
    return fail(c, 409, 'task not in a startable state', { status })
  }
  return c.body(null, 204)
})

tasksRoutes.post('/tasks/:id/progress', async (c) => {
  const id = c.req.param('id')
  let parsed: z.infer<typeof progressSchema>
  try {
    parsed = progressSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid progress body', { detail: String(err) })
  }

  const status = await getTaskStatus(id)
  if (status === null) return fail(c, 404, 'task not found', { taskId: id })

  await runQuery(
    `INSERT INTO dispatch_task_events (task_id, kind, seq, payload, created_at)
     VALUES ($1, 'progress',
       COALESCE((SELECT MAX(seq) FROM dispatch_task_events WHERE task_id = $1), 0) + 1,
       $2, NOW())`,
    [id, JSON.stringify(parsed)],
  )
  return c.body(null, 204)
})

tasksRoutes.post('/tasks/:id/messages', async (c) => {
  const id = c.req.param('id')
  let parsed: z.infer<typeof messagesSchema>
  try {
    parsed = messagesSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid messages body', { detail: String(err) })
  }

  const status = await getTaskStatus(id)
  if (status === null) return fail(c, 404, 'task not found', { taskId: id })

  // Batch-insert with monotonic seq: compute the starting seq once, then emit
  // one row per message at seq, seq+1, … — order is preserved even under
  // concurrent batches because the whole insert is one statement on one
  // connection. Values are bound as parameters, never interpolated.
  const { records: seqRows } = await runQuery<{ s: string }>(
    `SELECT COALESCE((SELECT MAX(seq) FROM dispatch_task_events WHERE task_id = $1), 0) AS s`,
    [id],
  )
  let seq = Number(seqRows[0]?.s ?? 0)
  const params: unknown[] = []
  const values = parsed.messages
    .map((m) => {
      seq += 1
      const base = params.length
      params.push(id, 'message', seq, JSON.stringify(m))
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, NOW())`
    })
    .join(', ')
  await runQuery(
    `INSERT INTO dispatch_task_events (task_id, kind, seq, payload, created_at) VALUES ${values}`,
    params,
  )
  return c.body(null, 204)
})

tasksRoutes.post('/tasks/:id/complete', async (c) => {
  const id = c.req.param('id')
  let parsed: z.infer<typeof completeSchema>
  try {
    parsed = completeSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid complete body', { detail: String(err) })
  }

  const { records, affected } = await runQuery<{ run_id: string; agent_daemon_id: string; finished_at: Date }>(
    `UPDATE dispatch_tasks
       SET status = 'completed',
           result = $2,
           session_id = COALESCE($3, session_id),
           usage = $4,
           duration_ms = $5,
           finished_at = NOW()
     WHERE id = $1 AND status NOT IN ('completed', 'failed')
     RETURNING run_id, agent_daemon_id, finished_at`,
    [
      id,
      JSON.stringify({ output: parsed.output, sessionId: parsed.sessionId, usage: parsed.usage }),
      parsed.sessionId ?? null,
      JSON.stringify(parsed.usage),
      parsed.durationMs,
    ],
  )
  if (!affected) {
    const status = await getTaskStatus(id)
    if (status === null) return fail(c, 404, 'task not found', { taskId: id })
    return fail(c, 409, 'task already terminal', { status })
  }
  await recordRunUsage(id, records[0], 'completed', parsed.usage, parsed.durationMs, parsed.sessionId)
  return c.body(null, 204)
})

tasksRoutes.post('/tasks/:id/fail', async (c) => {
  const id = c.req.param('id')
  let parsed: z.infer<typeof failSchema>
  try {
    parsed = failSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid fail body', { detail: String(err) })
  }

  const { records, affected } = await runQuery<{ run_id: string; agent_daemon_id: string; finished_at: Date }>(
    `UPDATE dispatch_tasks
       SET status = 'failed',
           result = $2,
           failure_reason = $3,
           session_id = COALESCE($4, session_id),
           finished_at = NOW()
     WHERE id = $1 AND status NOT IN ('completed', 'failed')
     RETURNING run_id, agent_daemon_id, finished_at`,
    [
      id,
      JSON.stringify({ error: parsed.error, failureReason: parsed.failureReason }),
      parsed.failureReason,
      parsed.sessionId ?? null,
    ],
  )
  if (!affected) {
    const status = await getTaskStatus(id)
    if (status === null) return fail(c, 404, 'task not found', { taskId: id })
    return fail(c, 409, 'task already terminal', { status })
  }
  await recordRunUsage(id, records[0], 'failed', undefined, undefined, parsed.sessionId)
  return c.body(null, 204)
})

/**
 * Append the terminal usage to `runs.agent_daemon_calls` (M6.2 / P1.11.T3).
 *
 * Best-effort: the task's terminal UPDATE has already committed when this runs,
 * so a DB blip here never re-opens the task or fails the request — it only
 * drops the run-level rollup for this call. The `finishedAt` from RETURNING is
 * reused so the appended entry's timestamp matches the task's, not a fresh
 * `NOW()` (the route holds no transaction across the two statements).
 *
 * `taskId` is the dispatch task id (the route's `:id`); `row` is the RETURNING
 * row carrying the owning `run_id` + `agent_daemon_id`. `usage`/`durationMs`
 * are absent on the `/fail` path (a failed task reported no token totals).
 */
async function recordRunUsage(
  taskId: string,
  row: { run_id: string; agent_daemon_id: string; finished_at: Date } | undefined,
  status: string,
  usage?: Record<string, unknown>,
  durationMs?: number,
  sessionId?: string,
): Promise<void> {
  if (!row) return
  try {
    await appendAgentDaemonCall({
      runId: row.run_id,
      agentDaemonId: row.agent_daemon_id,
      dispatchTaskId: taskId,
      status,
      usage,
      durationMs,
      sessionId,
      finishedAt: row.finished_at.toISOString(),
    })
  } catch (err) {
    log.warn('append agent_daemon_calls failed', {
      taskId,
      runId: row.run_id,
      agentDaemonId: row.agent_daemon_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
