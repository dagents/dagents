import { runQuery } from '@dagents/db'
import type { AgentDaemonCall } from '@dagents/db'
import { createLogger } from '@dagents/shared'

/**
 * `runs.agent_daemon_calls` persistence (spec §5.3; plan M6.2 / P1.11.T3).
 *
 * Merged from `apps/dispatch/src/runs-usage.ts` (Plan A, 2026-08-01). The
 * daemon reports a task's terminal `usage` (per-model tokens) + `durationMs`
 * + `sessionId` to dispatch via `POST /tasks/:id/complete` (or `/fail`).
 * Dispatch appends one {@link AgentDaemonCall} to the owning run's
 * `agent_daemon_calls` JSONB array so the per-agent spend is queryable for the
 * resource panel (M6.3) + Agents 管理页 drawer (M5a.2).
 *
 * `dispatch_tasks.run_id` is a TEXT FK-shaped reference to `runs.id` (spec
 * §5.3); the invoke path accepts any non-empty string, so a task whose `run_id`
 * does not correspond to a real `runs` row is silently skipped here — the task
 * still completes, only the run-level rollup is dropped. The owning run need
 * not be `running`; an appended call on a `completed` run is valid (the run
 * completed at the workflow layer before the dispatch task did) and is what the
 * agents page reads.
 *
 * All access goes through `runQuery` parameterised raw SQL — same decorator-
 * free-reads rationale as dispatch/token_meta: the `Run` entity exists for
 * schema + typing, not runtime queries.
 */

const log = createLogger({ svc: 'gateway:dispatch:runs-usage' })

/** One entry appended to `runs.agent_daemon_calls` on a terminal transition. */
export interface AppendCallInput {
  runId: string
  agentDaemonId: string
  dispatchTaskId: string
  status: string
  /** Per-model token usage (`Record<string, TokenUsage>`); absent on a failed task. */
  usage?: Record<string, unknown>
  durationMs?: number
  sessionId?: string
  /** ISO timestamp of the terminal transition; falls back to NOW() server-side. */
  finishedAt?: string
}

/**
 * Append one agent-daemon call to a run's `agent_daemon_calls` array.
 *
 * Uses the `||` jsonb concatenation operator so each append is a single
 * statement — no read-modify-write round-trip, so concurrent appends on the
 * same run (parallel fan-out children calling the same agent) do not lose
 * entries. A missing run row updates zero rows (the `WHERE id = $1` guard);
 * that is the "task with no owning run" skip path — logged at debug, not an
 * error.
 *
 * Returns true when a row was updated, false when the run id matched no row.
 */
export async function appendAgentDaemonCall(input: AppendCallInput): Promise<boolean> {
  const entry: AgentDaemonCall = {
    agentDaemonId: input.agentDaemonId,
    dispatchTaskId: input.dispatchTaskId,
    status: input.status,
    usage: input.usage,
    durationMs: input.durationMs,
    sessionId: input.sessionId,
    finishedAt: input.finishedAt,
  }

  const { affected } = await runQuery(
    `UPDATE runs
        SET agent_daemon_calls = agent_daemon_calls || $2::jsonb
      WHERE id = $1`,
    [input.runId, JSON.stringify([entry])],
  )

  if (!affected) {
    log.debug('append skipped: run row not found', {
      runId: input.runId,
      taskId: input.dispatchTaskId,
    })
    return false
  }
  return true
}

/** Row shape returned by `getRunUsage`. */
export interface RunUsageRecord {
  id: string
  status: string
  agentDaemonCalls: AgentDaemonCall[]
  cost: string
  durationMs: number | null
  startedAt: Date | null
  finishedAt: Date | null
}

/**
 * Load a run's agent-daemon-call log + cost rollup for the resource panel /
 * agents drawer. Returns null when the run id doesn't exist.
 *
 * `cost` is NUMERIC(18,6); the pg driver returns it as a string to preserve
 * precision, so it is forwarded verbatim — callers that need a Number coerce
 * explicitly. `agent_daemon_calls` is JSONB, already parsed to an array of
 * {@link AgentDaemonCall}; forwarded verbatim (never re-stringified).
 */
export async function getRunUsage(runId: string): Promise<RunUsageRecord | null> {
  const { records } = await runQuery<RunUsageRecord>(
    `SELECT id, status, agent_daemon_calls AS "agentDaemonCalls",
            cost::text AS cost,
            duration_ms AS "durationMs",
            started_at AS "startedAt",
            finished_at AS "finishedAt"
       FROM runs
      WHERE id = $1`,
    [runId],
  )
  return records[0] ?? null
}

/** Token totals for one model, accumulated across all calls of a run. */
export interface ModelUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  calls: number
}

/**
 * Pure aggregation over a run's `agent_daemon_calls`: sum per-model token
 * usage across every call and count calls per model.
 *
 * The daemon reports usage as `Record<string, TokenUsage>` (contracts
 * `TokenUsage`: inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens).
 * This rolls all calls into one per-model total — the shape the resource
 * panel renders. Models seen across calls are unioned; a call with no
 * `usage` contributes only to its agent's call count, not to any model.
 *
 * Exported (not inlined in the route) so a unit test can verify the rollup
 * without a database. Shared by `fleet-stats` (cross-run fleet rollup) and
 * the per-run usage route — the per-run and fleet-wide rollups are the same
 * computation over different scopes of the same `AgentDaemonCall[]`, so one
 * function serves both (see {@link ModelFleetTotals} alias).
 */
export function aggregateUsage(calls: AgentDaemonCall[]): {
  byModel: Record<string, ModelUsageTotals>
  totalCalls: number
} {
  const byModel: Record<string, ModelUsageTotals> = {}
  for (const call of calls) {
    const usage = call.usage
    if (!usage || typeof usage !== 'object') continue
    for (const [model, raw] of Object.entries(usage)) {
      if (!raw || typeof raw !== 'object') continue
      const u = raw as {
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
      }
      const acc = byModel[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
      }
      acc.inputTokens += Number(u.inputTokens ?? 0)
      acc.outputTokens += Number(u.outputTokens ?? 0)
      acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + Number(u.cacheReadTokens ?? 0)
      acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + Number(u.cacheWriteTokens ?? 0)
      acc.calls += 1
      byModel[model] = acc
    }
  }
  return { byModel, totalCalls: calls.length }
}
