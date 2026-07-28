/**
 * Gateway / chat config.
 *
 * Server-only reads of `GATEWAY_URL` (and the client-visible defaults). The
 * console never dials backend services directly: every request goes through the
 * gateway (`apps/gateway`, default :8080), which threads `x-run-id` end-to-end
 * (see gateway `app.ts`). The browser hits the Next API route proxy
 * (`/api/chat`, `/api/workflows`, …) so the gateway URL stays server-side.
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
 * Client-visible default workflow id — the agent the chat view loads when no
 * explicit flow is bound.
 */
export const DEFAULT_FLOW_ID =
  process.env.NEXT_PUBLIC_DEFAULT_FLOW_ID ?? 'd87207fd-7a11-4d42-8580-2f03ca58e79d'

/** Maximum length we accept for a caller-supplied run id (mirrors gateway). */
export const MAX_RUN_ID_LEN = 128
