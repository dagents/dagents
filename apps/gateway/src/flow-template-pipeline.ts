/**
 * flow-template-pipeline.ts — 流程模板的抽取与实例化（docs/flow-templates.md D1/D2）。
 *
 * 抽取（extractTemplateFromFlow，纯函数）：platformAgent 节点的 agentId（本机
 * uuid）清空并记入 agentRefs（nodeId → personaName + 节点任务指令），全节点
 * 剥离运行态字段；其余节点类型零改写。
 *
 * 实例化（instantiateFlowTemplate）：personaName 命中人格库 → 复用/自动启用
 * 成员并绑回 agentId（与团队场景同一管道）；未命中/无引用 → 节点降级为
 * llmAgentflow（任务指令当 systemPrompt），模板永远可跑。降级显式回传。
 */
import { createLogger } from '@dagents/shared'
import { agentLibraryRegistry, type AgentLibraryEntry } from './agent-library-registry.js'
import {
  findInstantiatedRows,
  insertLibraryAgent,
} from './agent-library-instantiate.js'
import type { PersonaProfile } from './persona-compiler.js'

const log = createLogger({ svc: 'gateway:flow-template-pipeline' })

/** 抽取时从节点上剥离的运行态键（画布保存的执行残留）。 */
const RUNTIME_DATA_KEYS = new Set([
  'output', 'result', 'executionData', 'execution_data', 'runId', 'run_id',
  'executionOutput', 'lastRun', '_executed',
])

export type TemplateCategory = 'dev' | 'research' | 'content' | 'ops' | 'custom'

export interface AgentRef {
  nodeId: string
  /** 库人格名（frontmatter name）；null = 无溯源，实例化时纯降级。 */
  personaName: string | null
  /** 节点级任务指令（降级时的 systemPrompt 素材）。 */
  task: string
}

export interface FlowTemplateSpec {
  id: string
  name: string
  description: string
  icon: string
  category: TemplateCategory
  source: 'builtin' | 'user'
  flowData: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  agentRefs: AgentRef[]
  /** `{{变量}}` 占位符清单（方案 G）；builtin 模板由路由侧实时扫描。 */
  params?: TemplateParam[]
}

export interface ExtractedTemplate {
  flowData: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  agentRefs: AgentRef[]
  /** `{{变量名}}` 占位符清单（方案 G）：实例化时表单回填。 */
  params: TemplateParam[]
}

/** 模板参数：节点文案中的 `{{name}}` 占位符（与引擎变量语法共用 `{{}}`）。 */
export interface TemplateParam {
  name: string
  defaultValue?: string
}

/** 占位符语法：`{{word}}`，首字符允许字母/下划线/中文， tolerate 空白。 */
const PARAM_PATTERN = /\{\{\s*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*\}\}/g

/**
 * 引擎运行时变量保留字（PRD FR-02 / 决议 D3）：这些单词型 `{{name}}` 由
 * 执行期 state 解析，绝不能收进模板参数 —— 否则实例化时被 answers 表单
 * 静默替换，运行输入从此到不了节点（`{{input}}` 双重身份坑：正则此前
 * 排除引擎变量只是「不匹配 $ / .」的巧合，单词型 flat-state 键照收不误）。
 * 带 `$` 前缀或 `.` 路径的写法（`{{$start.input}}`、`{{llm1.output}}`）
 * 扫描正则天然不匹配，无需在此列出。
 */
const ENGINE_RESERVED_PARAMS = new Set([
  'input', // start 节点写入 flat state 的运行输入
  // vendor 变量选择器历史推荐过的 chat 路径变量（画布运行下由 state 提供）
  'question',
  'chat_history',
  'current_date_time',
  'runtime_messages_length',
  'loop_count',
  'file_attachment',
])

/**
 * 实例化时做参数替换的文案字段（节点 data 的浅层 + inputs 嵌套）。
 * 刻意收窄到「提示词/回复类」文本字段——不递归扫描所有字符串，避免
 * 误伤 canvas 坐标/类型名等结构性字段。
 */
const PARAM_FIELDS = ['systemPrompt', 'prompt', 'userPrompt', 'content', 'question']

/** 扫描模板节点文案里的 `{{变量名}}` 占位符（去重、保持出现顺序）。 */
export function scanTemplateParams(
  flowData: { nodes?: unknown },
): TemplateParam[] {
  const names: string[] = []
  const seen = new Set<string>()
  const nodes = Array.isArray(flowData.nodes) ? (flowData.nodes as Record<string, unknown>[]) : []
  for (const node of nodes) {
    const data = node.data as Record<string, unknown> | undefined
    if (!data) continue
    const candidates: unknown[] = [
      ...PARAM_FIELDS.map((f) => data[f]),
      ...PARAM_FIELDS.map((f) => (data.inputs as Record<string, unknown> | undefined)?.[f]),
    ]
    for (const value of candidates) {
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(PARAM_PATTERN)) {
        const name = match[1]
        if (!name || ENGINE_RESERVED_PARAMS.has(name)) continue
        if (!seen.has(name)) {
          seen.add(name)
          names.push(name)
        }
      }
    }
  }
  return names.map((name) => ({ name }))
}

/**
 * 参数替换：把 nodes 文案里的 `{{name}}` 换成 answers[name]（缺省回落
 * defaultValue，再缺省空串——模板永远可实例化，不留悬空占位符）。
 */
export function applyTemplateParams(
  flowData: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] },
  params: TemplateParam[],
  answers: Record<string, string>,
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const resolve = (name: string): string | null => {
    if (Object.prototype.hasOwnProperty.call(answers, name)) return answers[name]
    const param = params.find((p) => p.name === name)
    if (!param) return null // 未声明的占位符 —— 可能是引擎运行时变量，保持原样
    return param.defaultValue ?? ''
  }
  const substitute = (text: string): string =>
    text.replace(PARAM_PATTERN, (whole, name: string) => resolve(name) ?? whole)

  const nodes = flowData.nodes.map((node) => {
    const data = node.data as Record<string, unknown> | undefined
    if (!data) return node
    const nextData: Record<string, unknown> = { ...data }
    for (const field of PARAM_FIELDS) {
      if (typeof nextData[field] === 'string') nextData[field] = substitute(nextData[field] as string)
    }
    const inputs = nextData.inputs as Record<string, unknown> | undefined
    if (inputs && typeof inputs === 'object') {
      const nextInputs: Record<string, unknown> = { ...inputs }
      for (const field of PARAM_FIELDS) {
        if (typeof nextInputs[field] === 'string') nextInputs[field] = substitute(nextInputs[field] as string)
      }
      nextData.inputs = nextInputs
    }
    return { ...node, data: nextData }
  })
  return { nodes, edges: flowData.edges }
}

/** 节点 data.name 判定（画布平铺 data.<field> 约定）。 */
function nodeName(node: Record<string, unknown>): string {
  const data = node.data as Record<string, unknown> | undefined
  return typeof data?.name === 'string' ? data.name : ''
}

/**
 * flow → 模板。`personaNameByAgentId` 由调用方从 agents 表构建
 * （id → name，含 library 溯源与非库 agent）。无 startAgentflow → null（调用方 422）。
 */
export function extractTemplateFromFlow(
  flowData: { nodes?: unknown; edges?: unknown },
  personaNameByAgentId: Map<string, string>,
): ExtractedTemplate | null {
  if (!Array.isArray(flowData.nodes) || flowData.nodes.length === 0) return null
  const hasStart = (flowData.nodes as Record<string, unknown>[]).some((n) => nodeName(n) === 'startAgentflow')
  if (!hasStart) return null

  const agentRefs: AgentRef[] = []
  const nodes = (flowData.nodes as Record<string, unknown>[]).map((node) => {
    const data = { ...(node.data as Record<string, unknown> | undefined) }
    for (const key of Object.keys(data)) {
      if (RUNTIME_DATA_KEYS.has(key)) delete data[key]
    }
    const next: Record<string, unknown> = { ...node, data }
    if (nodeName(node) === 'platformAgentAgentflow') {
      const inputs = { ...((data.inputs as Record<string, unknown>) ?? {}) }
      const agentId = typeof inputs.agentId === 'string' ? inputs.agentId : ''
      const task = typeof inputs.systemPrompt === 'string' ? inputs.systemPrompt : ''
      const personaName = agentId ? personaNameByAgentId.get(agentId) ?? null : null
      // agentId 是本机 uuid，模板里没有意义 —— 清空，改按人格名引用。
      inputs.agentId = ''
      data.inputs = inputs
      agentRefs.push({
        nodeId: typeof node.id === 'string' ? node.id : '',
        personaName,
        task,
      })
    }
    return next
  })

  const edges = Array.isArray(flowData.edges) ? (flowData.edges as Record<string, unknown>[]) : []
  return { flowData: { nodes, edges }, agentRefs, params: scanTemplateParams({ nodes }) }
}

export interface TemplateMember {
  persona: string | null
  agentId: string | null
  /** true = 节点已降级为 llmAgentflow。 */
  degraded: boolean
  /** persona 命中库但此前未启用 → 本次自动启用。 */
  enabled: boolean
}

export interface InstantiatedTemplate {
  flowData: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  members: TemplateMember[]
}

/**
 * 模板 → 可落库的 flow。personaName 解析复用团队场景策略：registry.getAll()
 * 单次扫描按名匹配（重名取 id 排序首个 + warn）；已启用成员复用，缺的自动
 * slim 启用；解析不到 → 该节点降级 llmAgentflow。
 */
export async function instantiateFlowTemplate(
  template: Pick<FlowTemplateSpec, 'flowData' | 'agentRefs' | 'name'> & { params?: TemplateParam[] },
  opts: { profile?: PersonaProfile; answers?: Record<string, string> } = {},
): Promise<InstantiatedTemplate> {
  const profile = opts.profile ?? 'slim'

  // 1. 收集 personaName 非空的引用，批量解析 + 复用检查（单次扫描/单次查库）。
  const wantedNames = [...new Set(template.agentRefs.map((r) => r.personaName).filter((n): n is string => !!n))]
  const entriesByName = new Map<string, AgentLibraryEntry>()
  if (wantedNames.length > 0) {
    const all = agentLibraryRegistry.getAll()
    for (const name of wantedNames) {
      const hits = all.filter((e) => e.name === name)
      if (hits.length === 0) continue
      if (hits.length > 1) log.warn(`persona name "${name}" resolves to ${hits.length} entries — using ${hits[0].id}`)
      entriesByName.set(name, hits[0])
    }
  }
  const resolvedIds = [...entriesByName.values()].map((e) => e.id)
  const existingRows = await findInstantiatedRows(resolvedIds)
  const agentIdByPersona = new Map<string, { agentId: string; enabled: boolean }>()
  for (const [name, entry] of entriesByName) {
    const row = existingRows.get(entry.id)
    if (row) {
      agentIdByPersona.set(name, { agentId: row.id, enabled: true })
      continue
    }
    const agentId = await insertLibraryAgent(entry, { profile, kind: 'claude' })
    agentIdByPersona.set(name, { agentId, enabled: false })
  }

  // 2. 重写节点：命中 → 绑回 agentId；未命中/无引用 → 降级 llmAgentflow。
  const refByNodeId = new Map(template.agentRefs.map((r) => [r.nodeId, r]))
  const members: TemplateMember[] = []
  const nodes = template.flowData.nodes.map((node) => {
    const ref = refByNodeId.get(String(node.id))
    if (!ref) return node
    const data = { ...(node.data as Record<string, unknown>) }
    const hit = ref.personaName ? agentIdByPersona.get(ref.personaName) : undefined
    if (hit) {
      const inputs = { ...((data.inputs as Record<string, unknown>) ?? {}) }
      inputs.agentId = hit.agentId
      data.inputs = inputs
      members.push({ persona: ref.personaName, agentId: hit.agentId, degraded: false, enabled: hit.enabled })
      return { ...node, data }
    }
    // 降级：platformAgent → llmAgentflow。任务指令以节点自身 inputs.systemPrompt
    // 为单一事实源（与绑定路径同源），ref.task 仅作向后兼容的兜底 —— 内置
    // JSON 的双拷贝即使漂移也不会造成绑定/降级行为分叉。
    const nodeTask = typeof (data.inputs as { systemPrompt?: string } | undefined)?.systemPrompt === 'string'
      ? ((data.inputs as { systemPrompt: string }).systemPrompt)
      : ''
    const task = nodeTask || ref.task
    const prefix = ref.personaName ? `以 ${ref.personaName} 的专家身份执行以下任务。\n\n` : ''
    const degradedData: Record<string, unknown> = {
      name: 'llmAgentflow',
      label: data.label ?? ref.personaName ?? 'LLM',
      model: '',
      systemPrompt: `${prefix}${task || `完成「${template.name}」中该节点的职责并产出结构化结果。`}`,
    }
    for (const key of Object.keys(data)) {
      if (key !== 'name' && key !== 'label' && !(key in degradedData)) degradedData[key] = data[key]
    }
    members.push({ persona: ref.personaName, agentId: null, degraded: true, enabled: false })
    return { ...node, data: degradedData }
  })

  // 参数回填（方案 G）：{{变量}} → 表单答案（缺省回落 defaultValue/空串）。
  // 在 persona 重绑/降级之后做，替换目标是最终文案。
  const finalFlow =
    template.params && template.params.length > 0
      ? applyTemplateParams({ nodes, edges: template.flowData.edges }, template.params, opts.answers ?? {})
      : { nodes, edges: template.flowData.edges }

  return { flowData: finalFlow, members }
}
