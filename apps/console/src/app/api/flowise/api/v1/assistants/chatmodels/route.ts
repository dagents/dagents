/**
 * Console BFF: GET /api/flowise/api/v1/assistants/chatmodels
 *
 * Serves the agentflow canvas's GenerateFlowDialog model dropdown. Combines:
 *  - the gateway's configured LLM providers (`GET /api/v1/llm-providers`) →
 *    `providerId::model` entries (generation runs on the provider)
 *  - the platform's agents → `agent::<id>` entries (generation runs on the
 *    agent's CLI backend via the gateway's sync invoke endpoint). Both agent
 *    tables are merged: the v0.3 `agents` catalogue AND the legacy dispatch
 *    `agent_daemons` join (what the /agents page renders); the invoke route
 *    resolves ids from either table.
 * With neither configured it returns a single fallback entry so the dialog
 * opens (generation then surfaces an actionable error instead of a 404).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'
import { listChatModels, type AgentLike, type ProviderLike } from '@/lib/flow-generator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))
  try {
    const [providersRes, catalogueRes, dispatchRes] = await Promise.all([
      fetch(`${gatewayUrl()}/api/v1/llm-providers`, { method: 'GET', cache: 'no-store', headers }),
      fetch(`${gatewayUrl()}/api/v1/agents`, { method: 'GET', cache: 'no-store', headers }),
      fetch(`${gatewayUrl()}/api/v1/dispatch/agents`, { method: 'GET', cache: 'no-store', headers }),
    ])
    const providers = providersRes.ok
      ? ((await providersRes.json()) as { data?: { providers?: ProviderLike[] } }).data?.providers ?? []
      : []
    const catalogue = catalogueRes.ok
      ? ((await catalogueRes.json()) as { data?: { agents?: AgentLike[] } }).data?.agents ?? []
      : []
    const dispatch = dispatchRes.ok
      ? ((await dispatchRes.json()) as { data?: { agents?: AgentLike[] } }).data?.agents ?? []
      : []
    const agents = [...catalogue, ...dispatch.filter((a) => !catalogue.some((c) => c.id === a.id))]
    return NextResponse.json(listChatModels(providers, agents))
  } catch {
    // fall through to the fallback entry
  }
  return NextResponse.json(listChatModels([]))
}
