import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'

/**
 * Dispatch service functions (Plan A, 2026-08-01).
 *
 * Extracted from the dispatch route handlers so gateway-internal callers
 * (chats.ts `streamAgentExecution`, chat-execute.ts `routeDaemonCommands`)
 * can invoke dispatch logic without an HTTP round-trip to themselves.
 *
 * The route handlers in `invoke.ts` / `tasks.ts` still exist for the daemon
 * protocol surface (`/api/v1/dispatch/*`); they delegate to these functions
 * for the SQL layer. External callers (daemons) still go through HTTP.
 */

/** Shape returned by {@link enqueueTask}. */
export interface EnqueueTaskResult {
  taskId: string
}

/**
 * Enqueue a dispatch task at status `queued` (spec §1.5.T2).
 *
 * `agentDaemonId` is a UUID-shaped FK into `agent_daemons`; we do NOT enforce
 * existence here (the claim path is the authority). `runId` is a TEXT
 * FK-shaped reference to `runs.id` — accepts any non-empty string so invoke
 * works before a `runs` row lands.
 */
export async function enqueueTask(input: {
  agentDaemonId: string
  runId: string
  prompt: string
  execOptions?: unknown
}): Promise<EnqueueTaskResult> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, exec_options, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', NOW())`,
    [id, input.agentDaemonId, input.runId, input.prompt, JSON.stringify(input.execOptions ?? {})],
  )
  return { taskId: id }
}

/** Shape returned by {@link getTask}. */
export interface TaskRow {
  id: string
  status: string
  result: unknown
  failureReason: string | null
  sessionId: string | null
  createdAt: Date
  finishedAt: Date | null
}

/**
 * Read a task's status + result (spec §1.5 line 412).
 *
 * Returns null when the task id doesn't exist. `result` is the JSONB blob
 * stamped by `/complete` (`{ output, sessionId, usage }`) or `/fail`
 * (`{ error, failureReason }`); the pg driver already parses JSONB into JS
 * objects, so it is forwarded verbatim.
 */
export async function getTask(taskId: string): Promise<TaskRow | null> {
  const { records } = await runQuery<TaskRow>(
    `SELECT id, status, result, failure_reason AS "failureReason",
            session_id AS "sessionId", created_at AS "createdAt",
            finished_at AS "finishedAt"
       FROM dispatch_tasks
      WHERE id = $1`,
    [taskId],
  )
  return records[0] ?? null
}

/** Shape returned by {@link getTaskEvents}. */
export interface TaskEventRow {
  seq: number
  kind: string
  payload: unknown
  createdAt: Date
}

/**
 * Read task events since `afterSeq` (spec §1.5.T5 events stream).
 *
 * Ordered by seq ascending, capped at 200 rows. Enables incremental polling
 * without re-fetching the full history.
 */
export async function getTaskEvents(taskId: string, afterSeq: number = 0): Promise<TaskEventRow[]> {
  const { records } = await runQuery<TaskEventRow>(
    `SELECT seq, kind, payload, created_at AS "createdAt"
       FROM dispatch_task_events
      WHERE task_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT 200`,
    [taskId, afterSeq],
  )
  return records
}
