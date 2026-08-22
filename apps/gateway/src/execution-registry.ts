/**
 * execution-registry — in-process index of live executions
 * (execution-cancellation spec D4, architecture decision AD-1).
 *
 * Purpose: an HTTP cancel request must be able to FIND and stop a running
 * execution. Before this registry the only "running" signal was the DB
 * (`chats.status='running'`), which is state, not a control channel — nothing
 * could locate the actual AbortController / child process.
 *
 * Rules (single-process red line, docs/product-architecture.md AD-1):
 *   - In-memory Map, no Redis / pub-sub. A gateway restart drops the registry;
 *     the boot sweep (AD-6, index.ts) converges the dangling DB rows.
 *   - DB stays the source of truth for STATE; this registry is only the
 *     CONTROL channel (find + abort + await settle).
 *   - One execution per chat at a time (the existing model); runId is the
 *     secondary key used by workflow-run cancels.
 */
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:execution-registry' })

export type ExecutionKind = 'chat-agent' | 'chat-flow' | 'chat-stream' | 'workflow-run'

export interface ExecutionHandle {
  chatId: string
  runId: string
  kind: ExecutionKind
  startedAt: number
  /** Abort the execution (kills the CLI child / aborts in-flight fetches). */
  abort(reason?: string): void
  /** Resolves when the execution has fully settled (persisted + broadcast). */
  done: Promise<void>
}

/** How long cancel waits for the execution to settle before giving up on it
 *  (the SIGKILL escalation may still land afterwards). */
const CANCEL_SETTLE_TIMEOUT_MS = 5_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface CancelResult {
  found: boolean
  /** True when the execution settled within the budget after abort. */
  settled: boolean
  kind?: ExecutionKind
}

class ExecutionRegistry {
  private byChat = new Map<string, ExecutionHandle>()
  private byRun = new Map<string, ExecutionHandle>()

  register(handle: ExecutionHandle): void {
    this.byChat.set(handle.chatId, handle)
    this.byRun.set(handle.runId, handle)
    log.info('execution registered', { chatId: handle.chatId, runId: handle.runId, kind: handle.kind })
  }

  unregister(handle: ExecutionHandle): void {
    // Only remove if the maps still point at THIS handle (a same-chat
    // re-registration must not be clobbered by a stale unregister).
    if (this.byChat.get(handle.chatId) === handle) this.byChat.delete(handle.chatId)
    if (this.byRun.get(handle.runId) === handle) this.byRun.delete(handle.runId)
  }

  getByChat(chatId: string): ExecutionHandle | undefined {
    return this.byChat.get(chatId)
  }

  getByRun(runId: string): ExecutionHandle | undefined {
    return this.byRun.get(runId)
  }

  activeCount(): number {
    return this.byChat.size
  }

  async cancelChat(chatId: string, reason = 'user cancelled'): Promise<CancelResult> {
    const handle = this.byChat.get(chatId)
    if (!handle) return { found: false, settled: false }
    return cancelHandle(handle, reason)
  }

  async cancelRun(runId: string, reason = 'user cancelled'): Promise<CancelResult> {
    const handle = this.byRun.get(runId)
    if (!handle) return { found: false, settled: false }
    return cancelHandle(handle, reason)
  }
}

async function cancelHandle(handle: ExecutionHandle, reason: string): Promise<CancelResult> {
  log.info('cancelling execution', { chatId: handle.chatId, runId: handle.runId, kind: handle.kind, reason })
  handle.abort(reason)
  const settled = await Promise.race([
    handle.done.then(() => true),
    sleep(CANCEL_SETTLE_TIMEOUT_MS).then(() => false),
  ])
  if (!settled) {
    log.warn('execution did not settle within cancel budget (SIGKILL escalation may follow)', {
      chatId: handle.chatId,
      runId: handle.runId,
    })
  }
  return { found: true, settled, kind: handle.kind }
}

export const executionRegistry = new ExecutionRegistry()
