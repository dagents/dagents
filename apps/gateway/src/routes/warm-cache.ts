/**
 * warm-cache —— R2 暖缓存种子组装（design-recover §3.7(b)）。
 *
 * 「暖缓存重跑」= 修了某个节点的 prompt 后重跑：未受影响的前缀子图直接
 * 复用前驱输出（零 CLI/LLM 调用），受影响子图全量重跑。查找域 = 沿
 * `runs.resumed_from_run_id` 谱系链溯源至根（暖缓存 run 自身写谱系指向被
 * 重跑 run，R2.1 定稿）——链上任何前驱的 `(nodeId, inputHash)` decision
 * 都是候选，取**链上最近**命中（PRD R2.1）。
 *
 * 匹配算法（拓扑序一次遍历，纯函数内核 `planWarmCacheSeeds` 可单测）：
 *  - 维护「一致世界线」的假定输出集：命中节点 = 前驱旧输出（旧输入 →
 *    旧输出），miss 节点 = 无输出；
 *  - 逐节点（拓扑序）用引擎同源的 mergeInputs/shouldExecuteEdge/
 *    mergedNodeInputs/previewResolved（从 @dagents/workflow 导出的单源）
 *    预演 resolved 输入 → computeInputHash（AD-R3 单源）→ 链上查
 *    `payload.inputHash` 精确匹配；
 *  - **保守传递闭包**（R2.2）：hash 口径含上游输出（nodeInput 原样）——
 *    上游 miss/重跑后输出变 → 下游 hash 必不匹配 → 强制重跑。无需独立
 *    闭包算法，miss 即断链（下游全 miss）。
 *
 * 诚实 miss（R2.6）：链断（前驱被 retention 清掉）→ 该前驱不进候选；
 *  全链 miss → 零种子全量执行，不报错。
 *
 * 迭代控制器：v1 按 ordinal=0 口径参与匹配——控制器 miss 则 body 输出全
 * 无（body 全 miss）；控制器命中也不承诺 body 的 per-ordinal 命中（项内
 * 输入依赖每项 item，预演不构造），保守重跑。行为不劣于「全新重跑」。
 */
import {
  type FlowData,
  type FlowEdge,
  type FlowNode,
  type ResumeOptions,
  type ITokenUsage,
  computeInputHash,
  mergeInputs,
  shouldExecuteEdge,
  mergedNodeInputs,
  previewResolved,
} from '@dagents/workflow'
import { createLogger } from '@dagents/shared'
import { runLineageChain } from '../lineage.js'
import { findLatestDecisionByNodeAndHash } from '../repositories/run-node-journal.repo.js'

const log = createLogger({ svc: 'gateway:warm-cache' })

/** 拓扑排序（Kahn；与 executor 同算法的 gateway 侧只读版本，环图返回 null）。 */
function topoSort(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] | null {
  const inDegree = new Map<string, number>()
  const nodeById = new Map<string, FlowNode>()
  for (const n of nodes) {
    nodeById.set(n.id, n)
    inDegree.set(n.id, 0)
  }
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const order: FlowNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodeById.get(id)
    if (node) order.push(node)
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order.length === nodes.length ? order : null
}

/** 链上候选查询谓词（注入：repo 读侧单点；纯函数内核不碰 DB）。
 *  tokens = 前驱 decision 的 token 用量（PRD R2.3：cached span 记继承值）。
 *  类型与引擎 ResumeOptions.seedTokens 同口径（Record<string, ITokenUsage
 *  | null>）——jsonb 边界的形状断言由调用方（buildWarmCacheSeed 的
 *  lookup lambda）承担，与 journal-writer.ts:334 同款先例。 */
export type WarmCacheLookup = (
  nodeId: string,
  inputHash: string,
) => Promise<{ output?: Record<string, unknown>; tokens?: ITokenUsage | null } | null>

/**
 * 暖缓存匹配的纯函数内核：给定 flow + 链上候选查询谓词 + 本次 run 输入，
 * 拓扑序预演并产出 seedOutputs。命中节点照引擎 runtime merge 语义补假定
 * state（下游模板解析用）；miss 节点不进 state（下游 hash 自然漂移）。
 * 传递闭包专项单测锚点：改第 3 节点 prompt → 1-2 命中、3-N 全 miss。
 */
export async function planWarmCacheSeeds(input: {
  flowData: FlowData
  startInput: unknown
  chatId: string
  lookup: WarmCacheLookup
}): Promise<{
  seedOutputs: Record<string, Record<string, unknown>>
  /** 命中节点的前驱 token 用量（R2.3 继承侧）。 */
  seedTokens: Record<string, ITokenUsage | null>
}> {
  const { flowData, startInput, chatId, lookup } = input
  const order = topoSort(flowData.nodes, flowData.edges)
  if (!order) return { seedOutputs: {}, seedTokens: {} }
  const nodeById = new Map(order.map((n) => [n.id, n]))
  const incoming = new Map<string, FlowEdge[]>()
  for (const e of flowData.edges) {
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e])
  }

  // 假定世界线：命中的前驱输出（含引擎 state 展平语义）。
  const assumedOutputs = new Map<string, Record<string, unknown>>()
  const assumedState: Record<string, unknown> = {
    flow: { chatId, sessionId: undefined },
  }
  const seedOutputs: Record<string, Record<string, unknown>> = {}
  const seedTokens: Record<string, ITokenUsage | null> = {}

  for (const node of order) {
    const edges = (incoming.get(node.id) ?? []).filter((e) => e.source !== node.id)
    const isStart = edges.length === 0
    // 活动边：源输出在假定世界线里存在且分支语义命中（与 runWaves 同源）。
    const active = edges.filter((e) => {
      const out = assumedOutputs.get(e.source)
      if (!out) return false
      return shouldExecuteEdge(e, out, nodeById.get(e.source))
    })
    // miss 判定（保守断链）：任一入边源 miss / 被分支剪枝 → 下游状态与
    // 前驱世界线不可比 → 不做候选（nodeInput 无从预演）。
    if (!isStart && active.length !== edges.length) continue

    const nodeInput = isStart
      ? startInput
      : mergeInputs(active, assumedOutputs)

    // AD-R3 口径 hash（computeInputHash 单源；配置预演用假定 state——
    // 与引擎 nodeInputHash 的 ctx.runtime.state 同一展平语义）。
    const hash = computeInputHash({
      nodeType: String(node.data?.name ?? ''),
      resolvedConfig: previewResolved(mergedNodeInputs(node), assumedState),
      nodeInput,
    })
    const hit = await lookup(node.id, hash).catch(() => null)
    if (!hit?.output) continue

    seedOutputs[node.id] = hit.output
    if (hit.tokens != null) seedTokens[node.id] = hit.tokens
    assumedOutputs.set(node.id, hit.output)
    // 引擎 runtime merge 语义（executor 的输出展平 + $start 别名）。
    const nodeOut = hit.output
    assumedState[node.id] = { ...nodeOut, output: nodeOut }
    if (node.data?.name === 'startAgentflow') {
      assumedState.start = { ...nodeOut, output: nodeOut }
    }
  }
  return { seedOutputs, seedTokens }
}

/**
 * 组装暖缓存种子（R2 编排面，§3.7(b)）：谱系链 → 纯函数预演 → ResumeOptions。
 * 链断/全 miss 返回 null（调用方全量执行，不报错——R2.6 诚实 miss）。
 */
export async function buildWarmCacheSeed(input: {
  warmFromRunId: string
  flowData: FlowData
  startInput: unknown
  chatId: string
}): Promise<ResumeOptions | null> {
  const chain = await runLineageChain(input.warmFromRunId).catch(() => [] as string[])
  if (chain.length === 0) return null
  // 链上最近优先（PRD R2.1）：runLineageChain 返回自根向后代，倒序即最近
  // 前驱在前。候选 = 链上全部 run（本次新 run 还没有行，不在链上）。
  const candidates = [...chain].reverse()

  const planned = await planWarmCacheSeeds({
    flowData: input.flowData,
    startInput: input.startInput,
    chatId: input.chatId,
    lookup: (nodeId, inputHash) =>
      findLatestDecisionByNodeAndHash(candidates, nodeId, inputHash).then((row) =>
        row
          ? {
              output: row.payload.output,
              // jsonb 边界形状断言：写方（journal-writer recordDecision 的
              // tokens 参数）即 ITokenUsage 序列化产物——与 journal-writer.ts
              // 读侧同款先例。
              tokens: (row.payload.tokens as ITokenUsage | undefined) ?? undefined,
            }
          : null,
      ),
  })
  const { seedOutputs, seedTokens } = planned

  if (Object.keys(seedOutputs).length === 0) {
    log.info('warm cache miss on entire lineage — full re-run', {
      warmFromRunId: input.warmFromRunId,
      lineageDepth: candidates.length,
    })
    return null
  }
  log.info('warm cache seeds built', {
    warmFromRunId: input.warmFromRunId,
    seeds: Object.keys(seedOutputs).length,
    lineageDepth: candidates.length,
  })
  return {
    seedOutputs,
    // 暖缓存不做严格校验：hash 已在匹配时用过（§3.7(b)4——seedHashes 空）。
    seedSource: { kind: 'warm-cache', fromRunId: input.warmFromRunId },
    // 继承 token（PRD R2.3）：cached span.tokens 记前驱用量。
    ...(Object.keys(seedTokens).length > 0 ? { seedTokens } : {}),
  }
}
