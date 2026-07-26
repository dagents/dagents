import { runQuery } from '@dagents/db'
import type { AuditActorType, AuditTargetType } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { Context } from 'hono'
import type { SsoUser } from './auth.js'

/**
 * Audit logging for sensitive gateway operations (spec §1.4 gateway 职责 #5
 * "审计日志（敏感操作）"; plan M6.6 / P1.4.T6; risk R15).
 *
 * The gateway is the single choke point for key / permission / version-lock /
 * token-rotation mutations, so it owns the audit trail. `recordAudit` is the
 * one entry point every sensitive route calls after its main operation
 * succeeds (and, for destructive ops, before the response leaves the gateway).
 *
 * ## Fire-and-forget
 *
 * An audit write must NEVER block or fail the user's operation — losing an
 * audit row is acceptable; breaking a token delete because the audit INSERT
 * threw is not. `recordAudit` therefore swallows every error and only logs a
 * warn (R15: "审计记录写入失败不应阻断主操作流"). Callers do NOT await it on the
 * hot path; the returned promise resolves after the write settles (or fails)
 * so a caller that wants ordering can await, but a caller that doesn't is free
 * to ignore it.
 *
 * ## Context extraction
 *
 * `run_id` is read from the OTel-threaded `x-run-id` header (M6.1) so an audit
 * record correlates end-to-end with the trace that performed it. The actor is
 * read from the `x-user-id` / `x-client-id` headers the SSO middleware stamps
 * (M5b.4 / P1.4.T2); absent those (SSO not configured, or `REQUIRE_LOGIN`
 * off), the actor is `system:gateway` — the gateway itself is the principal
 * performing the admin mutation. Caller IP + User-Agent are captured
 * best-effort for forensic value.
 *
 * Never log the raw key — `detail` carries operation-specific context (changed
 * fields, pinned version hash) but never secrets.
 */

const log = createLogger({ svc: 'gateway:audit' })

/** Upper bound on a caller-supplied x-run-id — mirrors app.ts / console config. */
const MAX_RUN_ID_LEN = 128

/** Truncation cap for the User-Agent so an absurd header can't bloat the row. */
const MAX_UA_LEN = 512

export interface AuditTarget {
  type: AuditTargetType
  /** Id of the target object (new-api token id, version hash, …). */
  id: string
}

export interface AuditCtx {
  /** Sensitive action, e.g. 'token.create' / 'pipeline_version.lock'. */
  action: string
  target: AuditTarget
  /** Operation-specific context (changed fields, pinned hash, …). NEVER the raw key. */
  detail?: Record<string, unknown>
  /** Owning workspace; null for platform-scoped ops. */
  workspaceId?: string | null
}

/**
 * Read the OTel-threaded run id off the request. The flows proxy generates one
 * if absent; the token routes don't, so a caller-supplied `x-run-id` (threaded
 * by the console proxy) is the common case. Falls back to null — a missing run
 * id is fine for audit; the actor + action + target are the durable facts.
 */
function runIdFromContext(c: Context): string | null {
  const raw = c.req.header('x-run-id')?.trim()
  return raw && raw.length <= MAX_RUN_ID_LEN ? raw : null
}

/**
 * Resolve the actor off the SSO-stamped identity. M5b.4 wires the gateway
 * session middleware, which stamps `ssoUser` on the context (a verified
 * logged-in user) — that is the strongest actor signal, so it wins. The
 * `x-user-id` / `x-client-id` headers (forwarded by the console proxy or sent
 * by internal services) cover calls without a session (REQUIRE_LOGIN off, or a
 * service-to-service call). Absent all of those, the actor is `system:gateway`
 * — the gateway itself is the principal performing the admin mutation on the
 * caller's behalf, which is the honest audit story for an unauthenticated dev
 * setup.
 */
function actorFromContext(c: Context): { type: AuditActorType; id: string } {
  // M5b.4: a verified SSO session is the authoritative actor.
  const ssoUser = c.get('ssoUser') as SsoUser | undefined
  if (ssoUser?.sub) return { type: 'user', id: ssoUser.sub }
  const userId = c.req.header('x-user-id')?.trim()
  if (userId) return { type: 'user', id: userId }
  const clientId = c.req.header('x-client-id')?.trim()
  if (clientId) return { type: 'system', id: clientId }
  return { type: 'system', id: 'gateway' }
}

/**
 * Best-effort caller IP. Hono exposes the raw socket address; behind a proxy
 * the forwarded chain lives in `x-forwarded-for` (first hop is the client).
 * Returns null when neither is available.
 */
function ipFromContext(c: Context): string | null {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (fwd) return fwd
  // c.env has no reliable socket addr across Hono runtimes; the forwarded
  // header is the production signal. Absent it, leave IP null rather than
  // guess — a wrong IP is worse for forensics than a missing one.
  return null
}

function uaFromContext(c: Context): string | null {
  const ua = c.req.header('user-agent')?.trim()
  return ua ? ua.slice(0, MAX_UA_LEN) : null
}

/**
 * Insert one audit row. Parameterised; the jsonb `detail` is stringified so pg
 * stores it verbatim. Never throws — the caller's operation must not be
 * affected by an audit-write failure (see module doc: fire-and-forget).
 */
async function insertAudit(args: {
  actorType: AuditActorType
  actorId: string
  action: string
  targetType: AuditTargetType
  targetId: string
  runId: string | null
  workspaceId: string | null
  detail: Record<string, unknown>
  ip: string | null
  userAgent: string | null
}): Promise<void> {
  try {
    await runQuery(
      `INSERT INTO audit_log
         (actor_type, actor_id, action, target_type, target_id,
          run_id, workspace_id, detail, ip, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        args.actorType,
        args.actorId,
        args.action,
        args.targetType,
        args.targetId,
        args.runId,
        args.workspaceId,
        JSON.stringify(args.detail ?? {}),
        args.ip,
        args.userAgent,
      ],
    )
  } catch (err) {
    // Fire-and-forget: an audit write failure is logged but never propagated.
    // The user's operation already succeeded (or is about to); losing one
    // audit row is the lesser evil vs. failing the mutation.
    log.warn('audit write failed', {
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Record a sensitive operation against the audit log, best-effort.
 *
 * Reads actor + run_id + ip + user-agent off the request context, so the caller
 * only names the action + target + optional detail. The returned promise
 * resolves after the write settles — callers on the hot path may ignore it
 * (fire-and-forget); a caller that wants the audit row landed before
 * responding may `await` it.
 *
 * Never throws. Never blocks the caller's operation on failure.
 */
export function recordAudit(c: Context, ctx: AuditCtx): Promise<void> {
  const actor = actorFromContext(c)
  return insertAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: ctx.action,
    targetType: ctx.target.type,
    targetId: ctx.target.id,
    runId: runIdFromContext(c),
    workspaceId: ctx.workspaceId ?? null,
    detail: ctx.detail ?? {},
    ip: ipFromContext(c),
    userAgent: uaFromContext(c),
  })
}

/**
 * Record a version-lock audit without an HTTP context — the scheduler's repro
 * client snapshots a flow outside a request lifecycle (worker / fan-out), so it
 * has no `x-run-id` header. The caller passes the run id it already has (every
 * snapshot is bound to a run), and the actor is `system:scheduler`.
 *
 * Same fire-and-forget contract as `recordAudit`: never throws, logs on
 * failure. Kept as a separate entry point (not a Context overload) so the
 * scheduler doesn't depend on Hono types.
 */
export function recordVersionLockAudit(args: {
  /** The version hash the lock pinned (the content address). */
  versionHash: string
  /** The flow id the snapshot was taken from. */
  pipelineId: string
  /** The run the lock is bound to; null when the snapshot isn't run-scoped. */
  runId?: string | null
  /** Owning workspace; null for platform-scoped ops. */
  workspaceId?: string | null
  /** Who triggered the lock — defaults to the scheduler. */
  actorId?: string
}): Promise<void> {
  return insertAudit({
    actorType: 'system',
    actorId: args.actorId ?? 'scheduler',
    action: 'pipeline_version.lock',
    targetType: 'pipeline_version',
    targetId: args.versionHash,
    runId: args.runId ?? null,
    workspaceId: args.workspaceId ?? null,
    detail: { pipelineId: args.pipelineId, versionHash: args.versionHash },
    ip: null,
    userAgent: null,
  })
}
