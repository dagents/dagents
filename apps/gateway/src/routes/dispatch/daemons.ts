import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { ok, fail } from './index.js'

/**
 * Daemon lifecycle routes (spec §1.5.T3/T4):
 *   POST   /daemons/register              → { daemonId, token }
 *   POST   /daemons/heartbeat             → 204
 *   DELETE /daemons/:id                   (deregister) → 204
 *   POST   /daemons/:id/tasks/claim       → { task | null }
 *
 * `runQuery` returns `{ records, affected }` — the structured TypeORM shape —
 * so we can branch on `affected` for 404-vs-204 and read `records` for RETURNING.
 *
 * Auth: register returns a token; daemon clients should send it as
 * `authorization: Bearer <token>` on heartbeat/claim. MVP leaves claim
 * unauthenticated pending P1.5.T7's routing/auth layer.
 */
export const daemonsRoutes = new Hono()
const log = createLogger({ svc: 'dispatch:daemons' })

const registerSchema = z.object({
  daemonLabel: z.string().min(1).max(128),
  capabilities: z.array(
    z.object({
      agentType: z.string().min(1),
      tags: z.array(z.string()).optional(),
    }),
  ),
  endpoint: z.string().optional(),
})

const heartbeatSchema = z.object({
  daemonId: z.string().uuid(),
  status: z.enum(['online', 'offline', 'draining']),
  activeTasks: z.number().int().min(0),
})

daemonsRoutes.post('/daemons/register', async (c) => {
  let parsed: z.infer<typeof registerSchema>
  try {
    parsed = registerSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid register body', { detail: String(err) })
  }

  const id = randomUUID()
  const token = randomUUID()
  try {
    await runQuery(
      `INSERT INTO daemons (id, label, endpoint, status, capabilities, token, last_heartbeat_at, created_at)
       VALUES ($1, $2, $3, 'online', $4, $5, NOW(), NOW())`,
      [id, parsed.daemonLabel, parsed.endpoint ?? null, JSON.stringify(parsed.capabilities), token],
    )
  } catch (err) {
    return fail(c, 422, 'register failed', { detail: String(err) })
  }

  log.info('daemon registered', { daemonId: id, label: parsed.daemonLabel })
  return ok(c, { daemonId: id, token })
})

daemonsRoutes.post('/daemons/heartbeat', async (c) => {
  let parsed: z.infer<typeof heartbeatSchema>
  try {
    parsed = heartbeatSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid heartbeat body', { detail: String(err) })
  }

  const { affected } = await runQuery(
    `UPDATE daemons SET status = $1, last_heartbeat_at = NOW() WHERE id = $2`,
    [parsed.status, parsed.daemonId],
  )
  if (!affected) {
    return fail(c, 404, 'daemon not found', { daemonId: parsed.daemonId })
  }

  return c.body(null, 204)
})

/**
 * GET /daemons — list all registered daemons (for the create-agent dialog's
 * daemon selector). Returns id/label/status/capabilities. Ordered by label
 * so the dropdown is stable. Light query (daemons table is small by design).
 */
daemonsRoutes.get('/daemons', async (c) => {
  const { records } = await runQuery<{
    id: string
    label: string
    status: string
    endpoint: string | null
    capabilities: unknown
    last_heartbeat_at: Date | null
  }>(
    `SELECT id, label, status, endpoint, capabilities, last_heartbeat_at
       FROM daemons
       ORDER BY label ASC`,
  )
  return ok(c, { daemons: records })
})

daemonsRoutes.delete('/daemons/:id', async (c) => {
  const id = c.req.param('id')
  const { affected } = await runQuery(`DELETE FROM daemons WHERE id = $1`, [id])
  if (!affected) {
    return fail(c, 404, 'daemon not found', { daemonId: id })
  }
  log.info('daemon deregistered', { daemonId: id })
  return c.body(null, 204)
})

/**
 * Atomically claim one queued task (spec §1.5.T4, plan M2.2 Step 4).
 *
 * `FOR UPDATE SKIP LOCKED` inside the subselect lets concurrent daemons each
 * grab a distinct row without blocking — the canonical Postgres FIFO-dequeue
 * pattern. The whole UPDATE…RETURNING runs in one statement, so the claim is
 * atomic even without an explicit transaction wrapper; `runQuery` still goes
 * through a QueryRunner so we get the structured result (RETURNING rows +
 * affected count) in one round-trip.
 *
 * `task` is null when nothing is queued (idle poll), matching ClaimTaskResponse.
 */
daemonsRoutes.post('/daemons/:id/tasks/claim', async (c) => {
  const daemonId = c.req.param('id')
  let records: { id: string; agent_daemon_id: string; run_id: string; prompt: string; exec_options: unknown }[] = []
  try {
    const res = await runQuery<{
      id: string
      agent_daemon_id: string
      run_id: string
      prompt: string
      exec_options: unknown
    }>(
      `UPDATE dispatch_tasks
         SET status = 'claimed', claimed_by_daemon_id = $1, claimed_at = NOW()
       WHERE id IN (
         SELECT id FROM dispatch_tasks
         WHERE status = 'queued'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, agent_daemon_id, run_id, prompt, exec_options`,
      [daemonId],
    )
    records = res.records
  } catch (err) {
    return fail(c, 422, 'claim failed', { detail: String(err) })
  }

  const row = records[0]
  const task = row
    ? {
        id: row.id,
        agentDaemonId: row.agent_daemon_id,
        runId: row.run_id,
        prompt: row.prompt,
        execOptions: row.exec_options,
      }
    : null

  return ok(c, { task })
})
