/**
 * FlowData 构造辅助（docs/e2e-test-plan.md §4.3）。
 *
 * 全部输出「平铺形态」——节点配置直接放 `data.<field>`，执行入口会在
 * runNode 内做 `{...flat, ...flat.inputs}` 归一化（executor.ts:171-186），
 * 平铺键即最终 inputs，画布保存的 `data.inputs.<field>` 嵌套形态由
 * WF-08 用例单独验证兼容。
 *
 * 节点分发按 `data.name`（注册名，如 `llmAgentflow`），`node.type` 引擎
 * 不读——这里统一写 'customNode' 与画布/AI 生成形态一致。
 *
 * 字段名与源码核对（2026-08-19，见各 node 文件）：
 *   llm:            model/systemPrompt/prompt/temperature（llm.node.ts:54-57）
 *   platformAgent:  agentId/systemPrompt/maxIterations 默认10（platform-agent.node.ts）
 *   directReply:    directReplyMessage ?? text ?? content（direct-reply.node.ts:37-41）
 *   customFunction: functionCode ?? code；入参 $input/$flow（custom-function.node.ts:50-62）
 *   condition:      conditions:[{comparisonOperator,valueToCompare,valueToCompareAgainst}]，OR 语义，
 *                   输出 matched:'true'|'false'（字符串）；分支边 sourceHandle 'true'/'false'
 *   conditionAgent: scenarios:[{name,description}]；输出 selected=场景名；分支边 sourceHandle=场景名
 *   tool:           toolName/toolDescription/parameters/handler(JS代码串)/toolInput
 *   humanInput:     prompt/inputType/options
 *   executeFlow:    flowId/input
 *   iteration:      items(JSON数组或其字符串)；body 边 sourceHandle 'iteration'，出口 'result'
 *   loop:           loopCount ?? maxIterations（硬上限10）；condition 为 JS 表达式；body 'loop'，出口 'result'
 *   start:          variables/input
 *   http:           method/url/headers/body/bodyType（url 必须绝对 http(s)）
 *   retriever:      query/topK
 */

export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
}

export interface FlowData {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

let positionCounter = 0
function nextPosition() {
  positionCounter += 1
  return { x: (positionCounter % 12) * 220, y: Math.floor(positionCounter / 12) * 140 }
}

/** 通用节点构造：`node('planner', NODE.platformAgent, { agentId, systemPrompt })` */
export function node(id: string, name: string, data: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: 'customNode',
    position: nextPosition(),
    data: { name, label: data.label ?? id, ...data },
  }
}

/** 边构造；sourceHandle 缺省 = 主输出。id 缺省自动生成。 */
export function edge(
  source: string,
  target: string,
  sourceHandle?: string,
  id?: string,
): FlowEdge {
  return {
    id: id ?? `${source}-${sourceHandle ? sourceHandle + '-' : ''}${target}`,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  }
}

/** 节点注册名（allNodes() 的 name 字段，executor 按 data.name 分发）。 */
export const NODE = {
  start: 'startAgentflow',
  llm: 'llmAgentflow',
  agent: 'agentAgentflow',
  platformAgent: 'platformAgentAgentflow',
  directReply: 'directReplyAgentflow',
  customFunction: 'customFunctionAgentflow',
  condition: 'conditionAgentflow',
  conditionAgent: 'conditionAgentAgentflow',
  tool: 'toolAgentflow',
  humanInput: 'humanInputAgentflow',
  executeFlow: 'executeFlowAgentflow',
  iteration: 'iterationAgentflow',
  loop: 'loopAgentflow',
  http: 'httpAgentflow',
  retriever: 'retrieverAgentflow',
} as const

/** 条件分支的 sourceHandle 取值（condition.node 输出 matched 为字符串）。 */
export const BRANCH = { true: 'true', false: 'false' } as const
/** 循环控制器锚点：body 边 / 出口边。 */
export const LOOP = { body: 'loop', iteration: 'iteration', result: 'result' } as const

// ── 常用节点快捷构造 ─────────────────────────────────────────────────────

export const startNode = (id = 'start', data: { input?: string; variables?: Record<string, unknown> } = {}) =>
  node(id, NODE.start, data as Record<string, unknown>)

export const llmNode = (
  id: string,
  data: { model?: string; systemPrompt?: string; prompt?: string; temperature?: number },
) => node(id, NODE.llm, data as Record<string, unknown>)

export const platformAgentNode = (
  id: string,
  data: { agentId: string; systemPrompt?: string; maxIterations?: number },
) => node(id, NODE.platformAgent, data as Record<string, unknown>)

export const directReplyNode = (id: string, data: { text: string }) =>
  node(id, NODE.directReply, { directReplyMessage: data.text } as Record<string, unknown>)

export const customFunctionNode = (
  id: string,
  data: { code: string; input?: unknown },
) => node(id, NODE.customFunction, { functionCode: data.code, ...(data.input !== undefined ? { functionInput: data.input } : {}) })

export const conditionNode = (
  id: string,
  data: {
    conditions: Array<{
      comparisonOperator: '===' | '!==' | '>' | '<' | '>=' | '<=' | 'contains' | 'startsWith' | 'endsWith'
      valueToCompare: unknown
      valueToCompareAgainst: unknown
    }>
  },
) => node(id, NODE.condition, data as Record<string, unknown>)

export const conditionAgentNode = (
  id: string,
  data: { scenarios: Array<{ name: string; description: string }>; model?: string; systemPrompt?: string },
) => node(id, NODE.conditionAgent, data as Record<string, unknown>)

export const toolNode = (
  id: string,
  data: {
    toolName: string
    toolDescription?: string
    parameters?: Record<string, unknown>
    handler: string
    toolInput?: unknown
  },
) => node(id, NODE.tool, data as Record<string, unknown>)

export const humanInputNode = (
  id: string,
  data: { prompt: string; inputType?: 'text' | 'select' | 'confirm'; options?: unknown[] },
) => node(id, NODE.humanInput, data as Record<string, unknown>)

export const executeFlowNode = (
  id: string,
  data: { flowId: string; input?: unknown },
) => node(id, NODE.executeFlow, data as Record<string, unknown>)

export const iterationNode = (id: string, data: { items: unknown[] }) =>
  node(id, NODE.iteration, { items: JSON.stringify(data.items) })

export const loopNode = (
  id: string,
  data: { maxIterations?: number; loopCount?: number; condition?: string },
) => node(id, NODE.loop, data as Record<string, unknown>)

export const httpNode = (
  id: string,
  data: { url: string; method?: string; headers?: Record<string, string> | string; body?: string },
) => node(id, NODE.http, data as Record<string, unknown>)

export const retrieverNode = (id: string, data: { query?: string; topK?: number } = {}) =>
  node(id, NODE.retriever, data as Record<string, unknown>)

// ── 组合子 ───────────────────────────────────────────────────────────────

export function flow(nodes: FlowNode[], edges: FlowEdge[]): FlowData {
  return { nodes, edges }
}

/** 线性链 start → n1 → n2 → …（nodes 不含 start 时自动补一个）。 */
export function linearFlow(nodes: FlowNode[], opts: { startInput?: string } = {}): FlowData {
  const all = nodes[0]?.data.name === NODE.start ? nodes : [startNode('start', { input: opts.startInput }), ...nodes]
  const edges: FlowEdge[] = []
  for (let i = 0; i < all.length - 1; i++) edges.push(edge(all[i].id, all[i + 1].id))
  return flow(all, edges)
}

/**
 * 并行扇出：start → ∥branches（每支是节点数组，支内线性）→ 汇聚到 sink。
 * sink 缺省时分支各自收尾（finalOutput 取拓扑最深已执行节点）。
 */
export function parallelFlow(
  branches: FlowNode[][],
  sink?: FlowNode,
  opts: { startInput?: string } = {},
): FlowData {
  const start = startNode('start', { input: opts.startInput })
  const nodes = [start, ...branches.flat()]
  if (sink) nodes.push(sink)
  const edges: FlowEdge[] = []
  for (const branch of branches) {
    if (branch.length === 0) continue
    edges.push(edge(start.id, branch[0].id))
    for (let i = 0; i < branch.length - 1; i++) edges.push(edge(branch[i].id, branch[i + 1].id))
    if (sink) edges.push(edge(branch[branch.length - 1].id, sink.id))
  }
  return flow(nodes, edges)
}
