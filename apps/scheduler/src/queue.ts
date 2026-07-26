import { z } from 'zod'

/**
 * Scheduler task-queue contract (plan M3.1 / P1.7).
 *
 * Producers LPUSH JSON-serialised `ScheduleTask` payloads onto the Redis list
 * `dagents:tasks`; the scheduler worker BRPOPs them off (FIFO: LPUSH in + BRPOP out
 * gives queue order, not stack order) and runs each through Flowise.
 *
 * `runId` is a caller-supplied UUID and becomes the `runs.id` primary key — the
 * producer mints it so it can correlate the queued task with the run record
 * from the moment it enqueues. The scheduler inserts that id verbatim.
 *
 * `pipelineId` is the Flowise flow id (architecture §5.3: `pipeline_id` maps to
 * the Flowise flow id). The scheduler POSTs it to the gateway's
 * `/api/v1/flows/:id/prediction` route, which rewrites to Flowise's
 * `/api/v1/prediction/:id`.
 *
 * `input` is the opaque prediction body — `{ question, … }` for a chatflow, or
 * `{ inputs: { … } }` for an agentflow. The scheduler forwards it verbatim; it
 * does not interpret flow-specific shapes.
 */
export const scheduleTaskSchema = z.object({
  runId: z.string().uuid(),
  pipelineId: z.string().min(1).max(128),
  input: z.unknown(),
})

export type ScheduleTask = z.infer<typeof scheduleTaskSchema>

/**
 * Validate a raw queue payload (already JSON.parsed) against the schema.
 * Returns the typed task or `null` when the payload is malformed — the worker
 * drops malformed messages rather than poisoning the loop (a bad message would
 * otherwise re-block BRPOP forever if re-queued).
 */
export function parseScheduleTask(raw: unknown): ScheduleTask | null {
  const result = scheduleTaskSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** Redis list key the scheduler consumes (under the `dagents:` prefix). */
export const TASK_QUEUE_KEY = 'tasks'

/** Redis key holding the semaphore token pool (under the `dagents:` prefix). */
export const SEMAPHORE_KEY = 'sem'
