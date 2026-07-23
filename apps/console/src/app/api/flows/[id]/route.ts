/**
 * `GET /api/flows/[id]` — one flow's DAG detail (P1.10.T5).
 *
 * Fetches the chatflow row (which carries `flowData` — the React Flow
 * nodes/edges) plus its recent executions through the gateway's read-only
 * Flowise passthrough, then builds the `FlowDetailView` the DAG canvas renders.
 * Node statuses are painted from the latest execution's per-node trace.
 */

import { type NextRequest, NextResponse } from 'next/server'
import {
  flowiseChatflowSchema,
  flowiseExecutionSchema,
  toFlowDetailView,
} from '@/lib/flows'
import { fetchFlowiseJson, FlowiseFetchError } from '@/lib/flowise-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing flow id' }, { status: 400 })
  }

  let flowRow: unknown
  let execsRaw: unknown
  try {
    flowRow = await fetchFlowiseJson<unknown>(`/api/v1/chatflows/${encodeURIComponent(id)}`, req)
    execsRaw = await fetchFlowiseJson<unknown>(
      `/api/v1/executions?agentflowId=${encodeURIComponent(id)}&page=1&limit=20`,
      req,
    )
  } catch (err) {
    const status = err instanceof FlowiseFetchError ? err.status : 502
    return NextResponse.json(
      { success: false, error: 'flow fetch failed', detail: String(err) },
      { status: status === 503 ? 503 : 502 },
    )
  }

  const flowParsed = flowiseChatflowSchema.safeParse(flowRow)
  if (!flowParsed.success) {
    return NextResponse.json(
      { success: false, error: 'flow shape unrecognized', detail: String(flowParsed.error) },
      { status: 502 },
    )
  }

  // Flowise's `getAllExecutions` always returns the `{ data, total }` envelope
  // (we carry `?page=&limit=`), but tolerate a bare array too. Without this
  // branch the envelope falls through to `[]`, every execution is dropped, and
  // node statuses silently degrade to idle.
  const execArr = Array.isArray(execsRaw)
    ? execsRaw
    : (execsRaw && Array.isArray((execsRaw as { data?: unknown }).data)
        ? (execsRaw as { data: unknown[] }).data
        : [])
  const execs = execArr
    .map((row) => flowiseExecutionSchema.safeParse(row))
    .filter((r): r is { success: true; data: ReturnType<typeof flowiseExecutionSchema.parse> } => r.success)
    .map((r) => r.data)

  const detail = toFlowDetailView(flowParsed.data, execs)
  return NextResponse.json({ success: true, data: detail })
}
