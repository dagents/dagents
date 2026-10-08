/**
 * Flow topology validator — structural checks that run before execution.
 *
 * AD-2 single validation source: the gateway save/generate/template entries
 * and the console canvas warning bar all call this instead of re-declaring
 * their own rules. Two layers:
 *   1. Shape — reuse flowDataSchema so defaults (edge id synthesis, empty
 *      nodes/edges arrays) apply before topology sees the graph.
 *   2. Topology — start node presence/uniqueness, edge endpoints resolve to
 *      real nodes, node types the engine can dispatch to.
 *
 * Errors mean "cannot execute"; warnings mean "executable but suspicious".
 */

import { flowDataSchema } from './flow-data.js'
import { allNodes } from '../nodes/index.js'
import type { FlowData, FlowNode } from '../types/flow.js'
// R4 权限声明规则（与 flow-permissions 互为循环引用，函数级调用安全）
import { validatePermissionDeclarations } from './flow-permissions.js'

export interface TopologyError {
  /** Offending node id, when the error is node-scoped. */
  node?: string
  /** Offending edge id, when the error is edge-scoped. */
  edge?: string
  message: string
  /**
   * 诊断分级（2026-10-07 R9c，design-sharp §2.3）：缺省 = 'error'（不可执行，
   * 存量消费方零破坏）；'repairable' = 可修复——运行必失败但可按 `repair`
   * 指引修复，**不改变 ok 判定**（不阻断保存）。
   */
  severity?: 'error' | 'repairable'
  /** 修复指引一句话（severity='repairable' 时必带）。 */
  repair?: string
}

export interface TopologyWarning {
  /** Offending node id, when the warning is node-scoped. */
  node?: string
  message: string
}

/**
 * 校验结果。`ok` 只回答「有没有 error 档诊断」（可执行判决）；repairable
 * 诊断不改变 ok 性——这是「不阻断保存」的类型层表达：
 *  - ok:false 时 `errors` 可含 severity 混合（repairable 与 error 同数组
 *    全量返回，绝不互斥遮蔽，AC-R9-4 前半）；
 *  - ok:true 时 `errors` 只含 repairable 条目（可能为空数组）。
 */
export type TopologyResult =
  | { ok: true; data: FlowData; warnings: TopologyWarning[]; errors: TopologyError[] }
  | { ok: false; errors: TopologyError[]; warnings: TopologyWarning[] }

/**
 * Node type names the executor can dispatch to. Derived from the same list
 * the gateway assembles its NodeRegistry from, so registering a new node type
 * makes it valid here automatically — no parallel whitelist to keep in sync.
 *
 * 惰性求值（2026-10-07 环修复）：R4 的 flow-permissions 与本模块互相引用，
 * 而 nodes/index → http.node → flow-permissions → 本模块 → nodes/index 的
 * 三方环会让本模块顶层求值时 allNodes 尚未初始化（executor.test 实弹）。
 * 首次调用时求值 + 缓存，语义与单源不变。
 */
let knownNodeTypesCache: Set<string> | null = null
function knownNodeTypes(): Set<string> {
  if (knownNodeTypesCache === null) {
    knownNodeTypesCache = new Set(allNodes().map((node) => node.name))
  }
  return knownNodeTypesCache
}

const START_TYPE = 'startAgentflow'
const PLATFORM_AGENT_TYPE = 'platformAgentAgentflow'

/**
 * Resolve a node's engine type name. Flows in the wild store it in one of two
 * places: canvas-saved / gateway-generated nodes carry the registry name in
 * `data.name` (with `type` holding a React Flow render type like
 * 'agentflowNode'), while console AI-generated flows put the registry name in
 * `type` with flat `data`. `data.name` wins when both exist because that is
 * what the executor dispatches on.
 *
 * Exported since 2026-09-22: the gateway span-writer resolves nodeType from
 * the same rule (single source of truth) — previously it wrote the canvas
 * render type ('customNode'), so the console terminal `$` hint line degraded
 * to a meaningless "$ customNode" for canvas-saved flows.
 */
export function resolveNodeType(node: FlowNode): string | undefined {
  const fromData = node.data?.name
  if (typeof fromData === 'string' && fromData.length > 0) return fromData
  if (typeof node.type === 'string' && node.type.length > 0) return node.type
  return undefined
}

/**
 * Effective Platform Agent agentId — flat `data.agentId` (AI-generated shape)
 * or canvas-nested `data.inputs.agentId`. The executor merges both into one
 * inputs object with nested taking precedence, so mirror that order.
 */
function resolveAgentId(node: FlowNode): unknown {
  const inputs = node.data?.inputs
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const nested = (inputs as Record<string, unknown>).agentId
    if (nested !== undefined) return nested
  }
  return node.data?.agentId
}

/**
 * Map zod shape failures to topology errors. Best-effort attaches the
 * offending node/edge id read from the raw input so callers can highlight
 * the element on the canvas — the parsed output doesn't exist on failure.
 */
function shapeErrors(
  raw: unknown,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): TopologyError[] {
  const container = (raw ?? {}) as { nodes?: unknown; edges?: unknown }
  return issues.map((issue) => {
    const [scope, index] = issue.path
    const error: TopologyError = { message: `invalid flow data: ${issue.message}` }
    if ((scope === 'nodes' || scope === 'edges') && typeof index === 'number') {
      const list = scope === 'nodes' ? container.nodes : container.edges
      if (Array.isArray(list)) {
        const item = list[index]
        const id = (item as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') error[scope === 'nodes' ? 'node' : 'edge'] = id
      }
    }
    return error
  })
}

/**
 * Cycle check helper — Kahn's algorithm over the edge set. Returns one
 * concrete cycle path (first closed walk in the residual subgraph) or null
 * when acyclic. Edges referencing missing nodes are skipped — those error
 * separately in the edge check.
 *
 * The residual set (positive in-degree after Kahn) can still carry tail
 * nodes downstream of a cycle that never reach zero — pruning them first
 * (iteratively drop residual nodes with no residual out-edge) leaves a set
 * where every node has a residual successor, so the walk below always
 * closes on a true cycle.
 */
function detectCycle(nodes: FlowNode[], edges: FlowData['edges']): string[] | null {
  const ids = new Set(nodes.map((n) => n.id))
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    adjacency.get(e.source)!.push(e.target)
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adjacency.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  const residualIds = [...indegree].filter(([, d]) => d > 0).map(([id]) => id)
  if (residualIds.length === 0) return null
  let residual = new Set(residualIds)
  // 剪枝尾巴：环外下游节点留在残余集但无残余出边（如环 a→b 上的 b 挂
  // b→c 尾巴），游走踏入即死路。反复滤除无残余后继者至收敛——此后集内
  // 每个节点都有集内后继，游走必闭合且必为真环。
  let core = residualIds
  for (;;) {
    const pruned = core.filter((id) =>
      (adjacency.get(id) ?? []).some((n) => residual.has(n)),
    )
    if (pruned.length === core.length) break
    core = pruned
    residual = new Set(core)
  }
  if (core.length === 0) return residualIds // defensive: report the unpruned set
  const seen = new Map<string, number>()
  const path: string[] = []
  let cur = core[0]!
  while (!seen.has(cur)) {
    seen.set(cur, path.length)
    path.push(cur)
    cur = (adjacency.get(cur) ?? []).find((n) => residual.has(n))!
  }
  // 闭合节点重复一次收尾（a → b → a / 自环 a → a），与引擎报错同格式
  const cycle = path.slice(seen.get(cur)!)
  cycle.push(cycle[0]!)
  return cycle
}

/**
 * Validate a flow definition (the parsed `flowData` object, not its JSON
 * string) for executability. Always returns; never throws. Warnings are
 * collected even when errors are present so a save-entry can show everything
 * wrong in one pass.
 */
export function validateFlowTopology(data: unknown): TopologyResult {
  const warnings: TopologyWarning[] = []

  const parsed = flowDataSchema.safeParse(data)
  if (!parsed.success) {
    return { ok: false, errors: shapeErrors(data, parsed.error.issues), warnings }
  }
  const flow = parsed.data

  const errors: TopologyError[] = []
  if (flow.nodes.length === 0) {
    errors.push({ message: 'flow has no nodes' })
    return { ok: false, errors, warnings }
  }

  const nodeIds = new Set(flow.nodes.map((node) => node.id))

  const startIds: string[] = []
  for (const node of flow.nodes) {
    const type = resolveNodeType(node)
    if (type === START_TYPE) {
      startIds.push(node.id)
    } else if (!type) {
      errors.push({
        node: node.id,
        message: `node "${node.id}" has no type (expected a registry name in data.name or type)`,
      })
    } else if (!knownNodeTypes().has(type)) {
      errors.push({ node: node.id, message: `unknown node type "${type}"` })
    }
  }
  if (startIds.length === 0) {
    errors.push({ message: `flow has no ${START_TYPE} node — there is no entry point to execute from` })
  } else if (startIds.length > 1) {
    errors.push({ message: `multiple ${START_TYPE} nodes: ${startIds.join(', ')}` })
  }

  for (const edge of flow.edges) {
    const missing = [edge.source, edge.target].filter((id) => !nodeIds.has(id))
    if (missing.length > 0) {
      errors.push({ edge: edge.id, message: `edge references missing node(s): ${missing.join(', ')}` })
    }
  }

  // Orphan check — a node in no edge is unreachable (or leads nowhere) and is
  // silently skipped by the executor. A sole-node flow is a legitimate draft,
  // and start nodes are conventionally allowed to sit unconnected, so neither
  // warns.
  if (flow.nodes.length > 1) {
    const connected = new Set<string>()
    for (const edge of flow.edges) {
      connected.add(edge.source)
      connected.add(edge.target)
    }
    for (const node of flow.nodes) {
      if (connected.has(node.id)) continue
      if (resolveNodeType(node) === START_TYPE) continue
      warnings.push({
        node: node.id,
        message: `node "${node.id}" is not connected to any edge and will not execute`,
      })
    }
  }

  // A Platform Agent node without an agentId throws at run time — it is a
  // *repairable* diagnostic (2026-10-07 R9c 从 warning 升档)：运行必失败但可
  // 一键修复（Inspector 选 Agent），warning（可疑）低估「必失败」、error
  // （不可执行）又会阻断草稿保存——repairable 正好。
  for (const node of flow.nodes) {
    if (resolveNodeType(node) !== PLATFORM_AGENT_TYPE) continue
    const agentId = resolveAgentId(node)
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      errors.push({
        node: node.id,
        message: `platform agent node "${node.id}" has no agentId — it will fail when executed`,
        severity: 'repairable',
        repair: '在右侧 Inspector 为该节点选择一个 Agent',
      })
    }
  }

  // 模板占位符引用未知名（2026-10-07 R9c 新规则，repairable）：扫描全部节点
  // 的字符串字段中 {{…}} 引用，引用根（剥 `{{id.field}}` 的 id 段与 $ 前缀）
  // ∉ {节点 id 集} ∪ KNOWN_TEMPLATE_ROOTS → 可修复提示（拼写错误或上游缺
  // 节点）。已知误报面（诚实标注）：正文字面量 {{…}} 会误报——与引擎运行时
  // 同款启发式（llm.node.ts 只计数不判失败），静态同样只报 repairable 不报
  // error；R10 试运行的 unresolvedPlaceholders 是同一口径的动态实证层。
  for (const node of flow.nodes) {
    const unknown = collectUnknownTemplateRoots(node, nodeIds)
    if (unknown.size > 0) {
      errors.push({
        node: node.id,
        message:
          `node "${node.id}" references unknown template variable(s): ` +
          `${[...unknown].join(', ')} — they will stay as literal {{…}} text at run time`,
        severity: 'repairable',
        repair: `变量 ${[...unknown].join('、')} 不指向任何节点——检查拼写或补上游节点`,
      })
    }
  }

  // 权限声明规则（R4，2026-10-07）：http/customFunction 节点的
  // allowedDomains/allowedCommands 形状/条目非法 → error（非法声明不可
  // 执行，非 warning）。缺席/合法声明都通过——缺席策略由运行期网关
  // 策略（DAGENTS_HTTP_DOMAIN_POLICY）裁决，校验器不越权。单源实现在
  // flow-permissions.ts（readNodePermission 的语义阶梯）。
  errors.push(...validatePermissionDeclarations(flow))

  // Cycle check — the engine is a DAG executor (Kahn's topological sort in
  // DagExecutor.execute): a single back-edge (e.g. a condition node looping
  // to an earlier step for "repeat until" semantics) makes the run fail
  // before any node starts, with zero node spans and nothing to inspect.
  // Reject the shape at the validation gate — generation's repair loop and
  // human authors both get the offending path named.
  const cycle = detectCycle(flow.nodes, flow.edges)
  if (cycle) {
    errors.push({
      node: cycle[0],
      message:
        `cycle detected (${cycle.join(' → ')}): the engine executes DAGs only — edges ` +
        `must never point back to an earlier node; express repetition with an ` +
        `iterationAgentflow node over a bounded list, or let the agent iterate ` +
        `internally per its systemPrompt`,
    })
  }

  // ok 判决只看 error 档（R9c）：repairable 单独存在时 ok:true 且随行携带
  // （保存不阻断）；error 档存在时 ok:false，errors 全量返回（混合不被遮蔽）。
  if (errors.some((e) => (e.severity ?? 'error') === 'error')) {
    return { ok: false, errors, warnings }
  }
  return { ok: true, data: flow, warnings, errors }
}

/**
 * 模板变量静态扫描的引擎已知根键（非节点 id 的合法 {{…}} 引用）——与
 * variables.ts 的运行时注册面同源：start（$start 别名 + Start 输出注册键）、
 * flow（$flow.chatId/sessionId、flow.state.* 展开到平铺 state）、迭代元数据
 * 四键、humanInputs（seedRuntime 预供答案）。
 */
const KNOWN_TEMPLATE_ROOTS = new Set([
  'start',
  'flow',
  'iterationItem',
  'iterationIndex',
  'iterationCount',
  'iteration',
  'humanInputs',
])

/**
 * 收集一个节点的字符串字段里引用了未知根的 {{…}} 变量名（去重）。
 * 深走 node.data（平铺 + 嵌套 inputs 一并覆盖——两形态的字段都可能带
 * acceptVariable）；`{{$start.input}}` 的 $ 前缀剥除后按同表判定。
 */
function collectUnknownTemplateRoots(node: FlowNode, nodeIds: Set<string>): Set<string> {
  const unknown = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const mt of value.matchAll(/\{\{([^}]+)\}\}/g)) {
        const path = mt[1].trim()
        if (path.length === 0) continue
        const root = (path.startsWith('$') ? path.slice(1) : path).split('.')[0]
        if (root.length === 0) continue
        if (nodeIds.has(root) || KNOWN_TEMPLATE_ROOTS.has(root)) continue
        unknown.add(root)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(node.data)
  return unknown
}
