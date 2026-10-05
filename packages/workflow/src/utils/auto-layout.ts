/**
 * 生成流确定性自动布局（layered layout）。
 *
 * 背景：AI 生成的节点坐标不可信 —— LLM 会把分叉分支全挤在同一 y、直接
 * 叠放、或无视 prompt 里的间距要求（历史 prompt 只有一句 "~250px spacing"
 * 的软约束，而画布节点 max-width 就有 280px，遵守了也放不下）。所以生成
 * 管线（gateway flow-generator）对成功产物一律按图拓扑重排，LLM 坐标仅作
 * 占位。人工拖拽的画布不走这里 —— 布局只服务「机器生成的草稿」。
 *
 * 算法（教科书级简化 Sugiyama，无外部依赖）：
 *   1. 分层：Kahn 拓扑松弛的最长路径分层 —— 节点层 = max(前驱层) + 1，
 *      保证每条边都从左往右；环上节点（生成输入在 validate 之前可能有环）
 *      逐个追加到尾部新层，不悬挂不丢点。
 *   2. 层内排序：FIFO Kahn 的入队序（近似 BFS），兄弟节点相邻。
 *   3. 坐标：x = 层 × X_STEP；层内以 y = center + (i - (n-1)/2) × Y_STEP
 *      垂直居中，center 对齐「父节点 y 均值」—— 链保持水平直线，菱形/
 *      分叉自然张开，整层统一平移保证层内间距永不塌缩。
 *
 * 间距与画布节点尺寸耦合（apps/console/src/styles/flow-canvas.css 的
 * .fc-node：min-width 190 / max-width 280，高度约 80）—— X_STEP 360 留
 * 80px 横向空隙，Y_STEP 150 留约 70px 纵向空隙。
 */

import type { FlowData, FlowNode } from '../types/flow.js'

export interface AutoLayoutSteps {
  /** 相邻层的横向间距（px）。 */
  xStep: number
  /** 同层相邻节点的纵向间距（px）。 */
  yStep: number
}

/** 与画布 .fc-node 尺寸（190–280 宽 / ~80 高）匹配的默认步长。 */
export const DEFAULT_AUTO_LAYOUT_STEPS: AutoLayoutSteps = { xStep: 360, yStep: 150 }

/**
 * 按拓扑重排全部节点坐标，返回新 FlowData（节点浅拷贝，边原样保留）。
 * 空图原样返回。纯函数、无副作用、确定性（同输入同输出）。
 */
export function applyAutoLayout(
  flow: FlowData,
  steps: AutoLayoutSteps = DEFAULT_AUTO_LAYOUT_STEPS,
): FlowData {
  if (flow.nodes.length === 0) return flow
  const { xStep, yStep } = steps

  // ── 邻接表（去重；自环/悬空边跳过——悬空本就该被上游归一丢弃，这里再兜一层）──
  const ids = new Set(flow.nodes.map((n) => n.id))
  const succ = new Map<string, string[]>(flow.nodes.map((n) => [n.id, []]))
  const preds = new Map<string, string[]>(flow.nodes.map((n) => [n.id, []]))
  const seenEdges = new Set<string>()
  for (const e of flow.edges) {
    if (e.source === e.target) continue
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    const key = `${e.source}\u0000${e.target}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    succ.get(e.source)!.push(e.target)
    preds.get(e.target)!.push(e.source)
  }

  // ── 最长路径分层（Kahn FIFO：入队时所有前驱已出队，层已定型）──
  const indeg = new Map<string, number>(flow.nodes.map((n) => [n.id, preds.get(n.id)!.length]))
  const tentative = new Map<string, number>()
  const layers: string[][] = []
  const layerOf = new Map<string, number>()
  const bucket = (id: string, layer: number) => {
    while (layers.length <= layer) layers.push([])
    layers[layer]!.push(id)
    layerOf.set(id, layer)
  }
  const queue: string[] = []
  for (const n of flow.nodes) {
    if (indeg.get(n.id) === 0) {
      bucket(n.id, 0)
      queue.push(n.id)
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]!
    const layer = layerOf.get(id)!
    for (const t of succ.get(id)!) {
      const relaxed = layer + 1
      if ((tentative.get(t) ?? 0) < relaxed) tentative.set(t, relaxed)
      const deg = indeg.get(t)! - 1
      indeg.set(t, deg)
      if (deg === 0) {
        bucket(t, tentative.get(t) ?? 0)
        queue.push(t)
      }
    }
  }
  // 环上残余（validate 会拒，这里只保证不悬挂、不塌缩）：逐个追加到尾部新层
  for (const n of flow.nodes) {
    if (!layerOf.has(n.id)) bucket(n.id, layers.length)
  }

  // ── 坐标：层内垂直居中，层中心对齐父节点 y 均值（左往右单趟）──
  const pos = new Map<string, { x: number; y: number }>()
  layers.forEach((layer, l) => {
    const parentYs =
      l > 0
        ? layer
            .flatMap((id) => preds.get(id)!)
            .map((p) => pos.get(p)?.y)
            .filter((y): y is number => y !== undefined)
        : []
    const center = parentYs.length > 0 ? parentYs.reduce((a, b) => a + b, 0) / parentYs.length : 0
    layer.forEach((id, i) => {
      pos.set(id, {
        x: Math.round(l * xStep),
        y: Math.round(center + (i - (layer.length - 1) / 2) * yStep),
      })
    })
  })

  const nodes: FlowNode[] = flow.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }))
  return { ...flow, nodes }
}
