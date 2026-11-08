/**
 * 画布试运行的临时图裁剪器（R10，design-sharp §3.3，设计期裁决 D5）。
 *
 * 裁决背景：不做引擎 `runWaves` scope 参数公有化（其 scope/entryEdges 承载
 * 迭代体特化语义，公有化 = 第二套调度入口），做纯函数裁剪器 + 引擎既有
 * `resume.seedRuntime` 预填外部上游输出——引擎执行核心零改动表达全部试
 * 运行语义（有意避开可恢复性方向在 executor.ts 调度区的大本营）。
 *
 * 纯函数：不触 DB、不触引擎；全图（scope=null）原样返回；选中集裁剪规则：
 *   - 保留选中节点 + **两端都在选中集内**的边（裁剪图边集 ⊆ 原图边集，
 *     原图已过环检测 → 裁剪图免检环；但调用方仍须对裁剪图跑一遍完整
 *     validateFlowTopology——防未保存草稿/手改 JSON 未过保存门的图，
 *     AC-R10-6「与保存校验同体验」）。
 *   - 选中集不含 startAgentflow 节点时**合成虚拟 start**（`__trial_start`，
 *     输出 = 试运行 input），向选中集内「无入边节点」各连一条边；选中集
 *     含 start 时用原 start（其余选中节点若无入边，runWaves 的 isStartNode
 *     判据 = 入边数为 0 即视为可执行起点，自然放行——「选中即显式执行
 *     意图」语义，文档化）。
 *   - `externalUpstreams` = 选中节点的入边 source 不在选中集内的去重
 *     source id 列表——console 据此渲染种子输入区，gateway 据此组装
 *     seedRuntime。
 */
import type { FlowData, FlowEdge, FlowNode } from '../types/flow.js'

/** 虚拟 start 节点 id（与真实节点 id 冲突时裁剪器拒绝——诚实失败）。 */
export const TRIAL_VIRTUAL_START_ID = '__trial_start'

export interface TrialSubgraph {
  /** 裁剪后的临时图（喂给引擎 + validateFlowTopology）。 */
  flowData: FlowData
  /** 外部上游节点 id（种子输入区的行来源）；全图时空数组。 */
  externalUpstreams: string[]
}

const START_TYPE = 'startAgentflow'

/**
 * 裁剪试运行子图。`scope` 为 null/空数组 = 全图原样返回。
 *
 * @param flow 原图（调用方负责先过 validateFlowTopology）
 * @param scope 选中节点 id 集（P0 单值/全图；P1 多值同函数支持）
 */
export function buildTrialSubgraph(
  flow: FlowData,
  scope: { nodeIds: string[] } | null | undefined,
): TrialSubgraph {
  const rawIds = [...new Set(scope?.nodeIds ?? [])]
  // 保留 id 守卫先于「图中存在性过滤」——否则不在图中的保留 id 会被静默
  // 滤成空选中 = 全图语义，守卫永不可达。
  if (rawIds.includes(TRIAL_VIRTUAL_START_ID)) {
    throw new Error(`试运行选中集含保留 id "${TRIAL_VIRTUAL_START_ID}"——请重命名该节点`)
  }
  const selectedIds = rawIds.filter((id) => flow.nodes.some((n) => n.id === id))
  // 全图（含显式空选中 = 全图语义）：原样返回，零外部上游。
  if (selectedIds.length === 0) {
    return { flowData: flow, externalUpstreams: [] }
  }

  const selected = new Set(selectedIds)

  // 选中节点 + 两端都在选中集内的边。
  const nodes = flow.nodes.filter((n) => selected.has(n.id))
  const edges = flow.edges.filter((e) => selected.has(e.source) && selected.has(e.target))

  // 外部上游：选中节点的入边 source 不在选中集内的去重列表（保序）。
  const externalUpstreams: string[] = []
  const seen = new Set<string>()
  for (const edge of flow.edges) {
    if (selected.has(edge.target) && !selected.has(edge.source) && !seen.has(edge.source)) {
      seen.add(edge.source)
      externalUpstreams.push(edge.source)
    }
  }

  const hasStart = nodes.some(
    (n) => (n.data?.name as string | undefined) === START_TYPE || n.type === START_TYPE,
  )
  if (hasStart) {
    // 原生 start 在选中集内：其余选中节点若无（集内）入边，引擎 isStartNode
    // 判据（入边数 0）自然放行——「选中即显式执行意图」。
    return { flowData: { ...flow, nodes, edges }, externalUpstreams }
  }

  // 合成虚拟 start：id `__trial_start`、data.name='startAgentflow'、输出 =
  // 试运行 input；向选中集内「无（集内）入边」的节点各连一条边。
  const targetWithInnerEdge = new Set(edges.map((e) => e.target))
  const entryTargets = nodes.filter((n) => !targetWithInnerEdge.has(n.id))
  if (entryTargets.length === 0) {
    // 选中集内部自成环（无入边节点不存在）——validateFlowTopology 会拒，
    // 这里不提前捏造，返回裁剪图让校验器带定位拒绝。
    return { flowData: { ...flow, nodes, edges }, externalUpstreams }
  }

  const virtualStart: FlowNode = {
    id: TRIAL_VIRTUAL_START_ID,
    position: { x: 0, y: 0 },
    type: START_TYPE,
    data: { name: START_TYPE },
  }
  const virtualEdges: FlowEdge[] = entryTargets.map((n) => ({
    id: `__trial_edge_${n.id}`,
    source: TRIAL_VIRTUAL_START_ID,
    target: n.id,
  }))

  return {
    flowData: {
      ...flow,
      nodes: [...nodes, virtualStart],
      edges: [...edges, ...virtualEdges],
    },
    externalUpstreams,
  }
}

/**
 * 外部上游种子 → 引擎 seedRuntime 形状（design-sharp §3.3 D9）：顶层键
 * 注入 `{id}` 与 `{id}.output` 双形态（对齐引擎注册约定——executor 对每个
 * 执行节点 `runtime.merge({[nodeId]: {...out, output: out}})`，模板
 * `{{upstreamId.xxx}}` 与 `{{upstreamId.output.xxx}}` 双形态可解析）。
 *
 * 注意：这是**运行时占位形状**（span-writer/live 对种子节点回放 cached
 * 语义）；试运行用 seedOutputs 空对象 + seedRuntime 预填（外部上游不在
 * 裁剪图节点集内，不能进 seedOutputs——引擎只对图内节点做种子短路）。
 */
export function buildTrialSeedRuntime(
  externalUpstreams: string[],
  seedInputs: Record<string, string>,
): Record<string, unknown> {
  const runtime: Record<string, unknown> = {}
  for (const id of externalUpstreams) {
    const content = seedInputs[id] ?? ''
    const out = { content, output: { content } }
    runtime[id] = out
  }
  return runtime
}
