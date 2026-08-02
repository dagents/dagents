import { type NextRequest, NextResponse } from 'next/server'
import { CANVAS_NODES, convertNodeToFlowiseSchema, type AgentOption } from '@dagents/workflow'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

/**
 * Fetch the platform's agents (same source as the list route) so the
 * Platform Agent node's `agentId` input renders as a dropdown here too.
 * Best-effort: empty array on any failure → input falls back to string.
 */
async function fetchAgentOptions(req: NextRequest): Promise<AgentOption[]> {
  try {
    const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
    const res = await fetch(`${gatewayUrl()}/api/v1/agents`, {
      method: 'GET',
      cache: 'no-store',
      headers,
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      success?: boolean
      data?: { agents?: Array<{ id: string; name: string }> }
    }
    const agents = json.data?.agents ?? []
    return agents.map((a) => ({ name: a.id, label: a.name }))
  } catch {
    return []
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const nodeMeta = CANVAS_NODES.find((n) => n.name === name)
  if (!nodeMeta) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 })
  }

  const agentOptions = await fetchAgentOptions(req)
  return NextResponse.json(convertNodeToFlowiseSchema(nodeMeta, agentOptions))
}
