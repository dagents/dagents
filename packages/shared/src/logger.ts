import pino from 'pino'
import { currentRunId } from './trace.js'

export interface Logger {
  debug(msg: string, ctx?: unknown): void
  info(msg: string, ctx?: unknown): void
  warn(msg: string, ctx?: unknown): void
  error(msg: string, ctx?: unknown): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOpts { runId?: string; [k: string]: unknown }

/**
 * Merge the active span's `run.id` into a log context object so every log
 * line emitted inside a run-entry span carries the run id — the "日志关联"
 * `currentRunId()` was annotated for but no caller wired.
 *
 * Precedence: an explicit `runId` already on the context (or on the logger
 * via `opts.runId`) wins over the span's, so a caller that binds a run id by
 * hand is never silently overwritten. Returns the context untouched when there
 * is no active span or no `run.id` on it.
 */
function withRunId(ctx: unknown, boundRunId: string | undefined): unknown {
  const spanRunId = currentRunId()
  if (!spanRunId) return ctx
  if (typeof ctx === 'object' && ctx !== null && !Array.isArray(ctx)) {
    const obj = ctx as Record<string, unknown>
    // Explicit context runId (or the logger's own bound runId) wins.
    if (obj.runId !== undefined || boundRunId !== undefined) return ctx
    return { ...obj, runId: spanRunId }
  }
  // Non-object context (undefined, string, number, …): wrap so the run id is
  // still attached without dropping the caller's value.
  return { ctx, runId: spanRunId }
}

export function createLogger(opts: LoggerOpts = {}): Logger {
  const pinoLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' }).child(opts)
  const bound = opts.runId
  return {
    debug: (msg, ctx) => pinoLogger.debug(withRunId(ctx ?? {}, bound) as object, msg),
    info: (msg, ctx) => pinoLogger.info(withRunId(ctx ?? {}, bound) as object, msg),
    warn: (msg, ctx) => pinoLogger.warn(withRunId(ctx ?? {}, bound) as object, msg),
    error: (msg, ctx) => pinoLogger.error(withRunId(ctx ?? {}, bound) as object, msg),
    child: (bindings) => createLogger({ ...opts, ...bindings }) as Logger,
  }
}
