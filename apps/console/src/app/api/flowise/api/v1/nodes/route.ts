import { type NextRequest, NextResponse } from 'next/server'
import { CANVAS_NODES, convertNodeToFlowiseSchema, type AgentOption } from '@dagents/workflow'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

/**
 * Fetch the platform's agents from the gateway's `/api/v1/agents` route
 * (which reads the `agents` table — the same source PlatformAgentNode's
 * agentFetcher uses) and map them to Flowise option entries so the Platform
 * Agent node's `agentId` input renders as a dropdown of the user's agents.
 *
 * Best-effort: returns an empty array on any failure (gateway down, auth
 * required, empty catalogue) — the input falls back to a plain string.
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

export async function GET(req: NextRequest): Promise<Response> {
  const agentOptions = await fetchAgentOptions(req)
  const nodes = CANVAS_NODES.map((n) => convertNodeToFlowiseSchema(n, agentOptions))

  return NextResponse.json(nodes, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  })
}
