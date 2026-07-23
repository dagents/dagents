import { createLogger } from '@mil/shared'
import { z } from 'zod'

/**
 * Gateway-side Flowise read fetch (M5b.1 / P1.10.T6).
 *
 * The workspace detail route enriches each linked flow with its live Flowise
 * name/status so the meta panel renders the flow's current state, not a stale
 * local copy. The gateway already holds the Flowise API key
 * (`FLOWISE_API_KEY`) and already proxies Flowise reads read-only
 * (`proxyFlowiseRead` in app.ts). This helper is the *server-internal* call
 * the workspace route makes — it dials Flowise directly with the key, the same
 * posture `proxyFlowiseRead` takes, but returns parsed JSON instead of piping
 * a Response.
 *
 * Kept separate from the console's `flowise-client.ts` (which lives behind the
 * Next proxy) so the gateway doesn't take a console dependency and so the key
 * never leaves the gateway process.
 *
 * Throws `FlowiseFetchError` carrying the status on non-2xx / unreachable, so
 * the caller can degrade gracefully (a Flowise outage shouldn't blank the
 * workspace meta panel). 503 when the key isn't configured (matches
 * `proxyFlowiseRead`'s posture).
 */

const log = createLogger({ svc: 'gateway:flowise-read' })

/** Flowise base URL (mirrors app.ts: 3101 in this stack). */
function flowiseUrl(): string {
  return (process.env.FLOWISE_URL ?? 'http://localhost:3101').replace(/\/+$/, '')
}

/** Flowise API key — injected on the upstream call (caller never sees it). */
function flowiseApiKey(): string {
  return process.env.FLOWISE_API_KEY ?? ''
}

export class FlowiseFetchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FlowiseFetchError'
  }
}

/**
 * Fetch JSON from a Flowise read endpoint (e.g. `/api/v1/chatflows/:id`).
 * Throws `FlowiseFetchError` on non-2xx / unreachable / non-JSON.
 */
export async function fetchFlowiseJson<T>(path: string): Promise<T> {
  if (!flowiseApiKey()) {
    throw new FlowiseFetchError(503, 'flowise api key not configured')
  }
  const url = `${flowiseUrl()}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${flowiseApiKey()}`, accept: 'application/json' },
    })
  } catch (err) {
    throw new FlowiseFetchError(502, `flowise unreachable: ${String(err)}`)
  }

  if (!res.ok) {
    log.warn('flowise read upstream error', { path, status: res.status })
    throw new FlowiseFetchError(res.status, `flowise ${path} failed (${res.status})`)
  }

  try {
    return (await res.json()) as T
  } catch (err) {
    throw new FlowiseFetchError(502, `flowise ${path} returned non-JSON: ${String(err)}`)
  }
}

/**
 * Zod schema for the Flowise `ChatFlow` row's shape (only the fields the
 * workspace route reads: id / name / deployed / updatedDate). Mirrors the
 * console's `flowiseChatflowSchema` but kept local so the gateway doesn't
 * depend on the console's lib.
 */
export const flowiseChatflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  deployed: z.boolean().nullable().optional(),
  flowData: z.string().optional(),
  createdDate: z.union([z.string(), z.date()]),
  updatedDate: z.union([z.string(), z.date()]),
})
export type FlowiseChatflow = z.infer<typeof flowiseChatflowSchema>
