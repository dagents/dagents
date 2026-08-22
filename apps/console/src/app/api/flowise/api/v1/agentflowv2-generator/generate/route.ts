/**
 * Console BFF: POST /api/flowise/api/v1/agentflowv2-generator/generate
 *
 * Thin proxy to the gateway's unified generation pipeline
 * (POST /api/v1/flow-generator/generate) since A1 (docs/product-plan.md):
 * prompt / engine selection / normalization / topology validation / repair
 * loop all live server-side. This shim keeps the vendor dialog's contract —
 * `{ question, selectedChatModel }` in, Flowise-shaped `{ nodes, edges }`
 * out (the gateway speaks canonical `type:'customNode'` + `data.name`; the
 * dialog expects the agentflow type name as `type`). Provider API keys
 * never reach the browser either way.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'
import type { FlowData } from '@dagents/workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(status: number, message: string): Response {
  return NextResponse.json({ success: false, error: message, message }, { status })
}

/** Canonical gateway flow → vendor dialog shape (`type` IS the agentflow name). */
function toVendorFlow(flowData: FlowData) {
  return {
    nodes: flowData.nodes.map((n) => ({
      id: n.id,
      type: typeof n.data.name === 'string' ? n.data.name : (n.type ?? 'llmAgentflow'),
      position: n.position ?? { x: 0, y: 0 },
      data: n.data,
    })),
    edges: flowData.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'agentflowEdge',
    })),
  }
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
  const selectedName =
    typeof body.selectedChatModel?.name === 'string' ? body.selectedChatModel.name : undefined

  const runId = resolveRunId(req.headers.get('x-run-id'))
  const headers = forwardSessionHeaders(req, runId)

  let upstream: Response
  try {
    upstream = await fetch(`${gatewayUrl()}/api/v1/flow-generator/generate`, {
      method: 'POST',
      headers,
      // BFF timeout sits above the gateway's 180s CLI cap
      signal: AbortSignal.timeout(200_000),
      body: JSON.stringify({ question, selectedChatModel: selectedName, source: 'canvas' }),
    })
  } catch {
    return errorResponse(502, '生成服务不可达（网关超时），请稍后重试')
  }

  if (!upstream.ok) {
    const detail = (await upstream
      .json()
      .catch(() => undefined)) as { error?: string; validationErrors?: string[] } | undefined
    if (upstream.status === 422) {
      const errs = (detail?.validationErrors ?? []).join('；')
      return errorResponse(
        422,
        `生成的流程未通过校验（已自动修复一轮）${errs ? `：${errs}` : ''}，请换个描述重试`,
      )
    }
    if (upstream.status === 400) return errorResponse(400, detail?.error ?? '请求无效，请重试')
    return errorResponse(502, detail?.error ?? '生成失败，请稍后重试')
  }

  const json = (await upstream.json()) as { success?: boolean; data?: { flowData?: FlowData } }
  const flowData = json.data?.flowData
  if (!flowData || !Array.isArray(flowData.nodes) || flowData.nodes.length === 0) {
    return errorResponse(502, '未生成有效的流程节点，请换一种描述重试')
  }
  return NextResponse.json(toVendorFlow(flowData))
}
