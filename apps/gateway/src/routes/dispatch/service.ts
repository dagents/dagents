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
  /** 取消意图已打标（running 任务由 daemon 轮询发现后 abort 收尾）。 */
  cancelRequested: boolean
}

/**
 * Read a task's status + result (spec §1.5 line 412).
 *
 * Returns null when the task id doesn't exist. `result` is the JSONB blob
 * stamped by `/complete` (`{ output, sessionId, usage }`) or `/fail`
 * (`{ error, failureReason }`); the pg driver already parses JSONB to JS
 * objects, so it is forwarded verbatim.
 */
export async function getTask(taskId: string): Promise<TaskRow | null> {
  const { records } = await runQuery<TaskRow>(
    `SELECT id, status, result, failure_reason AS "failureReason",
            session_id AS "sessionId", created_at AS "createdAt",
            finished_at AS "finishedAt",
            (cancel_requested_at IS NOT NULL) AS "cancelRequested"
       FROM dispatch_tasks
      WHERE id = $1`,
    [taskId],
  )
  return records[0] ?? null
}

/**
 * 取消一个 dispatch 任务（执行取消 spec §7 Deferred，2026-09-06 还债）。
 *
 * 协议（不动 status CHECK —— 'failed' + failure_reason='cancelled' 承载终态）：
 *   - queued/claimed（daemon 还没跑）：gateway 直接落终态 failed/cancelled；
 *   - running：只打 `cancel_requested_at` 标记，daemon 在事件流循环里轮询
 *     发现后 abort 子进程（ExecOptions.signal → SIGTERM→SIGKILL）并以
 *     failTask(failureReason='cancelled') 收尾；
 *   - 已终态：幂等 no-op。
 */
export async function cancelDispatchTask(taskId: string): Promise<
  | { outcome: 'terminated' }
  | { outcome: 'requested' }
  | { outcome: 'terminal'; status: string }
  | { outcome: 'missing' }
> {
  // 未开跑的直接落终态（与 daemon 的 startTask 409 收口天然防竞态）
  const { affected } = await runQuery(
    `UPDATE dispatch_tasks
       SET status = 'failed',
           result = $2,
           failure_reason = 'cancelled',
           finished_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'claimed')`,
    [taskId, JSON.stringify({ error: 'cancelled by user', failureReason: 'cancelled' })],
  )
  if (affected) return { outcome: 'terminated' }

  const row = await getTask(taskId)
  if (!row) return { outcome: 'missing' }
  if (row.status === 'completed' || row.status === 'failed') {
    return { outcome: 'terminal', status: row.status }
  }
  // running（或竞态窗口内重新入队）：打取消标记，daemon 轮询发现后收尾
  await runQuery(
    `UPDATE dispatch_tasks SET cancel_requested_at = NOW()
      WHERE id = $1 AND cancel_requested_at IS NULL`,
    [taskId],
  )
  return { outcome: 'requested' }
}

/**
 * 级联取消一个 run 名下的全部非终态 dispatch 任务（chat/run 取消钩子用）。
 * 返回取消的任务 id 列表。
 */
export async function cancelDispatchTasksForRun(runId: string): Promise<string[]> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM dispatch_tasks
      WHERE run_id = $1 AND status NOT IN ('completed', 'failed')`,
    [runId],
  )
  for (const r of records) {
    await cancelDispatchTask(r.id)
  }
  return records.map((r) => r.id)
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
