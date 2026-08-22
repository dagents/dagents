/**
 * `/api/v1/flow-generator/*` — 统一 AI 工作流生成管线（docs/product-plan.md
 * 方案 A1/A2/A5，架构决策 AD-2/AD-4）。
 *
 * 此前 chat `@workflow` 与画布 GenerateFlowDialog 是两套平行实现（prompt、
 * 引擎选择、校验强度、超时防护全不一致），且 chat 路径解析失败会静默降级
 * 三节点兜底模板。本模块收敛为 gateway 单一服务，两个入口共用：
 *
 *   chat   → chat-execute.ts routeWorkflowCommand 直接调 generateFlow()
 *   canvas → console BFF（agentflowv2-generator/generate）薄代理本路由
 *
 * 管线（三道防线取代静默兜底）：
 *   1. 引擎生成：CLI-first（claude）→ HTTP provider 兜底；canvas 可显式指定
 *      provider 或 agent 引擎（`providerId::model` / `agent::<id>`）。
 *   2. 归一 + 校验：extractJson → 别名归一到 canonical 形状（type:'customNode'
 *      + data.name）→ validateFlowTopology（@dagents/workflow 单源校验器）。
 *   3. 修复循环：校验失败 → 错误清单喂回同一引擎修一轮 → 复检；仍失败则
 *      显式失败（绝不静默兜底）——由调用方渲染失败卡片。
 *
 * 每次生成写一条 generator_attempts 埋点（AD-4：遥测与 audit 分表）。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import {
  CANVAS_NODES,
  validateFlowTopology,
  type FlowData,
  type TopologyError,
  type TopologyWarning,
} from '@dagents/workflow'
import { createCliLlmClient, createLlmClient } from './workflow-clients.js'
import { skillsRegistry } from '../skills-registry.js'

export const flowGeneratorRoutes = new Hono()

const log = createLogger({ svc: 'gateway:flow-generator' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

// ─────────────────────────────────────────────────────────────────────────
// Prompt（自 chat-execute 迁入，单一真相源）
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the workflow-generator system prompt. Exported for unit tests.
 *
 * CLI-first: generation runs on the local CLI by default (same execution
 * mechanism as chat), with an HTTP provider only as fallback insurance.
 * The prompt carries the REAL platform inventories — agents (so "claude a
 * 做规划" maps to a platformAgentAgentflow node with the agent's UUID) and
 * installed skills — because a generator that can only invent anonymous LLM
 * nodes cannot orchestrate what the platform actually has.
 */
export function buildWorkflowGeneratorPrompt(
  userDesc: string,
  agents: { id: string; name: string; kind: string; summary: string }[],
  skills: { name: string; description: string }[],
): string {
  const nodeNames = CANVAS_NODES.map((n) => `${n.name} (${n.label})`).join(', ')
  // 防御性上限（docs/agent-library.md D1）：agents 表只装「已启用」的人格，
  // 正常规模远低于此；cap 防的是用户手动激活数百个的极端情况 —— 与 skills
  // 的 40 条上限同思路，宁可让生成器少看到几个 agent，也不能撑爆生成 prompt。
  const MAX_GENERATOR_AGENTS = 80
  const listedAgents = agents.slice(0, MAX_GENERATOR_AGENTS)
  const omittedAgents = agents.length - listedAgents.length
  const agentLines = listedAgents.length
    ? listedAgents.map((a) => `- ${a.name} | kind=${a.kind} | id=${a.id}${a.summary ? ` | ${a.summary.slice(0, 80)}` : ''}`).join('\n') +
      (omittedAgents > 0 ? `\n(... ${omittedAgents} more agents omitted — pick from the list above only)` : '')
    : '(no agents registered — do not use platformAgentAgentflow)'
  const skillLines = skills.length
    ? skills.slice(0, 40).map((s) => `- ${s.name}: ${s.description.slice(0, 80)}`).join('\n')
    : '(no skills installed)'
  return `You are a workflow designer for the Dagents platform.
Given a user's description, generate a valid FlowData JSON object with "nodes" and "edges" arrays.

Available node types (use these EXACT values in data.name):
${nodeNames}

Platform agents (for platformAgentAgentflow nodes, set data.inputs.agentId to the agent's id):
${agentLines}

Installed skills (agents may reference these; skills influence instructions, not node config):
${skillLines}

Rules:
- Every flow MUST start with a node whose data.name is "startAgentflow"
- Use unique node ids like "node_1", "node_2", etc.
- Each node MUST have: id, type: "customNode", position: {x, y}, data: { name, label, ...config }
- When the user mentions an agent/role doing work (e.g. "claude a 做需求规划"), use a platformAgentAgentflow node bound to the matching agent id above
- Every platformAgentAgentflow node MUST set data.inputs.systemPrompt to a concrete, self-contained task instruction for THAT step's role (in the user's language): what this role is responsible for, what input it receives, and what deliverable it must produce. Never rely on the node label alone — the label is display-only and never reaches the model.
- For LLM nodes (data.name: "llmAgentflow"), set data.model and data.systemPrompt
- For DirectReply nodes (data.name: "directReplyAgentflow"), set data.content
- Position nodes in a left-to-right layout with ~250px spacing
- Return ONLY the JSON object, no markdown fences, no explanation

User description:
${userDesc}

Example structure:
{"nodes":[{"id":"node_1","type":"customNode","position":{"x":0,"y":200},"data":{"name":"startAgentflow","label":"Start"}},{"id":"node_2","type":"customNode","position":{"x":250,"y":200},"data":{"name":"platformAgentAgentflow","label":"规划","inputs":{"agentId":"<uuid from the list above>","systemPrompt":"你是需求规划角色。根据上游输入梳理目标与约束，产出结构化的需求规划（目标、范围、验收标准）。"}}},{"id":"node_3","type":"customNode","position":{"x":500,"y":200},"data":{"name":"directReplyAgentflow","label":"Direct Reply","content":"Done"}}],"edges":[{"id":"edge_1","source":"node_1","target":"node_2"},{"id":"edge_2","source":"node_2","target":"node_3"}]}`
}

/** 修复循环指令：把结构化错误清单喂回引擎（导出供单测）。 */
export function buildRepairInstruction(errors: string[]): string {
  return [
    '你刚才生成的工作流 JSON 未通过平台校验，问题清单：',
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    '',
    '请修复以上所有问题，重新输出完整的工作流 JSON。只输出 JSON 本体，不要 markdown 代码围栏，不要解释。',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// 引擎选择（canvas 的 selectedChatModel 字符串 → 引擎决策）
// ─────────────────────────────────────────────────────────────────────────

export type GeneratorEngineChoice =
  | { kind: 'auto' } // CLI-first（chat 默认；canvas 的 gateway-default 同样走 CLI 基线）
  | { kind: 'provider'; providerId?: string; model?: string }
  | { kind: 'agent'; agentId: string }

/**
 * `agent::<id>` → agent 引擎；`<providerId>::<model>` → 指定 provider；
 * 其余（含 `gateway-default` / 未指定）→ auto。canvas 默认从「必须配
 * provider」升级为 CLI-first 基线，与 chat 同路径。
 */
export function parseSelectedModel(selected: string | undefined): GeneratorEngineChoice {
  if (selected?.startsWith('agent::')) {
    const agentId = selected.slice('agent::'.length).trim()
    if (agentId) return { kind: 'agent', agentId }
    return { kind: 'auto' } // malformed `agent::` with empty id — never treat as provider 'agent'
  }
  if (selected?.includes('::')) {
    const [providerId, model] = selected.split('::')
    if (providerId) return { kind: 'provider', providerId, model: model || undefined }
  }
  return { kind: 'auto' }
}

// ─────────────────────────────────────────────────────────────────────────
// 输出提取与归一（自 console lib/flow-generator.ts 迁入，输出改为 canonical）
// ─────────────────────────────────────────────────────────────────────────

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

const CANVAS_NODE_TYPES = new Set(CANVAS_NODES.map((n) => n.name))

function canonicalType(raw: unknown): string | null {
  const t = String(raw ?? '').trim()
  if (CANVAS_NODE_TYPES.has(t)) return t
  const aliased = TYPE_ALIASES[t.toLowerCase()]
  return aliased && CANVAS_NODE_TYPES.has(aliased) ? aliased : null
}

/**
 * Normalize LLM output into the canonical gateway flow shape
 * (`type: 'customNode'` + `data.name` carrying the agentflow type):
 * - coerce common type aliases, drop unknown-type nodes (and their edges)
 * - guarantee unique string ids, numeric positions (grid fallback), object data
 * - edges: drop dangling refs, preserve handle routing fields
 *
 * Vendor-shape output (`type` IS the agentflow name) and canonical-shape input
 * (`type: 'customNode'` + `data.name`) are both accepted.
 */
export function normalizeToCanonicalFlow(raw: unknown): { flowData: FlowData; droppedNodes: string[] } {
  const obj = (raw ?? {}) as { nodes?: unknown; edges?: unknown }
  const rawNodes = Array.isArray(obj.nodes) ? (obj.nodes as Array<Record<string, unknown>>) : []

  const seen = new Set<string>()
  const nodes: FlowData['nodes'] = []
  const droppedNodes: string[] = []
  rawNodes.forEach((n, i) => {
    const data =
      n.data && typeof n.data === 'object' && !Array.isArray(n.data)
        ? (n.data as Record<string, unknown>)
        : {}
    let typeName: string | null
    if (n.type === 'customNode') {
      // canonical input — the type lives in data.name
      typeName = canonicalType(typeof data.name === 'string' ? data.name : '')
    } else {
      // vendor / bare input — the type IS the agentflow name
      typeName = canonicalType(n.type)
    }
    if (!typeName) {
      droppedNodes.push(String(n.id ?? `node_${i + 1}`))
      return
    }
    let id = String(n.id ?? `node_${i + 1}`)
    while (seen.has(id)) id = `${id}_${i}`
    seen.add(id)
    const pos = n.position as { x?: unknown; y?: unknown } | undefined
    const px = Number(pos?.x)
    const py = Number(pos?.y)
    nodes.push({
      id,
      type: 'customNode',
      position: {
        x: Number.isFinite(px) ? px : (i % 4) * 300,
        y: Number.isFinite(py) ? py : Math.floor(i / 4) * 200,
      },
      data: {
        ...data,
        name: typeName,
        label: typeof data.label === 'string' && data.label ? data.label : typeName,
      },
    })
  })

  const rawEdges = Array.isArray(obj.edges) ? (obj.edges as Array<Record<string, unknown>>) : []
  const edges: FlowData['edges'] = []
  rawEdges.forEach((e, i) => {
    const source = String(e.source ?? '')
    const target = String(e.target ?? '')
    if (!seen.has(source) || !seen.has(target)) return
    const edge: FlowData['edges'][number] = {
      id: String(e.id ?? `edge_${i + 1}`),
      source,
      target,
    }
    if (typeof e.sourceHandle === 'string') edge.sourceHandle = e.sourceHandle
    if (typeof e.targetHandle === 'string') edge.targetHandle = e.targetHandle
    edges.push(edge)
  })

  return { flowData: { nodes, edges }, droppedNodes }
}

// ─────────────────────────────────────────────────────────────────────────
// 生成管线（依赖可注入，供单测）
// ─────────────────────────────────────────────────────────────────────────

export interface GeneratorAgentRow {
  id: string
  name: string
  kind: string
  summary: string
}

export interface GenerateDeps {
  loadAgents(): Promise<GeneratorAgentRow[]>
  loadSkills(): Promise<{ name: string; description: string }[]>
  callEngine(engine: GeneratorEngineChoice, messages: { role: string; content: string }[]): Promise<{
    text: string
    engineUsed: string
  }>
  recordAttempt(attempt: GeneratorAttemptRow): Promise<void>
}

export interface GeneratorAttemptRow {
  attemptId: string
  source: 'chat' | 'canvas'
  engine: string
  userDesc: string
  repairRounds: number
  validationErrors: string[]
  outcome: 'success' | 'failed_validation' | 'llm_error'
  flowId: string | null
  chatId: string | null
  durationMs: number
  rawOutputPreview: string | null
}

/** 默认依赖：DB 清单 + 双引擎调用 + generator_attempts 埋点。 */
export const defaultGenerateDeps: GenerateDeps = {
  async loadAgents() {
    const { records } = await runQuery<GeneratorAgentRow>(
      `SELECT id, name, kind, summary FROM agents ORDER BY name`,
      [],
    )
    return records
  },
  async loadSkills() {
    return skillsRegistry.list().map(({ name, description }) => ({ name, description }))
  },
  async callEngine(engine, messages) {
    if (engine.kind === 'provider') {
      const result = await createLlmClient({
        providerId: engine.providerId,
        model: engine.model,
      }).chat({ model: engine.model ?? '', messages, temperature: 0.7 })
      return { text: result.text, engineUsed: 'http' }
    }
    if (engine.kind === 'agent') {
      const { records } = await runQuery<{ name: string; kind: string; instructions: string | null }>(
        `SELECT name, kind, instructions FROM agents WHERE id = $1::uuid`,
        [engine.agentId],
      )
      const agent = records[0]
      if (!agent) throw new Error(`agent ${engine.agentId} not found`)
      // Agent instructions become an extra system message ahead of the generator
      // prompt — the CLI client merges system messages (buildCliMessages).
      const withPersona = agent.instructions
        ? [{ role: 'system', content: agent.instructions }, ...messages]
        : messages
      const result = await createCliLlmClient(agent.kind as never).chat({
        model: '',
        messages: withPersona,
      })
      return { text: result.text, engineUsed: `agent:${agent.name}` }
    }
    // auto: CLI-first, HTTP active provider as insurance (chat 默认路径)
    try {
      const result = await createCliLlmClient('claude').chat({ model: '', messages })
      return { text: result.text, engineUsed: 'cli' }
    } catch (cliErr) {
      log.warn('generation via CLI failed, trying HTTP provider', { error: String(cliErr) })
      const result = await createLlmClient().chat({ model: '', messages, temperature: 0.7 })
      return { text: result.text, engineUsed: 'cli-then-http' }
    }
  },
  async recordAttempt(attempt) {
    // 埋点绝不反噬生成主流程
    try {
      await runQuery(
        `INSERT INTO generator_attempts
           (id, source, engine, user_desc, repair_rounds, validation_errors, outcome,
            flow_id, chat_id, duration_ms, raw_output_preview)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid, $9::uuid, $10, $11)`,
        [
          attempt.attemptId,
          attempt.source,
          attempt.engine,
          attempt.userDesc,
          attempt.repairRounds,
          JSON.stringify(attempt.validationErrors),
          attempt.outcome,
          attempt.flowId,
          attempt.chatId,
          attempt.durationMs,
          attempt.rawOutputPreview,
        ],
      )
    } catch (err) {
      log.warn('generator attempt telemetry insert failed', { attemptId: attempt.attemptId, error: String(err) })
    }
  },
}

export interface GenerateFlowOptions {
  userDesc: string
  source: 'chat' | 'canvas'
  chatId?: string
  selectedChatModel?: string
}

export type GenerateFlowResult =
  | {
      status: 'success'
      flowData: FlowData
      warnings: TopologyWarning[]
      droppedNodes: string[]
      engineUsed: string
      repairRounds: number
      attemptId: string | null
    }
  | {
      status: 'failed'
      stage: 'llm' | 'validation'
      error: string
      validationErrors?: string[]
      engineUsed: string | null
      repairRounds: number
      attemptId: string | null
    }

/** 修复轮上限：一轮修复 + 复检，控制时延与成本（docs/product-plan.md A2）。 */
const MAX_REPAIR_ROUNDS = 1

function errorStrings(errors: TopologyError[]): string[] {
  return errors.map((e) => (e.node ? `[${e.node}] ${e.message}` : e.message))
}

/**
 * 统一生成管线：引擎 → 提取归一 → 拓扑校验 →（失败）修复一轮 → 显式结果。
 * 不落库（flows 由调用方持久化）；每 attempt 写一条 generator_attempts。
 */
export async function generateFlow(
  opts: GenerateFlowOptions,
  deps: GenerateDeps = defaultGenerateDeps,
): Promise<GenerateFlowResult> {
  const startedAt = Date.now()
  const attemptId = randomUUID()
  const engineChoice = parseSelectedModel(opts.selectedChatModel)

  const [agents, skills] = await Promise.all([deps.loadAgents(), deps.loadSkills()])
  const systemPrompt = buildWorkflowGeneratorPrompt(opts.userDesc, agents, skills)
  let messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opts.userDesc },
  ]

  let engineUsed: string | null = null
  let rawText = ''
  let repairRounds = 0
  let validationErrors: string[] = []

  const persistAttempt = (outcome: GeneratorAttemptRow['outcome'], flowId: string | null) =>
    deps.recordAttempt({
      attemptId,
      source: opts.source,
      engine: engineUsed ?? 'n/a',
      userDesc: opts.userDesc,
      repairRounds,
      validationErrors,
      outcome,
      flowId,
      chatId: opts.chatId ?? null,
      durationMs: Date.now() - startedAt,
      rawOutputPreview: rawText ? rawText.slice(0, 500) : null,
    })

  // ── 引擎调用（含修复循环）──
  try {
    let gen
    try {
      gen = await deps.callEngine(engineChoice, messages)
    } catch (firstErr) {
      // 修复轮也需要引擎可用；首轮就挂则直接显式失败
      throw firstErr
    }
    engineUsed = gen.engineUsed
    rawText = gen.text

    let normalized = normalizeSafely(rawText)
    let verdict = validate(normalized)

    while (!verdict.ok && repairRounds < MAX_REPAIR_ROUNDS) {
      repairRounds++
      validationErrors = verdict.ok ? [] : errorStrings(verdict.errors)
      log.info('generation repair round', { attemptId, round: repairRounds, errors: validationErrors })
      messages = [
        ...messages,
        { role: 'assistant', content: rawText.slice(0, 8000) },
        { role: 'user', content: buildRepairInstruction(validationErrors) },
      ]
      const repaired = await deps.callEngine(engineChoice, messages)
      engineUsed = repaired.engineUsed
      rawText = repaired.text
      normalized = normalizeSafely(rawText)
      verdict = validate(normalized)
    }

    if (verdict.ok) {
      const result: GenerateFlowResult = {
        status: 'success',
        flowData: normalized.flowData,
        warnings: verdict.warnings,
        droppedNodes: normalized.droppedNodes,
        engineUsed: engineUsed ?? 'n/a',
        repairRounds,
        attemptId,
      }
      validationErrors = []
      await persistAttempt('success', null)
      return result
    }

    validationErrors = verdict.ok ? [] : errorStrings(verdict.errors)
    await persistAttempt('failed_validation', null)
    return {
      status: 'failed',
      stage: 'validation',
      error: `生成的工作流未通过结构校验（已尝试 ${repairRounds} 轮自动修复）`,
      validationErrors,
      engineUsed,
      repairRounds,
      attemptId,
    }
  } catch (err) {
    const message = String(err)
    log.warn('generation engine failed', { attemptId, engineUsed, error: message })
    await persistAttempt('llm_error', null)
    return {
      status: 'failed',
      stage: 'llm',
      error: message,
      engineUsed,
      repairRounds,
      attemptId,
    }
  }
}

function normalizeSafely(rawText: string): {
  flowData: FlowData
  droppedNodes: string[]
  parseFailed: boolean
} {
  try {
    return { ...normalizeToCanonicalFlow(extractJson(rawText)), parseFailed: false }
  } catch {
    // Empty flow fails validation with a parse-specific message below — keeps
    // the pipeline null-free and the repair loop informed about the real cause.
    return { flowData: { nodes: [], edges: [] }, droppedNodes: [], parseFailed: true }
  }
}

function validate(
  normalized: { flowData: FlowData; droppedNodes: string[]; parseFailed: boolean },
):
  | { ok: true; warnings: TopologyWarning[] }
  | { ok: false; errors: TopologyError[]; warnings: TopologyWarning[] } {
  if (normalized.parseFailed) {
    return {
      ok: false,
      errors: [{ message: 'LLM 输出中找不到可解析的工作流 JSON' }],
      warnings: [],
    }
  }
  const verdict = validateFlowTopology(normalized.flowData)
  if (verdict.ok) return { ok: true, warnings: verdict.warnings }
  return { ok: false, errors: verdict.errors, warnings: verdict.warnings }
}

/** chat 路径持久化 flow 后回填埋点（canvas 路径不落库，attempt 保持 flow_id 空）。 */
export async function attachFlowIdToAttempt(attemptId: string, flowId: string): Promise<void> {
  try {
    await runQuery(
      `UPDATE generator_attempts SET flow_id = $2::uuid WHERE id = $1::uuid`,
      [attemptId, flowId],
    )
  } catch (err) {
    log.warn('attach flow to attempt failed', { attemptId, flowId, error: String(err) })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP 路由（canvas BFF 薄代理的目标）
// ─────────────────────────────────────────────────────────────────────────

const generateBodySchema = z.object({
  question: z.string().trim().min(1),
  selectedChatModel: z.string().optional(),
  source: z.enum(['chat', 'canvas']).default('canvas'),
  chatId: z.string().uuid().optional(),
})

flowGeneratorRoutes.post('/generate', async (c) => {
  const parsed = generateBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return fail(c, 400, 'invalid generate request body', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    })
  }
  const { question, selectedChatModel, source, chatId } = parsed.data

  const result = await generateFlow({ userDesc: question, source, chatId, selectedChatModel })

  if (result.status === 'success') {
    return ok(c, {
      flowData: result.flowData,
      warnings: result.warnings,
      droppedNodes: result.droppedNodes,
      engine: result.engineUsed,
      repairRounds: result.repairRounds,
      attemptId: result.attemptId,
    })
  }
  if (result.stage === 'validation') {
    return fail(c, 422, result.error, {
      stage: result.stage,
      validationErrors: result.validationErrors,
      engine: result.engineUsed,
      repairRounds: result.repairRounds,
    })
  }
  return fail(c, 502, `工作流生成失败: ${result.error}`, {
    stage: result.stage,
    engine: result.engineUsed,
  })
})
