/**
 * Console BFF: POST /api/flow-generator
 *
 * Thin proxy to the gateway's unified generation pipeline
 * (POST /api/v1/flow-generator/generate): prompt / engine selection /
 * normalization / topology validation / repair loop all live server-side.
 * Passes the gateway's canonical response (`flowData` = `type:'customNode'`
 * + `data.name`) straight through — no shape adaptation on this boundary
 * (BFF rule: proxy only). Provider API keys never reach the browser.
 *
 * （2026-09-05 画布自研化：替代 /api/flowise/api/v1/agentflowv2-generator
 * 的 vendor 形状适配层，后者已随 vendor/agentflow 一并退役。）
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

  const json = (await upstream.json()) as {
    success?: boolean
    data?: { flowData?: FlowData; bindings?: GenerateBindings }
  }
  const flowData = json.data?.flowData
  if (!flowData || !Array.isArray(flowData.nodes) || flowData.nodes.length === 0) {
    return errorResponse(502, '未生成有效的流程节点，请换一种描述重试')
  }
  // FR-13：bindings 透传 —— 生成即所得的透明度（Agent 节点数 / 未绑定数 / 执行档位）
  return NextResponse.json({ success: true, data: { flowData, bindings: json.data?.bindings ?? null } })
}

/** gateway FR-13 bindings 响应字段（console 侧只需要展示）。 */
interface GenerateBindings {
  agentNodeCount: number
  unboundAgentNodeCount: number
  note: string
}
