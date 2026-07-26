import { runQuery } from '@dagents/db'
import type { AgentDaemonCall, RunStatus } from '@dagents/db'

/**
 * `runs` table repository (spec §5.3; M3.2's persistence layer).
 *
 * All access goes through `runQuery` parameterised raw SQL — same decorator-
 * free-reads rationale as dispatch/token_meta: the `Run` entity exists for
 * schema + typing, not runtime queries. Functions return the minimal row
 * shapes the fan-out layer needs; nothing here leaks the full entity.
 *
 * Status transitions are deliberately explicit (no generic `update`) so the
 * fan-out lifecycle reads as a state machine in the callers: a parent is
 * created `pending`, child runs go `pending → running → completed|failed`, and
 * the parent is closed with `completeParentRun` after all children settle.
 */

/** Row shape returned by `createRun` (id + created_at). */
export interface CreatedRun {
  id: string
  createdAt: Date
}

export interface CreateRunInput {
  /**
   * Optional caller-supplied UUID. The queue worker (M3.1) mints the run id at
   * enqueue time so it can correlate the queued task with the run row, and
   * relies on `ON CONFLICT (id) DO NOTHING` for idempotent re-enqueue (M3.5
   * recovery). When omitted (the fan-out path), the DB defaults to
   * `gen_random_uuid()`.
   */
  id?: string
  identifier: string
  pipelineId: string
  /** Nullable: a child carries its parent's id; a parent or single run is null. */
  parentRunId?: string | null
  /** Per-run input (one batch item for a child, the full batch for a parent). */
  input: unknown
  pipelineVersionHash?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  traceId?: string | null
}

/**
 * Insert a run row at `pending` and return its id. `parent_run_id` is set only
 * on children; the fan-out layer creates the parent first, then threads its id
 * into every child's `parentRunId`.
 *
 * When `input.id` is supplied the row is inserted with that id and
 * `ON CONFLICT (id) DO NOTHING` makes a re-enqueued/recovered task idempotent —
 * a duplicate enqueue leaves the existing row untouched. Because `RETURNING`
 * yields no row on conflict, the existing row is fetched so the caller always
 * gets a concrete id + created_at back.
 */
export async function createRun(input: CreateRunInput): Promise<CreatedRun> {
  if (input.id) {
    const { records } = await runQuery<{ id: string; created_at: Date }>(
      `INSERT INTO runs
         (id, identifier, pipeline_id, pipeline_version_hash, status,
          parent_run_id, input, workspace_id, created_by_user_id, trace_id, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING id, created_at`,
      [
        input.id,
        input.identifier,
        input.pipelineId,
        input.pipelineVersionHash ?? null,
        input.parentRunId ?? null,
        JSON.stringify(input.input ?? {}),
        input.workspaceId ?? null,
        input.createdByUserId ?? null,
        input.traceId ?? null,
      ],
    )
    if (records[0]) return { id: records[0].id, createdAt: records[0].created_at }
    // Conflict — the row already exists. Fetch it so the caller still gets a
    // concrete id + created_at (re-enqueue must not clobber an in-flight run).
    const { records: existing } = await runQuery<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM runs WHERE id = $1`,
      [input.id],
    )
    const row = existing[0]
    if (!row) throw new Error('createRun: INSERT conflicted but row not found')
    return { id: row.id, createdAt: row.created_at }
  }

  const { records } = await runQuery<{ id: string; created_at: Date }>(
    `INSERT INTO runs
       (identifier, pipeline_id, pipeline_version_hash, status,
        parent_run_id, input, workspace_id, created_by_user_id, trace_id, created_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, NOW())
     RETURNING id, created_at`,
    [
      input.identifier,
      input.pipelineId,
      input.pipelineVersionHash ?? null,
      input.parentRunId ?? null,
      JSON.stringify(input.input ?? {}),
      input.workspaceId ?? null,
      input.createdByUserId ?? null,
      input.traceId ?? null,
    ],
  )
  const row = records[0]
  if (!row) throw new Error('createRun: INSERT returned no row')
  return { id: row.id, createdAt: row.created_at }
}

/**
 * Flip a run to `running` and stamp `started_at`. Idempotent on the timestamp:
 * a run already running keeps its original `started_at` so duration isn't
 * reset by a stray second call. The `WHERE status IN ('pending')` guard means
 * a re-delivered task that already advanced to `running` (or terminal) is a
 * no-op — the worker never re-runs a prediction for a run it has already
 * started (M3.5 recovery re-scans `runs`, not in-memory state).
 */
export async function markRunning(runId: string): Promise<void> {
  await runQuery(
    `UPDATE runs
       SET status = 'running',
           started_at = COALESCE(started_at, NOW())
     WHERE id = $1 AND status = 'pending'`,
    [runId],
  )
}

/** Row shape returned by `getRun`. */
export interface RunRecord {
  id: string
  pipelineId: string
  status: RunStatus
  input: unknown
  output: unknown
  /** Failure message extracted from `output.error` when status='failed'; else null. */
  failureReason: string | null
  durationMs: number | null
  startedAt: Date | null
  finishedAt: Date | null
}

/**
 * Load a run by id; returns null when the id doesn't exist. Used by the worker
 * integration tests to assert a dequeued run landed in `completed` / `failed`.
 * `failureReason` is unwrapped from the `output.error` JSONB convention so
 * callers need not re-parse.
 */
export async function getRun(id: string): Promise<RunRecord | null> {
  const { records } = await runQuery<RunRecord>(
    `SELECT id, pipeline_id AS "pipelineId", status, input, output,
            duration_ms AS "durationMs",
            started_at AS "startedAt",
            finished_at AS "finishedAt"
       FROM runs
      WHERE id = $1`,
    [id],
  )
  const row = records[0]
  if (!row) return null
  const failureReason =
    row.status === 'failed' && row.output && typeof row.output === 'object'
      ? String((row.output as { error?: unknown }).error ?? null)
      : null
  return { ...row, failureReason }
}

export interface RunCompletion {
  output: unknown
  durationMs?: number | null
  cost?: number | null
  agentDaemonCalls?: AgentDaemonCall[]
}

/** Stamp a child run completed: output + finished_at + duration. */
export async function completeRun(
  runId: string,
  completion: RunCompletion,
): Promise<void> {
  await runQuery(
    `UPDATE runs
       SET status = 'completed',
           output = $2,
           duration_ms = COALESCE($3, duration_ms),
           cost = COALESCE($4, cost),
           agent_daemon_calls = COALESCE($5, agent_daemon_calls),
           finished_at = NOW()
     WHERE id = $1`,
    [
      runId,
      JSON.stringify(completion.output ?? null),
      completion.durationMs ?? null,
      completion.cost ?? null,
      completion.agentDaemonCalls ? JSON.stringify(completion.agentDaemonCalls) : null,
    ],
  )
}

/** Stamp a child run failed: failure detail in `output`, finished_at set. */
export async function failRun(runId: string, failure: unknown): Promise<void> {
  await runQuery(
    `UPDATE runs
       SET status = 'failed',
           output = $2,
           finished_at = NOW()
     WHERE id = $1`,
    [runId, JSON.stringify({ error: failure })],
  )
}

/**
 * The comparable identity of a run — exactly the fields a rerun must preserve
 * to satisfy "同一 pipeline_version_hash 重跑指定子 run, 结果可比对" (plan M3.4).
 *
 * `flowId` is the Flowise flow id; the scheduler stored it on the parent run's
 * `input.flowId` (M3.2 fan-out writes `{ flowId, inputs }` there), so a child
 * run has no direct `flow_id` column — `loadRunForRerun` resolves it by
 * walking to the parent. `pipelineId` (the run's own column) is kept alongside
 * because the rerun re-stamps it on the new row for consistency, even though
 * it equals `flowId` in the current architecture.
 */
export interface RerunSource {
  id: string
  identifier: string
  pipelineId: string
  /** Flowise flow id, resolved from the parent's `input.flowId` for a child. */
  flowId: string
  status: RunStatus
  input: unknown
  pipelineVersionHash: string | null
  parentRunId: string | null
  workspaceId: string | null
  createdByUserId: string | null
}

/**
 * Load the comparable identity of a run for rerun (M3.4). Returns null when the
 * id doesn't exist. A child run's `flowId` is not stored on its own row — the
 * fan-out layer wrote the flow id only into the parent's `input.flowId` — so
 * for a child we read the parent row and pull `input->>'flowId'` from it.
 *
 * Only SELECTs; never mutates. The rerun layer uses this to copy the source
 * run's `pipeline_version_hash` + `input` + `parent_run_id` onto the new run
 * so the two are comparable, and to gate on `status` (only terminal runs may
 * be rerun — see `rerun.ts`).
 */
export async function loadRunForRerun(id: string): Promise<RerunSource | null> {
  const { records } = await runQuery<
    RerunSource & { parentInput: unknown }
  >(
    `SELECT
        r.id,
        r.identifier,
        r.pipeline_id AS "pipelineId",
        r.status,
        r.input,
        r.pipeline_version_hash AS "pipelineVersionHash",
        r.parent_run_id AS "parentRunId",
        r.workspace_id AS "workspaceId",
        r.created_by_user_id AS "createdByUserId",
        p.input AS "parentInput"
       FROM runs r
       LEFT JOIN runs p ON p.id = r.parent_run_id
      WHERE r.id = $1`,
    [id],
  )
  const row = records[0]
  if (!row) return null
  const flowId =
    row.parentRunId != null &&
    row.parentInput &&
    typeof row.parentInput === 'object'
      ? String((row.parentInput as { flowId?: unknown }).flowId ?? '')
      : row.pipelineId
  const { parentInput: _omit, ...rest } = row
  return { ...rest, flowId }
}

export interface CreateRerunRunInput {
  /** Caller-supplied id for the rerun run; lets the HTTP layer echo it. */
  id?: string
  /** The run being rerun — copied into `created_by_run_id` for provenance. */
  sourceRunId: string
  identifier: string
  pipelineId: string
  input: unknown
  pipelineVersionHash?: string | null
  parentRunId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  traceId?: string | null
}

/**
 * The reproducible identity + baseline of a run (plan M4.3 / P1.8.T5).
 *
 * Extends the rerun comparable identity with the two fields a reproduce
 * comparison needs on top of "re-execute with the same hash + input":
 *   - `output` — the baseline the re-run's output is structurally compared to
 *   - `artifactUri` — the original's archived artifact, for the report
 *
 * `flowId` is resolved exactly like `RerunSource.flowId`: a child run has no
 * `flow_id` column, so it is read from the parent's `input.flowId`.
 */
export interface ReproduceSource {
  id: string
  identifier: string
  pipelineId: string
  /** Flowise flow id, resolved from the parent's `input.flowId` for a child. */
  flowId: string
  status: RunStatus
  input: unknown
  output: unknown
  pipelineVersionHash: string | null
  artifactUri: string | null
  parentRunId: string | null
  workspaceId: string | null
  createdByUserId: string | null
}

/**
 * Load the reproducible identity of a run for M4.3 reproduce. Returns null when
 * the id doesn't exist. Same parent-walk as `loadRunForRerun` for `flowId`; the
 * only addition is `output` + `artifact_uri`, the baseline + archived artifact
 * the reproduce comparison reports against.
 *
 * Only SELECTs; never mutates. `reproduceRun` uses this to (a) gate on status
 * + bound hash, (b) re-execute with the same input + hash + flow, and (c)
 * structurally compare the new output to `output`.
 */
export async function loadRunForReproduce(id: string): Promise<ReproduceSource | null> {
  const { records } = await runQuery<
    ReproduceSource & { parentInput: unknown }
  >(
    `SELECT
        r.id,
        r.identifier,
        r.pipeline_id AS "pipelineId",
        r.status,
        r.input,
        r.output,
        r.artifact_uri AS "artifactUri",
        r.pipeline_version_hash AS "pipelineVersionHash",
        r.parent_run_id AS "parentRunId",
        r.workspace_id AS "workspaceId",
        r.created_by_user_id AS "createdByUserId",
        p.input AS "parentInput"
       FROM runs r
       LEFT JOIN runs p ON p.id = r.parent_run_id
      WHERE r.id = $1`,
    [id],
  )
  const row = records[0]
  if (!row) return null
  const flowId =
    row.parentRunId != null &&
    row.parentInput &&
    typeof row.parentInput === 'object'
      ? String((row.parentInput as { flowId?: unknown }).flowId ?? '')
      : row.pipelineId
  const { parentInput: _omit, ...rest } = row
  return { ...rest, flowId }
}

/**
 * Insert a new `pending` run that is a rerun of `sourceRunId` (M3.4). This is
 * the only writes-path the rerun feature adds — `createRun` / `markRunning` /
 * `completeRun` / `failRun` are unchanged so M3.1 (queue worker, MZW-257)
 * keeps owning them. The source's id is stamped into `created_by_run_id` so a
 * rerun is traceable back to the run it reproduces, while `pipeline_version_hash`
 * + `input` + `parent_run_id` are copied verbatim from the source so the two
 * runs are comparable by identity.
 */
export async function createRerunRun(
  input: CreateRerunRunInput,
): Promise<CreatedRun> {
  const { records } = await runQuery<{ id: string; created_at: Date }>(
    `INSERT INTO runs
       (identifier, pipeline_id, pipeline_version_hash, status,
        parent_run_id, input, workspace_id, created_by_user_id,
        created_by_run_id, trace_id, created_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, NOW())
     RETURNING id, created_at`,
    [
      input.identifier,
      input.pipelineId,
      input.pipelineVersionHash ?? null,
      input.parentRunId ?? null,
      JSON.stringify(input.input ?? {}),
      input.workspaceId ?? null,
      input.createdByUserId ?? null,
      input.sourceRunId,
      input.traceId ?? null,
    ],
  )
  const row = records[0]
  if (!row) throw new Error('createRerunRun: INSERT returned no row')
  return { id: row.id, createdAt: row.created_at }
}

/** Per-child summary used by parent aggregation. */
export interface ChildRunSummary {
  id: string
  status: RunStatus
  output: unknown
  durationMs: number | null
  cost: number | string | null
}

/**
 * Load all children of a parent run, ordered by `created_at` for stable
 * aggregation. The parent's `parent_run_id` is null by construction, so this
 * only ever returns leaf rows.
 */
export async function listChildren(parentRunId: string): Promise<ChildRunSummary[]> {
  const { records } = await runQuery<ChildRunSummary>(
    `SELECT id, status, output, duration_ms AS "durationMs", cost
       FROM runs
      WHERE parent_run_id = $1
      ORDER BY created_at`,
    [parentRunId],
  )
  return records
}

export interface ParentAggregate {
  total: number
  completed: number
  failed: number
  /** Sum of child costs (numeric → string from pg; coerced to number here). */
  totalCost: number
  /** Each child's id + status + output, for the parent's `output` blob. */
  children: Array<{ id: string; status: RunStatus; output: unknown }>
}

/**
 * Close the parent run: aggregate child outcomes into the parent's `output`,
 * sum child cost, and set terminal status (`completed` if every child
 * completed, else `failed`). Returns the aggregate so the caller can log/return
 * it without a second query.
 *
 * Idempotent: the UPDATE is guarded by `status = 'pending'`, so a parent
 * already closed (by `fanOut` before a crash, or by a concurrent recovery
 * close racing the last-child-settles window) is left untouched. The aggregate
 * is still computed and returned for logging — the guard only stops a stale
 * close from re-stomping a parent that has since moved on. This is what makes
 * the restart-recovery close loop (M3.6, see `listSettledPendingParents` /
 * `closeParentIfSettled`) safe to call concurrently with a still-draining batch.
 */
export async function completeParentRun(parentRunId: string): Promise<ParentAggregate> {
  const children = await listChildren(parentRunId)
  const completed = children.filter((c) => c.status === 'completed').length
  const failed = children.filter((c) => c.status === 'failed').length
  const totalCost = children.reduce((sum, c) => {
    const n = typeof c.cost === 'number' ? c.cost : Number(c.cost ?? 0)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
  const status: RunStatus = failed > 0 ? 'failed' : 'completed'

  const aggregate: ParentAggregate = {
    total: children.length,
    completed,
    failed,
    totalCost,
    children: children.map((c) => ({ id: c.id, status: c.status, output: c.output })),
  }

  await runQuery(
    `UPDATE runs
       SET status = $2,
           output = $3,
           cost = $4,
           finished_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [parentRunId, status, JSON.stringify(aggregate), totalCost],
  )

  return aggregate
}

/**
 * Restart-recovery parent close (M3.6): ids of fan-out parents left `pending`
 * whose every child has reached a terminal state. A killed-mid-batch `fanOut`
 * closes its parent only after every child settles (`completeParentRun`, called
 * once at the end of `fanOut`) — a SIGKILL before that call orphans the parent
 * in `pending` even when the children are all terminal. The boot recovery pass
 * (`recoverStaleRuns`) closes these so a batch is queryable as "done" after a
 * restart, not just per-child — the batch-level close loop for "重启可续完成".
 *
 * A parent is a top-level row (`parent_run_id IS NULL`) with at least one child;
 * `EXISTS` excludes a childless `pending` row (a single queue run the worker
 * path owns, not a fan-out parent). `NOT EXISTS … status NOT IN ('completed',
 * 'failed', 'cancelled')` means no child is still `pending` or `running` — i.e.
 * the batch has fully settled. `cancelled` counts as terminal (a cancelled child
 * never settles further), matching the `runs` status domain.
 *
 * This is the boot-time half of the close loop; the per-child half (parents
 * whose children are still `running` at boot and get re-enqueued) is
 * `closeParentIfSettled`, fired from the worker after each recovered child
 * settles.
 */
export async function listSettledPendingParents(): Promise<string[]> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT p.id
       FROM runs p
      WHERE p.status = 'pending'
        AND p.parent_run_id IS NULL
        AND EXISTS (SELECT 1 FROM runs c WHERE c.parent_run_id = p.id)
        AND NOT EXISTS (
              SELECT 1 FROM runs c
               WHERE c.parent_run_id = p.id
                 AND c.status NOT IN ('completed', 'failed', 'cancelled')
            )`,
  )
  return records.map((r) => r.id)
}

/**
 * Restart-recovery parent close (M3.6), worker hook: after a child run settles,
 * close its parent if every sibling is now terminal and the parent is still
 * `pending`. This is the per-child half of the close loop — the case the boot
 * sweep (`listSettledPendingParents`) cannot reach: children still `running` at
 * restart are re-enqueued by `recoverStaleRuns` and drained by the worker
 * asynchronously, so the parent can only be closed once the *last* recovered
 * child settles, which is here. The worker calls this from `runTask`'s finally
 * after every dequeued child completes or fails.
 *
 * No-op for a parentless (single queue) run (the JOIN finds no parent), for a
 * parent already closed, or while any sibling is still in flight. Under the
 * concurrency gate the last-settling children may race; `completeParentRun`'s
 * `status = 'pending'` guard makes the double close a no-op for the loser.
 *
 * Returns the closed parent id, or null if no parent was closed.
 */
export async function closeParentIfSettled(childRunId: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT p.id
       FROM runs c
       JOIN runs p ON p.id = c.parent_run_id
      WHERE c.id = $1
        AND p.status = 'pending'
        AND NOT EXISTS (
              SELECT 1 FROM runs c2
               WHERE c2.parent_run_id = p.id
                 AND c2.status NOT IN ('completed', 'failed', 'cancelled')
            )`,
    [childRunId],
  )
  const parentId = records[0]?.id
  if (!parentId) return null
  await completeParentRun(parentId)
  return parentId
}
