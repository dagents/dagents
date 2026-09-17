/**
 * `/api/v1/flow-templates/*` — 流程模板中心（docs/flow-templates.md §4）。
 *
 * 双源单合同：内置模板（builtin/*.json import 内联）+ 用户模板（flow_templates
 * 表，画布「另存为模板」抽取入库）。instantiate 走 flow-template-pipeline：
 * personaName 命中人格库 → 复用/自动启用并绑回 agentId；未命中 → 节点降级
 * llmAgentflow（模板永远可跑，降级显式回传）。
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import { agentLibraryRegistry } from '../agent-library-registry.js'
import {
  extractTemplateFromFlow,
  instantiateFlowTemplate,
  scanTemplateParams,
  type AgentRef,
  type FlowTemplateSpec,
} from '../flow-template-pipeline.js'
import {
  listUserTemplates,
  getUserTemplateRow,
  insertUserTemplate,
  deleteUserTemplate,
  rowToSpec,
  type UserTemplateRow,
} from '../repositories/flow-templates.repo.js'
import { getFlowForTemplateExtract } from '../repositories/workflows.repo.js'
import { findAgentNamesByLibrary } from '../repositories/agents.repo.js'
import { insertDraftFlow } from '../repositories/workflows.repo.js'
import { BUILTIN_FLOW_TEMPLATES } from '../flow-templates/builtin/index.js'
import { ok, fail } from '../lib/http.js'

export const flowTemplateRoutes = new Hono()

const log = createLogger({ svc: 'gateway:flow-templates' })


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
    userRows = await listUserTemplates()
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
      // 结构预览：拓扑分层（同层并行）—— 确认步骤链渲染的数据源
      layers: templateLayers(t.flowData, t.agentRefs),
      // 参数化（方案 G）：完整投影 {name, defaultValue} —— 缺省值在表单
      // placeholder 里可见（此前只回 name，用户「留空用缺省」却不知缺省是啥）
      params: t.params ?? scanTemplateParams(t.flowData),
      paramNames: (t.params ?? scanTemplateParams(t.flowData)).map((p) => p.name),
    })),
  })
})

/**
 * 模板结构预览投影（2026-08-30「从模板创建」优化）：把 flowData 拓扑
 * 分层（Kahn 深度 = max(前驱深度)+1），同层 = 并行。确认步据此渲染
 * 步骤链（层间 ↓、层内横排标「并行」）—— 此前用户确认前看不到流程
 * 长什么样（几步/串并行全靠猜）。persona 按 nodeId 关联 agentRefs。
 */
function templateLayers(
  flowData: { nodes?: unknown[]; edges?: unknown[] },
  agentRefs: Array<{ nodeId: string; personaName: string | null }>,
): Array<Array<{ id: string; label: string; kind: string; persona: string | null; prompt: string | null }>> {
  const nodes = (flowData.nodes ?? []) as Array<{ id: string; data?: Record<string, unknown> }>
  const edges = (flowData.edges ?? []) as Array<{ source: string; target: string }>
  const depth = new Map<string, number>()
  for (const n of nodes) depth.set(n.id, 0)
  // 迭代松弛：有环时上限 = 节点数，剩余节点保持当前深度（预览降级不报错）
  for (let round = 0; round < nodes.length; round++) {
    let changed = false
    for (const e of edges) {
      const d = depth.get(e.source)
      if (d == null || !depth.has(e.target)) continue
      const next = d + 1
      if ((depth.get(e.target) ?? 0) < next) {
        depth.set(e.target, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const personaByNode = new Map(agentRefs.map((r) => [r.nodeId, r.personaName]))
  const buckets = new Map<
    number,
    Array<{ id: string; label: string; kind: string; persona: string | null; prompt: string | null }>
  >()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const data = (n.data ?? {}) as Record<string, unknown>
    const inputs = (data.inputs ?? {}) as Record<string, unknown>
    const label = (typeof data.label === 'string' && data.label) || n.id
    const kind = String(data.name ?? '').replace(/Agentflow$/, '') || 'node'
    // 任务指令摘要（与 pipeline 的 PARAM_FIELDS 同域）：systemPrompt 优先，
    // 截 120 字 —— 审查「模板让 Agent 干什么」不必进画布
    const rawPrompt =
      (typeof inputs.systemPrompt === 'string' && inputs.systemPrompt) ||
      (typeof data.systemPrompt === 'string' && data.systemPrompt) ||
      (typeof inputs.prompt === 'string' && inputs.prompt) ||
      (typeof data.prompt === 'string' && data.prompt) ||
      ''
    const prompt = rawPrompt.trim().length > 0 ? rawPrompt.trim().slice(0, 120) : null
    const list = buckets.get(d) ?? []
    list.push({ id: n.id, label, kind, persona: personaByNode.get(n.id) ?? null, prompt })
    buckets.set(d, list)
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((d) => buckets.get(d)!)
}

const fromFlowSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(8).optional(),
  category: z.enum(['dev', 'research', 'content', 'ops', 'custom']).optional(),
  /** 参数默认值（PX-CV04 画布另存为模板的 chip 网格输入）：按名合并进
   *  服务端扫描结果 —— 名单仍以扫描为准，客户端只补 defaultValue。 */
  params: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        defaultValue: z.string().max(500).optional(),
      }),
    )
    .max(40)
    .optional(),
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

  let flowRow: Awaited<ReturnType<typeof getFlowForTemplateExtract>>
  try {
    flowRow = await getFlowForTemplateExtract(flowId)
    if (!flowRow) return fail(c, 404, 'flow not found', { flowId })
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
    const records = await findAgentNamesByLibrary(agentIds)
    for (const row of records) personaNameByAgentId.set(row.id, row.name)
  }

  const extracted = extractTemplateFromFlow(flowRow.flow_data as object, personaNameByAgentId)
  if (!extracted) {
    return fail(c, 422, '该 flow 无法抽取为模板：需要至少一个节点且以 Start 节点开头')
  }
  // PX-CV04：客户端在保存对话框为扫描出的参数填了默认值 → 按名合并
  //（名单/顺序以服务端扫描为准，未知名忽略，不信任客户端自报参数）。
  const params = parsed.params
    ? extracted.params.map((p) => {
        const clientDefault = parsed.params?.find((cp) => cp.name === p.name)?.defaultValue
        return clientDefault ? { ...p, defaultValue: clientDefault } : p
      })
    : extracted.params

  const id = await insertUserTemplate({
    name: parsed.name ?? `${flowRow.name}（模板）`,
    description: parsed.description ?? flowRow.description ?? '',
    icon: parsed.icon ?? '📄',
    category: parsed.category ?? 'custom',
    flowDataJson: JSON.stringify(extracted.flowData),
    agentRefsJson: JSON.stringify(extracted.agentRefs),
    paramsJson: JSON.stringify(params),
    sourceFlowId: flowId,
  })
  log.info('flow template extracted', { id, fromFlow: flowId, agentRefs: extracted.agentRefs.length, params: extracted.params.length })
  return c.json({ success: true, data: { id, agentRefCount: extracted.agentRefs.length, paramCount: extracted.params.length } }, 201)
})

// FR-05（PRD 决议 D6）：新名 camelCase `flowName`；`name` 与历史名
// `flow_name` 均兼容 —— 此前只认 flow_name，传 name 被 zod 静默吞掉
// （深评实测：自定义命名无效）。优先级 flowName > name > flow_name。
const instantiateSchema = z
  .object({
    profile: z.enum(['full', 'slim', 'minimal']).optional(),
    flow_name: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(128).optional(),
    flowName: z.string().min(1).max(128).optional(),
    /** 参数化（方案 G）：{{变量}} 表单答案；缺省回落 defaultValue/空串。 */
    answers: z.record(z.string(), z.string()).optional(),
  })
  .transform((v) => ({
    profile: v.profile,
    answers: v.answers,
    flow_name: v.flowName ?? v.name ?? v.flow_name,
  }))

/** 模板寻址：'builtin/<slug>' 或用户模板 uuid。 */
async function resolveTemplate(id: string): Promise<FlowTemplateSpec | null> {
  if (id.startsWith('builtin/')) {
    return BUILTIN_FLOW_TEMPLATES.find((t) => t.id === id) ?? null
  }
  const row = await getUserTemplateRow(id).catch(() => null)
  return row ? rowToSpec(row) : null
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

  const flowId = await insertDraftFlow(
    parsed.flow_name ?? template.name,
    `Flow Template「${template.name}」实例化: ${template.description}`.slice(0, 2000),
    JSON.stringify(instantiated.flowData),
  )
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
  const deletedId = await deleteUserTemplate(id)
  if (!deletedId) return fail(c, 404, `flow template not found: ${id}`, { id })
  log.info('flow template deleted', { id })
  return ok(c, { id })
})
