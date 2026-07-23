/**
 * run_id resolution + server-side threading (plan M5b.4 / P1.10.T10).
 *
 * The acceptance bar for M5b.4 is "所有请求带 run_id": every console → gateway
 * hop carries an `x-run-id`, generated if the caller didn't send one, so the
 * gateway's OTel run-entry span (M6.1) and the audit trail (M6.6) can
 * correlate every request end-to-end. Before M5b.4 only the chat path
 * generated a run id (client-side, in `chat-client.ts`); the read paths
 * (agents / flows / fleet-stats / tokens) forwarded a caller-supplied id only
 * and sent none when the browser omitted it — so their gateway hops had no
 * `x-run-id` at all and were untraceable.
 *
 * This module centralizes the rule so every proxy route applies it identically:
 * trim + cap a caller header, else a fresh UUID — the same posture the
 * gateway's flow proxy already takes.
 *
 * The MAX_RUN_ID_LEN constant mirrors the gateway's cap (`apps/gateway/src/
 * app.ts`); a caller id longer than it is dropped (not truncated) so a
 * malformed/absurd value can't be echoed into logs or forwarded upstream.
 */

export const MAX_RUN_ID_LEN = 128

/**
 * Resolve the `x-run-id` to forward on a server-side proxy hop. Returns the
 * caller's header when present + well-formed, otherwise a fresh UUID — so a
 * request that arrived with no run id still leaves the console carrying one.
 *
 * Server-only: uses `node:crypto.randomUUID`. It is imported only by server
 * route handlers (all current importers are under `app/api/**`), so the lazy
 * `require` keeps `node:crypto` out of any client bundle.
 */
export function resolveRunId(callerRunId: string | null | undefined): string {
  const trimmed = callerRunId?.trim()
  if (trimmed && trimmed.length <= MAX_RUN_ID_LEN) return trimmed
  // Lazy import shape: `node:crypto` is a built-in, but referencing it at the
  // top of a module also imported by client code would still bundle it. Keep
  // the require inside the function so only server call sites pay for it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
  return randomUUID()
}

