/**
 * `GET /api/flows` — flow list for the AgentFlows browse page (P1.10.T5).
 *
 * Fetches Flowise's chatflow list (AGENTFLOW type) through the gateway's
 * read-only passthrough, then enriches each row with its latest run status by
 * also fetching recent executions. The browser never sees Flowise shapes — this
 * route returns the console's `FlowSummary[]` envelope.
 *
 * Flowise's `getAllChatflows` returns either a bare array (no pagination) or
 * `{ data, total }` (with `?page=&limit=`); both are normalized here. We pass
 * `?type=AGENTFLOW` so the list is the agentflow DAGs the browse page renders
 * (CHATFLOWs are linear conversations, not DAGs).
 */

import { type NextRequest, NextResponse } from 'next/server'
import {
  flowiseChatflowSchema,
  flowiseExecutionSchema,
  summarizeFlows,
  groupExecutionsByFlow,
} from '@/lib/flows'
import { fetchFlowiseJson, FlowiseFetchError } from '@/lib/flowise-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Flowise list shape: bare array OR `{ data, total }` when paginated. */
type FlowiseListResult = unknown[] | { data: unknown[]; total: number }

export async function GET(req: NextRequest): Promise<NextResponse> {
  let listRaw: FlowiseListResult
  let execsRaw: unknown
  try {
    // Limit the list to a reasonable page for the browse sidebar; the design's
    // "Flows · 328" count is illustrative, not a hard requirement. 50 keeps the
    // payload small while covering the active set.
    listRaw = await fetchFlowiseJson<FlowiseListResult>(
      '/api/v1/chatflows?type=AGENTFLOW&page=1&limit=50',
      req,
    )
    // Recent executions across the listed flows — one round-trip, then group
    // by agentflowId client-side. Flowise returns the newest first.
    execsRaw = await fetchFlowiseJson<unknown>('/api/v1/executions?page=1&limit=50', req)
  } catch (err) {
    const status = err instanceof FlowiseFetchError ? err.status : 502
    return NextResponse.json(
      { success: false, error: 'flows fetch failed', detail: String(err) },
      { status: status === 503 ? 503 : 502 },
    )
  }

  const listArr = Array.isArray(listRaw) ? listRaw : listRaw.data
  const flows = listArr
    .map((row) => flowiseChatflowSchema.safeParse(row))
    .filter((r): r is { success: true; data: ReturnType<typeof flowiseChatflowSchema.parse> } => r.success)
    .map((r) => r.data)

  // Flowise's `getAllExecutions` always returns the `{ data, total }` envelope
  // (it carries `?page=&limit=`), but tolerate a bare array too — same dual-shape
  // normalization as the chatflow list above. Without this branch the envelope
  // falls through to `[]` and every execution is silently dropped.
  const execArr = Array.isArray(execsRaw)
    ? execsRaw
    : (execsRaw && Array.isArray((execsRaw as { data?: unknown }).data)
        ? (execsRaw as { data: unknown[] }).data
        : [])
  const execs = execArr
    .map((row) => flowiseExecutionSchema.safeParse(row))
    .filter((r): r is { success: true; data: ReturnType<typeof flowiseExecutionSchema.parse> } => r.success)
    .map((r) => r.data)

  const grouped = groupExecutionsByFlow(execs)
  // v0.3-M2.1: pass per-flow repro version hashes (best-effort; the gateway
  // exposes a flow's snapshot hash through the repro route, not the chatflow
  // list, so the list page threads '' until a later task enriches this).
  const summary = summarizeFlows(flows, grouped)

  return NextResponse.json({ success: true, data: summary })
}
