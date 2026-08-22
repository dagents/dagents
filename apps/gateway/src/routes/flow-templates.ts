/**
 * `/api/v1/flow-templates/*` — 流程模板中心（docs/flow-templates.md §4）。
 *
 * 双源单合同：内置模板（builtin/*.json import 内联）+ 用户模板（flow_templates
 * 表，画布「另存为模板」抽取入库）。instantiate 走 flow-template-pipeline：
 * personaName 命中人格库 → 复用/自动启用并绑回 agentId；未命中 → 节点降级
 * llmAgentflow（模板永远可跑，降级显式回传）。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { agentLibraryRegistry } from '../agent-library-registry.js'
import {
  extractTemplateFromFlow,
  instantiateFlowTemplate,
  scanTemplateParams,
  type AgentRef,
  type FlowTemplateSpec,
  type TemplateCategory,
} from '../flow-template-pipeline.js'
import { BUILTIN_FLOW_TEMPLATES } from '../flow-templates/builtin/index.js'

export const flowTemplateRoutes = new Hono()

const log = createLogger({ svc: 'gateway:flow-templates' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

interface UserTemplateRow {
  id: string
  name: string
  description: string | null
  icon: string
  category: string
  flow_data: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  agent_refs: AgentRef[] | null
  params: { name: string; defaultValue?: string }[] | null
  source_flow_id: string | null
  created_at: string | Date
}

function rowToSpec(row: UserTemplateRow): FlowTemplateSpec {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon,
    category: (row.category === 'dev' || row.category === 'research' || row.category === 'content' || row.category === 'ops'
      ? row.category
      : 'custom') as TemplateCategory,
    source: 'user',
    flowData: row.flow_data,
    agentRefs: row.agent_refs ?? [],
    params: row.params ?? [],
  }
}

/** 模板摘要里的成员解析状态（UI 确认步展示「将绑定 Agent / 将降级 LLM」）。 */
interface MemberSummary {
  personaName: string | null
  nodeId: string
  available: boolean
  division: string | null
}

function memberSummaries(refs: AgentRef[], entriesByName: Map<string, { division: string }>): MemberSummary[] {
  return refs.map((r) => {
    const hit = r.personaName ? entriesByName.get(r.personaName) : undefined
    return {
      personaName: r.personaName,
      nodeId: r.nodeId,
      available: !!hit,
      division: hit?.division ?? null,
    }
  })
}

/** GET / — 内置 + 用户模板合并列表（source 区分），附成员解析状态。 */
flowTemplateRoutes.get('/', async (c) => {
  let userRows: UserTemplateRow[] = []
  try {
    const { records } = await runQuery<UserTemplateRow>(
      `SELECT id, name, description, icon, category, flow_data, agent_refs, params, source_flow_id, created_at
         FROM flow_templates ORDER BY created_at DESC`,
    )
    userRows = records
  } catch (err) {
    log.error('list user templates failed', { error: String(err) })
    return fail(c, 502, '加载用户模板失败')
  }

  const all = [...BUILTIN_FLOW_TEMPLATES, ...userRows.map(rowToSpec)]
  const wanted = [...new Set(all.flatMap((t) => t.agentRefs.map((r) => r.personaName).filter((n): n is string => !!n)))]
  const entriesByName = new Map<string, { division: string }>()
  if (wanted.length > 0) {
    for (const e of agentLibraryRegistry.getAll()) {
      if (wanted.includes(e.name) && !entriesByName.has(e.name)) entriesByName.set(e.name, { division: e.division })
    }
  }

  return ok(c, {
    templates: all.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      source: t.source,
      nodeCount: t.flowData.nodes.length,
      agentRefs: memberSummaries(t.agentRefs, entriesByName),
      // 参数化（方案 G）：表单在实例化前渲染，列表只回参数名清单。
      paramNames: (t.params ?? scanTemplateParams(t.flowData)).map((p) => p.name),
    })),
  })
})

const fromFlowSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(8).optional(),
  category: z.enum(['dev', 'research', 'content', 'ops', 'custom']).optional(),
})

/** 路径参数里的 flowId 必须是 uuid —— 否则 SQL `::uuid` 转换会 502 而非 4xx。 */
const uuidSchema = z.string().uuid()

/**
 * POST /from-flow/:flowId — 画布「另存为模板」：抽取 + 清洗 + 入库。
 * flowId 非 uuid → 400；不存在 → 404；无 startAgentflow / 空 nodes → 422。
 */
flowTemplateRoutes.post('/from-flow/:flowId', async (c) => {
  const flowIdParam = c.req.param('flowId')
  const uuidCheck = uuidSchema.safeParse(flowIdParam)
  if (!uuidCheck.success) {
    return fail(c, 400, 'flowId 必须是 uuid', { flowId: flowIdParam })
  }
  const flowId = uuidCheck.data
  let parsed: z.infer<typeof fromFlowSchema>
  try {
    parsed = fromFlowSchema.parse((await c.req.json().catch(() => ({}))) ?? {})
  } catch (err) {
    return fail(c, 400, 'invalid from-flow body', { detail: String(err) })
  }

  let flowRow: { name: string; description: string | null; flow_data: unknown }
  try {
    const { records } = await runQuery<typeof flowRow>(
      `SELECT name, description, flow_data FROM flows WHERE id = $1::uuid`,
      [flowId],
    )
    if (!records[0]) return fail(c, 404, 'flow not found', { flowId })
    flowRow = records[0]
  } catch (err) {
    log.error('from-flow: flow lookup failed', { error: String(err) })
    return fail(c, 502, 'flow lookup failed')
  }

  // platformAgent 的 agentId → 人格名。仅记 library 溯源的 agent（设计 D2）：
  // 人格名要在库内可重绑才有意义；手工 agent 无溯源 → null（纯降级引用）。
  const nodes = ((flowRow.flow_data as { nodes?: Record<string, unknown>[] })?.nodes ?? [])
  const agentIds = [
    ...new Set(
      nodes
        .filter((n) => (n.data as Record<string, unknown> | undefined)?.name === 'platformAgentAgentflow')
        .map((n) => ((n.data as { inputs?: { agentId?: unknown } }).inputs?.agentId as string | undefined) ?? '')
        .filter((id): id is string => !!id),
    ),
  ]
  const personaNameByAgentId = new Map<string, string>()
  if (agentIds.length > 0) {
    const { records } = await runQuery<{ id: string; name: string }>(
      `SELECT id, name FROM agents
        WHERE id = ANY($1::uuid[]) AND library_meta->>'id' IS NOT NULL`,
      [agentIds],
    )
    for (const row of records) personaNameByAgentId.set(row.id, row.name)
  }

  const extracted = extractTemplateFromFlow(flowRow.flow_data as object, personaNameByAgentId)
  if (!extracted) {
    return fail(c, 422, '该 flow 无法抽取为模板：需要至少一个节点且以 Start 节点开头')
  }

  const { records: inserted } = await runQuery<{ id: string }>(
    `INSERT INTO flow_templates (name, description, icon, category, flow_data, agent_refs, params, source_flow_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::uuid)
     RETURNING id`,
    [
      parsed.name ?? `${flowRow.name}（模板）`,
      parsed.description ?? flowRow.description ?? '',
      parsed.icon ?? '📄',
      parsed.category ?? 'custom',
      JSON.stringify(extracted.flowData),
      JSON.stringify(extracted.agentRefs),
      JSON.stringify(extracted.params),
      flowId,
    ],
  )
  const id = inserted[0].id
  log.info('flow template extracted', { id, fromFlow: flowId, agentRefs: extracted.agentRefs.length, params: extracted.params.length })
  return c.json({ success: true, data: { id, agentRefCount: extracted.agentRefs.length, paramCount: extracted.params.length } }, 201)
})

const instantiateSchema = z.object({
  profile: z.enum(['full', 'slim', 'minimal']).optional(),
  flow_name: z.string().min(1).max(128).optional(),
  /** 参数化（方案 G）：{{变量}} 表单答案；缺省回落 defaultValue/空串。 */
  answers: z.record(z.string(), z.string()).optional(),
})

/** 模板寻址：'builtin/<slug>' 或用户模板 uuid。 */
async function resolveTemplate(id: string): Promise<FlowTemplateSpec | null> {
  if (id.startsWith('builtin/')) {
    return BUILTIN_FLOW_TEMPLATES.find((t) => t.id === id) ?? null
  }
  const { records } = await runQuery<UserTemplateRow>(
    `SELECT id, name, description, icon, category, flow_data, agent_refs, params, source_flow_id, created_at
       FROM flow_templates WHERE id = $1::uuid`,
    [id],
  ).catch(() => ({ records: [] as UserTemplateRow[] }))
  return records[0] ? rowToSpec(records[0]) : null
}

/**
 * POST …/instantiate — persona 重绑（复用/自动启用）或降级 LLM 节点 → draft flow。
 * 两种寻址形态共用：`/builtin/:slug/instantiate`（id 含斜杠，两段路由匹配不到）
 * 与 `/:id/instantiate`（用户模板 uuid）。返回 members（degraded 显式标注）。
 */
async function handleInstantiate(c: Context, id: string) {
  let parsed: z.infer<typeof instantiateSchema>
  try {
    parsed = instantiateSchema.parse((await c.req.json().catch(() => ({}))) ?? {})
  } catch (err) {
    return fail(c, 400, 'invalid instantiate body', { detail: String(err) })
  }

  const template = await resolveTemplate(id)
  if (!template) return fail(c, 404, `flow template not found: ${id}`, { id })

  let instantiated: Awaited<ReturnType<typeof instantiateFlowTemplate>>
  try {
    // builtin 模板没有 params 列 —— 实时扫描占位符，行为与用户模板一致。
    const params = template.params ?? scanTemplateParams(template.flowData)
    instantiated = await instantiateFlowTemplate(
      { ...template, params },
      { profile: parsed.profile, answers: parsed.answers },
    )
  } catch (err) {
    log.error('instantiate failed', { id, error: String(err) })
    return fail(c, 422, '模板实例化失败', { detail: String(err) })
  }

  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO flows (name, description, flow_data, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [
      parsed.flow_name ?? template.name,
      `Flow Template「${template.name}」实例化: ${template.description}`.slice(0, 2000),
      JSON.stringify(instantiated.flowData),
    ],
  )
  const flowId = records[0].id
  log.info('flow template instantiated', {
    templateId: id, flowId,
    bound: instantiated.members.filter((m) => !m.degraded).length,
    degraded: instantiated.members.filter((m) => m.degraded).length,
  })
  return c.json(
    { success: true, data: { flowId, templateId: id, members: instantiated.members } },
    201,
  )
}

flowTemplateRoutes.post('/builtin/:slug/instantiate', (c) =>
  handleInstantiate(c, `builtin/${c.req.param('slug')}`))
flowTemplateRoutes.post('/:id/instantiate', (c) => handleInstantiate(c, c.req.param('id')))

/** DELETE — 仅用户模板可删；内置模板 → 405（两种寻址形态）。 */
flowTemplateRoutes.delete('/builtin/:slug', (c) =>
  fail(c, 405, '内置模板不可删除（随仓库分发，见 flow-templates/builtin/README.md）'))
flowTemplateRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM flow_templates WHERE id = $1::uuid RETURNING id`,
    [id],
  )
  if (!records[0]) return fail(c, 404, `flow template not found: ${id}`, { id })
  log.info('flow template deleted', { id })
  return ok(c, { id })
})
