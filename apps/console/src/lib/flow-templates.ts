/**
 * flow-templates.ts — 流程模板中心的 console API client（数据获取走 lib/api.ts 单源）。
 *
 * 内置模板 id 形如 'builtin/<slug>'（含斜杠）—— 代理层为 builtin 与 uuid
 * 用户模板提供两种路径，本模块按 id 前缀分流。
 */


import { apiFetch } from '@/lib/api'

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
  /** `{{变量}}` 占位符名清单（方案 G）：实例化前表单回填。 */
  paramNames?: string[]
  /** 完整参数（2026-08-30 二轮）：含缺省值 —— 表单 placeholder 可见。 */
  params?: Array<{ name: string; defaultValue?: string }>
  /** 结构预览（2026-08-30）：拓扑分层 —— 同层并行。确认步骤链渲染源。 */
  layers?: Array<Array<{ id: string; label: string; kind: string; persona: string | null; prompt: string | null }>>
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

/** 内置 id（含斜杠）与用户 uuid id 分别走各自的代理路径。 */
function instantiatePath(id: string): string {
  return id.startsWith('builtin/')
    ? `/api/flow-templates/builtin/${encodeURIComponent(id.slice('builtin/'.length))}/instantiate`
    : `/api/flow-templates/${encodeURIComponent(id)}/instantiate`
}

export async function fetchFlowTemplates(): Promise<FlowTemplateSummary[]> {
  const data = await apiFetch<{ templates: FlowTemplateSummary[] }>('/api/flow-templates', undefined, '加载流程模板')
  return data.templates
}

export async function extractFlowTemplate(
  flowId: string,
  req: {
    name?: string
    description?: string
    icon?: string
    category?: string
    /** 参数默认值覆盖（PX-CV04）：gateway 按名合并进自身扫描结果。 */
    params?: Array<{ name: string; defaultValue?: string }>
  } = {},
): Promise<{ id: string; agentRefCount: number }> {
  return apiFetch(`/api/flow-templates/from-flow/${encodeURIComponent(flowId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }, '另存为模板')
}

export async function instantiateFlowTemplate(
  id: string,
  req: { flowName?: string; answers?: Record<string, string> } = {},
): Promise<FlowTemplateInstantiateResult> {
  return apiFetch(instantiatePath(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow_name: req.flowName, answers: req.answers }),
  }, '从模板创建')
}

export async function deleteFlowTemplate(id: string): Promise<{ id: string }> {
  const path = id.startsWith('builtin/')
    ? `/api/flow-templates/builtin/${encodeURIComponent(id.slice('builtin/'.length))}`
    : `/api/flow-templates/${encodeURIComponent(id)}`
  return apiFetch(path, { method: 'DELETE' }, '删除模板')
}
