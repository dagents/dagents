/**
 * Gateway / chat config (P1.10.T2 / P1.10.T3).
 *
 * Server-only reads of `GATEWAY_URL` (and the client-visible defaults). The
 * console never dials Flowise directly: every prediction goes through the
 * gateway (`apps/gateway`, default :8080), which rewrites
 * `/api/v1/flows/<id>/prediction` → Flowise's prediction path and threads
 * `x-run-id` end-to-end (see gateway `app.ts`). The browser hits the Next API
 * route proxy (`/api/chat`) so the gateway URL stays server-side.
 */

/** Server-side gateway base URL. Defaults to the local gateway on :8080. */
export function gatewayUrl(): string {
  return (process.env.GATEWAY_URL ?? 'http://localhost:8080').replace(/\/+$/, '')
}

/**
 * Server-side scheduler base URL. Defaults to the local scheduler on :8082
 * (apps/scheduler/src/index.ts). The Workspace composer posts a new turn to the
 * scheduler's fan-out endpoint (a single-input batch) so a `runs` row carrying
 * `workspace_id` lands and the thread receives the turn — see
 * `apps/console/src/app/api/workspaces/[id]/runs/route.ts`.
 */
export function schedulerUrl(): string {
  return (process.env.SCHEDULER_URL ?? 'http://localhost:8082').replace(/\/+$/, '')
}

/**
 * Server-side base URL of the Flowise canvas editor (M0.3 / M2.3 前置).
 *
 * The console embeds the Flowise canvas editor in an `<iframe>` (D4/D5: canvas
 * editing still uses Flowise native UI). Flowise's
 * `XSS.ts:getIframeSecurityHeaders()` reads `IFRAME_ORIGINS` and emits it as the
 * CSP `frame-ancestors` directive; this URL is the *src* side — the origin the
 * iframe points at. Defaults to the vendored Flowise on :3100 (M0.3 uses the
 * flowise build on :3100; the M1 `.env.mil-agents` build runs on :3101 — set
 * FLOWISE_EDITOR_URL explicitly if you embed that instance instead).
 *
 * Trailing slashes are stripped so callers can safely append paths.
 */
export function flowiseEditorUrl(): string {
  return (process.env.FLOWISE_EDITOR_URL ?? 'http://localhost:3100').replace(/\/+$/, '')
}

/**
 * Client-visible default chatflow id — the agent the chat view loads when no
 * explicit flow is bound. The M1 demo chatflow
 * (docs/m1-flowise-agent-verification.md) is the canonical default.
 */
export const DEFAULT_FLOW_ID =
  process.env.NEXT_PUBLIC_DEFAULT_FLOW_ID ?? 'd87207fd-7a11-4d42-8580-2f03ca58e79d'

/** Maximum length we accept for a caller-supplied run id (mirrors gateway). */
export const MAX_RUN_ID_LEN = 128
