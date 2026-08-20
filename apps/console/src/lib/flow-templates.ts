/**
 * flow-templates.ts — 流程模板中心的 console API client（unwrap 模式）。
 *
 * 内置模板 id 形如 'builtin/<slug>'（含斜杠）—— 代理层为 builtin 与 uuid
 * 用户模板提供两种路径，本模块按 id 前缀分流。
 */

export interface FlowTemplateMemberSummary {
  personaName: string | null
  nodeId: string
  available: boolean
  division: string | null
}

export interface FlowTemplateSummary {
  id: string
  name: string
  description: string
  icon: string
  category: 'dev' | 'research' | 'content' | 'ops' | 'custom'
  source: 'builtin' | 'user'
  nodeCount: number
  agentRefs: FlowTemplateMemberSummary[]
}

export interface FlowTemplateMember {
  persona: string | null
  agentId: string | null
  degraded: boolean
  enabled: boolean
}

export interface FlowTemplateInstantiateResult {
  flowId: string
  templateId: string
  members: FlowTemplateMember[]
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label}（HTTP ${res.status}）${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null
  if (!body || !body.success || body.data === undefined) {
    throw new Error(body?.error ?? `${label}：未知错误`)
  }
  return body.data
}

/** 内置 id（含斜杠）与用户 uuid id 分别走各自的代理路径。 */
function instantiatePath(id: string): string {
  return id.startsWith('builtin/')
    ? `/api/flow-templates/builtin/${encodeURIComponent(id.slice('builtin/'.length))}/instantiate`
    : `/api/flow-templates/${encodeURIComponent(id)}/instantiate`
}

export async function fetchFlowTemplates(): Promise<FlowTemplateSummary[]> {
  const res = await fetch('/api/flow-templates', { cache: 'no-store' })
  const data = await unwrap<{ templates: FlowTemplateSummary[] }>(res, '加载流程模板失败')
  return data.templates
}

export async function extractFlowTemplate(
  flowId: string,
  req: { name?: string; description?: string; icon?: string; category?: string } = {},
): Promise<{ id: string; agentRefCount: number }> {
  const res = await fetch(`/api/flow-templates/from-flow/${encodeURIComponent(flowId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  return unwrap(res, '另存为模板失败')
}

export async function instantiateFlowTemplate(
  id: string,
  req: { flowName?: string } = {},
): Promise<FlowTemplateInstantiateResult> {
  const res = await fetch(instantiatePath(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow_name: req.flowName }),
  })
  return unwrap(res, '从模板创建失败')
}

export async function deleteFlowTemplate(id: string): Promise<{ id: string }> {
  const path = id.startsWith('builtin/')
    ? `/api/flow-templates/builtin/${encodeURIComponent(id.slice('builtin/'.length))}`
    : `/api/flow-templates/${encodeURIComponent(id)}`
  const res = await fetch(path, { method: 'DELETE' })
  return unwrap(res, '删除模板失败')
}
