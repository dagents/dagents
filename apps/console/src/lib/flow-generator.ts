/**
 * AI flow-generator support for the agentflow canvas (vendor GenerateFlowDialog).
 *
 * The vendor dialog calls two Flowise-shaped endpoints through the
 * `/api/flowise/api/v1/*` BFF prefix:
 *   GET  /assistants/chatmodels            → model list for the dropdown
 *   POST /agentflowv2-generator/generate   → { nodes, edges } for the canvas
 *
 * Neither is implemented anywhere in the repo (the vendor UI shipped without a
 * backend), so both 404'd. These pure helpers implement the mapping /
 * prompting / normalization; the route files stay thin HTTP shims.
 *
 * Model identity scheme: `"<providerId>::<modelId>"` — the generate route
 * parses it back to (provider, model). The fallback entry `gateway-default`
 * means "first active provider, provider's default model".
 */

import { CANVAS_NODES } from '@dagents/workflow'

/** Vendor ChatModel shape (GenerateFlowDialog dropdown entry). */
export interface ChatModel {
  name: string
  label: string
  description?: string
  category?: string
}

/** Minimal provider shape from GET /api/v1/llm-providers. */
export interface ProviderLike {
  id: string
  name: string
  providerType?: string
  defaultModel?: string | null
  models?: unknown[]
  status?: string
}

/** Minimal agent shape from GET /api/v1/agents (the /agents page catalogue). */
export interface AgentLike {
  id: string
  name: string
  kind: string
}

/** Dropdown-name prefix marking "generate via this platform agent" entries. */
export const AGENT_MODEL_PREFIX = 'agent::'

/** Dropdown entry used when no provider is configured (generate then 400s
 *  with an actionable message instead of the dialog dying on a 404). */
export const FALLBACK_MODEL: ChatModel = {
  name: 'gateway-default',
  label: '平台默认 LLM',
  description: '使用 Gateway 第一个激活的 LLM Provider。尚未配置时请先在 设置 → LLM Provider 添加。',
  category: 'default',
}

/** Map configured providers + platform agents → chat-model dropdown entries.
 *  Agent entries (`agent::<id>`) run the generation on the agent's CLI
 *  backend via the gateway's synchronous invoke endpoint. */
export function listChatModels(providers: ProviderLike[], agents: AgentLike[] = []): ChatModel[] {
  const models: ChatModel[] = []
  for (const p of providers) {
    const modelIds = (Array.isArray(p.models) && p.models.length > 0
      ? p.models
      : p.defaultModel
        ? [p.defaultModel]
        : []
    ).map(String)
    for (const m of modelIds) {
      models.push({
        name: `${p.id}::${m}`,
        label: `${p.name} · ${m}`,
        description: p.providerType,
        category: p.providerType,
      })
    }
  }
  for (const a of agents) {
    models.push({
      name: `${AGENT_MODEL_PREFIX}${a.id}`,
      label: `${a.name} · Agent`,
      description: `平台 Agent（${a.kind}）— 用该 Agent 的 CLI 执行生成`,
      category: 'agent',
    })
  }
  return models.length > 0 ? models : [FALLBACK_MODEL]
}

/** True when a dropdown name selects a platform agent (vs an LLM provider). */
export function isAgentModel(name: string | undefined): boolean {
  return !!name && name.startsWith(AGENT_MODEL_PREFIX)
}

/** Resolve a dropdown name back to a provider + concrete model. */
export function resolveProvider(
  providers: ProviderLike[],
  modelName?: string,
): { provider: ProviderLike; model?: string } | null {
  if (modelName && modelName.includes('::')) {
    const [pid, model] = modelName.split('::')
    const provider = providers.find((p) => p.id === pid)
    if (provider) return { provider, model: model || undefined }
  }
  const fallback = providers.find((p) => p.status === 'active') ?? providers[0]
  return fallback ? { provider: fallback, model: fallback.defaultModel ?? undefined } : null
}

/** Common LLM aliases the model tends to emit → canonical canvas types. */
const TYPE_ALIASES: Record<string, string> = {
  start: 'startAgentflow',
  agent: 'agentAgentflow',
  platformagent: 'platformAgentAgentflow',
  llm: 'llmAgentflow',
  chatmodel: 'llmAgentflow',
  tool: 'toolAgentflow',
  http: 'httpAgentflow',
  httpRequest: 'httpAgentflow',
  condition: 'conditionAgentflow',
  conditionagent: 'conditionAgentAgentflow',
  iteration: 'iterationAgentflow',
  loop: 'loopAgentflow',
  humaninput: 'humanInputAgentflow',
  directreply: 'directReplyAgentflow',
  customfunction: 'customFunctionAgentflow',
  executeflow: 'executeFlowAgentflow',
  retriever: 'retrieverAgentflow',
}

/** Canvas node-type whitelist (from the shared registry — same list the
 *  nodes BFF route serves to the palette). */
export const CANVAS_NODE_TYPES = new Set(CANVAS_NODES.map((n) => n.name))

function canonicalType(raw: unknown): string | null {
  const t = String(raw ?? '').trim()
  if (CANVAS_NODE_TYPES.has(t)) return t
  const aliased = TYPE_ALIASES[t.toLowerCase()]
  return aliased && CANVAS_NODE_TYPES.has(aliased) ? aliased : null
}

/** The generation instruction (node catalog + output rules). Exported via
 *  buildGeneratorMessages / buildAgentPrompt, not used directly. */
function generatorSystemPrompt(): string {
  const catalog = CANVAS_NODES.map((n) => `- ${n.name}（${n.label}）: ${n.description}`).join('\n')
  return [
    '你是 AgentFlow 编排专家。根据用户需求生成一个 agent 工作流，只输出 JSON，不要任何解释文字。',
    '',
    '输出格式（严格遵守）：',
    '{"nodes": [{"id": "n1", "type": "startAgentflow", "position": {"x": 0, "y": 200}, "data": {}}, ...],',
    ' "edges": [{"id": "e1", "source": "n1", "target": "n2"}, ...]}',
    '',
    '可用节点类型：',
    catalog,
    '',
    '规则：',
    '1. 第一个节点必须是 startAgentflow。',
    '2. 只能使用上面列出的 type，id 用简短字符串（n1、n2…），edges 的 source/target 必须指向存在的节点 id。',
    '3. position 从左到右布局，相邻节点 x 间隔约 300，同一列分支 y 间隔约 200。',
    '4. data 里可以放该节点类型的合理默认字段；不确定就给 {}。',
    '5. 结束/回复类路径用 directReplyAgentflow 收尾（当流程需要给用户答复时）。',
  ].join('\n')
}

/** Build the chat-completions messages for flow generation (LLM provider path). */
export function buildGeneratorMessages(question: string): Array<{ role: string; content: string }> {
  return [
    { role: 'system', content: generatorSystemPrompt() },
    { role: 'user', content: question },
  ]
}

/** Build a single combined prompt for the platform-agent path (CLI agents
 *  take one prompt — no system/user roles). */
export function buildAgentPrompt(question: string): string {
  return `${generatorSystemPrompt()}\n\n---\n\n用户需求：${question}`
}

/** Strip markdown code fences and extract the first JSON object/array. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const start = stripped.search(/[[{]/)
  if (start < 0) throw new Error('no JSON found in LLM output')
  const open = stripped[start]!
  const close = open === '{' ? '}' : ']'
  const end = stripped.lastIndexOf(close)
  if (end <= start) throw new Error('unterminated JSON in LLM output')
  return JSON.parse(stripped.slice(start, end + 1))
}

interface RawNode {
  id?: unknown
  type?: unknown
  position?: { x?: unknown; y?: unknown }
  data?: unknown
}

interface NormalizedNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

interface NormalizedEdge {
  id: string
  source: string
  target: string
  type: string
}

/**
 * Normalize LLM output into canvas-safe { nodes, edges }:
 * - coerce common type aliases, drop unknown-type nodes (and their edges)
 * - guarantee unique string ids, numeric positions (grid fallback), object data
 * - edges: agentflowEdge type, dropped when they reference missing nodes
 */
export function normalizeGeneratedFlow(raw: unknown): { nodes: NormalizedNode[]; edges: NormalizedEdge[] } {
  const obj = (raw ?? {}) as { nodes?: unknown; edges?: unknown }
  const rawNodes: RawNode[] = Array.isArray(obj.nodes) ? (obj.nodes as RawNode[]) : []

  const seen = new Set<string>()
  const nodes: NormalizedNode[] = []
  rawNodes.forEach((n, i) => {
    const type = canonicalType(n.type)
    if (!type) return
    let id = String(n.id ?? `n${i + 1}`)
    while (seen.has(id)) id = `${id}_${i}`
    seen.add(id)
    const px = Number(n.position?.x)
    const py = Number(n.position?.y)
    nodes.push({
      id,
      type,
      position: {
        x: Number.isFinite(px) ? px : (i % 4) * 300,
        y: Number.isFinite(py) ? py : Math.floor(i / 4) * 200,
      },
      data: n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? (n.data as Record<string, unknown>) : {},
    })
  })

  const rawEdges = Array.isArray(obj.edges) ? (obj.edges as Array<Record<string, unknown>>) : []
  const edges: NormalizedEdge[] = []
  rawEdges.forEach((e, i) => {
    const source = String(e.source ?? '')
    const target = String(e.target ?? '')
    if (!seen.has(source) || !seen.has(target)) return
    edges.push({
      id: String(e.id ?? `e${i + 1}`),
      source,
      target,
      type: 'agentflowEdge',
    })
  })

  return { nodes, edges }
}
