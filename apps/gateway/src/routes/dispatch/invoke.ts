import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { ok, fail } from './index.js'

/**
 * POST /api/v1/dispatch/invoke — enqueue a task (spec §1.5.T2).
 *
 * workflow-side entry: insert a `dispatch_tasks` row at status `queued` and
 * return `{ taskId }`. The daemon later pulls it via `/daemons/:id/tasks/claim`.
 *
 * `agentDaemonId` is a UUID-shaped FK into `agent_daemons`; we validate the
 * shape but do NOT enforce existence here (no entity loaded) — the claim path
 * is the authority on which daemon serves which agent. This keeps invoke
 * non-blocking and avoids an extra round-trip on the hot enqueue path.
 */
export const invokeRoutes = new Hono()

const invokeSchema = z.object({
  agentDaemonId: z.string().uuid(),
  runId: z.string().min(1).max(128),
  prompt: z.string().min(1),
  execOptions: z.unknown().default({}),
})

invokeRoutes.post('/invoke', async (c) => {
  let parsed: z.infer<typeof invokeSchema>
  try {
    parsed = invokeSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid invoke body', { detail: String(err) })
  }

  // `run_id` is a TEXT FK-shaped reference to the runs table (spec §5.3); we
  // accept any non-empty string so invoke works before the `runs` entity lands
  // (P1.2.T4). The FK constraint is intentionally absent for MVP.
  const id = randomUUID()
  try {
    await runQuery(
      `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, exec_options, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', NOW())`,
      [id, parsed.agentDaemonId, parsed.runId, parsed.prompt, JSON.stringify(parsed.execOptions)],
    )
  } catch (err) {
    // FK violation on agent_daemon_id, malformed run_id, etc.
    return fail(c, 422, 'enqueue failed', { detail: String(err) })
  }

  return ok(c, { taskId: id })
})
