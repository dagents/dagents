/**
 * Console BFF: POST /api/flowise/api/v1/agentflowv2-generator/generate
 *
 * The agentflow canvas's GenerateFlowDialog ("What would you like to build?"):
 * takes { question, selectedChatModel } and returns { nodes, edges } that the
 * canvas loads directly. The selected model entry decides the engine:
 *  - `agent::<id>`   → the platform agent's CLI backend, via the gateway's
 *                      synchronous invoke (POST /api/v1/agents/:id/invoke)
 *  - `providerId::m` / default → the configured LLM provider, via the
 *                      gateway's dynamic LLM proxy (/api/v1/llm/*)
 * Provider API keys never reach the browser either way.
 *
 * Errors return { success, error, message } — the dialog reads `message` for
 * its error banner.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'
import {
  AGENT_MODEL_PREFIX,
  buildAgentPrompt,
  buildGeneratorMessages,
  extractJson,
  isAgentModel,
  normalizeGeneratedFlow,
  resolveProvider,
  type ProviderLike,
} from '@/lib/flow-generator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_PROVIDER_MESSAGE =
  '没有可用的 LLM Provider 或平台 Agent — 请先在 设置 → LLM Provider 添加 Provider，或在 Agent 页创建 Agent。'

function errorResponse(status: number, message: string): Response {
  return NextResponse.json({ success: false, error: message, message }, { status })
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { question?: unknown; selectedChatModel?: { name?: unknown } }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, '请求体不是合法 JSON')
  }
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) return errorResponse(400, '请描述你想构建的流程')
  const selectedName = typeof body.selectedChatModel?.name === 'string' ? body.selectedChatModel.name : undefined

  const runId = resolveRunId(req.headers.get('x-run-id'))
  const headers = forwardSessionHeaders(req, runId)

  // ── Engine 1: platform agent (agent::<id> entries) ─────────────────
  if (isAgentModel(selectedName)) {
    const agentId = selectedName!.slice(AGENT_MODEL_PREFIX.length)
    let invokeRes: Response
    try {
      invokeRes = await fetch(`${gatewayUrl()}/api/v1/agents/${encodeURIComponent(agentId)}/invoke`, {
        method: 'POST',
        headers,
        // BFF timeout sits above the gateway's 180s invoke cap
        signal: AbortSignal.timeout(200_000),
        body: JSON.stringify({ prompt: buildAgentPrompt(question) }),
      })
    } catch {
      return errorResponse(502, 'Agent 调用失败（网关不可达或超时），请稍后重试')
    }
    if (!invokeRes.ok) {
      const detail = await invokeRes
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => undefined)
      if (invokeRes.status === 404) return errorResponse(404, `平台 Agent 不存在（可能已被删除）`)
      if (invokeRes.status === 504) return errorResponse(504, 'Agent 执行超时（上限 3 分钟），请简化需求后重试')
      return errorResponse(502, `Agent 执行失败${detail ? `：${detail}` : ''}`)
    }
    const json = (await invokeRes.json()) as { success?: boolean; data?: { output?: string } }
    const content = json.data?.output ?? ''
    return finalize(content)
  }

  // ── Engine 2: LLM provider (providerId::model / gateway-default) ───
  let provider: ProviderLike | null = null
  let model: string | undefined
  try {
    const res = await fetch(`${gatewayUrl()}/api/v1/llm-providers`, { method: 'GET', cache: 'no-store', headers })
    if (res.ok) {
      const json = (await res.json()) as { success?: boolean; data?: { providers?: ProviderLike[] } }
      const resolved = resolveProvider(json.data?.providers ?? [], selectedName)
      provider = resolved?.provider ?? null
      model = resolved?.model
    }
  } catch {
    // handled below — no provider means we cannot call an LLM
  }
  if (!provider) return errorResponse(400, NO_PROVIDER_MESSAGE)

  if (provider.id) headers['x-llm-provider-id'] = provider.id

  // Ask the LLM for a flow through the gateway's provider proxy.
  let upstream: Response
  try {
    upstream = await fetch(`${gatewayUrl()}/api/v1/llm/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        ...(model ? { model } : {}),
        messages: buildGeneratorMessages(question),
        temperature: 0.2,
      }),
    })
  } catch {
    return errorResponse(502, 'LLM 请求失败（网关不可达或超时），请稍后重试')
  }

  if (!upstream.ok) {
    const detail = await upstream
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => undefined)
    if (detail === 'no llm provider available') return errorResponse(400, NO_PROVIDER_MESSAGE)
    return errorResponse(502, `LLM 请求失败${detail ? `：${detail}` : ''}`)
  }

  // choices[0].message.content → JSON → normalized { nodes, edges }
  let content: string
  try {
    const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    content = String(json.choices?.[0]?.message?.content ?? '')
  } catch {
    return errorResponse(502, 'LLM 响应无法解析，请重试')
  }
  return finalize(content)
}

/** Shared tail: engine output text → JSON → canvas-safe { nodes, edges }. */
function finalize(content: string): Response {
  try {
    const flow = normalizeGeneratedFlow(extractJson(content))
    if (flow.nodes.length === 0) {
      return errorResponse(502, '未生成有效的流程节点，请换一种描述重试')
    }
    return NextResponse.json(flow)
  } catch {
    return errorResponse(502, '返回的流程 JSON 无法解析，请重试')
  }
}
