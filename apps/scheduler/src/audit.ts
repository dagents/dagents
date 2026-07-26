import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

/**
 * Version-lock audit helper (plan M6.6 / P1.4.T6; risk R15).
 *
 * The scheduler is the only place a `pipeline_versions` row gets created (the
 * repro `snapshotPipeline` path, called from the worker + fan-out). That is the
 * version-lock the spec calls out as a sensitive operation ("版本锁定"), so each
 * successful snapshot writes one audit row here.
 *
 * Kept in the scheduler package (not `@dagents/gateway`) because the snapshot site
 * is in the scheduler, and `@dagents/gateway` is not a dependency of the scheduler
 * (the dependency runs the other way: the gateway proxies to services, the
 * scheduler is its own app). The row shape matches the gateway's `recordAudit`
 * — same `audit_log` table, same `pipeline_version.lock` action — so audit
 * queries join across both writers transparently.
 *
 * Fire-and-forget: a failed audit write is logged and never propagates, so a
 * snapshot (which is itself best-effort in the repro client) is never re-failed
 * by its audit hook. `detail` carries the flow id + hash for forensic value;
 * never any secret.
 */

const log = createLogger({ svc: 'scheduler:audit' })

/**
 * Record that a pipeline version was locked (snapshotted). Best-effort: never
 * throws, logs on failure. `runId` is the run the lock is bound to (every
 * scheduler snapshot is bound to a run); `versionHash` is the content address
 * that is the lock's target id.
 */
export function recordVersionLockAudit(args: {
  /** The flow id the snapshot was taken from. */
  pipelineId: string
  /** SHA-256 of the canonical flow JSON — the content address + lock target. */
  versionHash: string
  /** The run the lock is bound to; null when the snapshot isn't run-scoped. */
  runId?: string | null
  /** Owning workspace; null for platform-scoped ops. */
  workspaceId?: string | null
}): Promise<void> {
  return writeAuditRow({
    action: 'pipeline_version.lock',
    targetType: 'pipeline_version',
    targetId: args.versionHash,
    runId: args.runId ?? null,
    workspaceId: args.workspaceId ?? null,
    detail: { pipelineId: args.pipelineId, versionHash: args.versionHash },
  }).catch((err) => {
    // Fire-and-forget backstop: writeAuditRow already swallows DB errors, but
    // guard against anything unexpected so a repro/audit bug can never fail a
    // run. Mirrors the `archiveBestEffort` backstop in fanout.ts.
    log.warn('version-lock audit threw unexpectedly', {
      pipelineId: args.pipelineId,
      versionHash: args.versionHash,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * Insert one audit row. Parameterised; the jsonb `detail` is stringified so pg
 * stores it verbatim. The actor is `system:scheduler` — the scheduler is the
 * principal performing the lock (no HTTP context here, unlike the gateway's
 * `recordAudit`). Never throws: an audit failure is logged, not propagated.
 */
async function writeAuditRow(args: {
  action: string
  targetType: 'pipeline_version'
  targetId: string
  runId: string | null
  workspaceId: string | null
  detail: Record<string, unknown>
}): Promise<void> {
  try {
    await runQuery(
      `INSERT INTO audit_log
         (actor_type, actor_id, action, target_type, target_id,
          run_id, workspace_id, detail, ip, user_agent, created_at)
       VALUES ('system', 'scheduler', $1, $2, $3, $4, $5, $6, NULL, NULL, NOW())`,
      [
        args.action,
        args.targetType,
        args.targetId,
        args.runId,
        args.workspaceId,
        JSON.stringify(args.detail ?? {}),
      ],
    )
  } catch (err) {
    log.warn('audit write failed', {
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
