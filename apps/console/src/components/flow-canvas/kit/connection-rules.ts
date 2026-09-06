/**
 * 连线合法化（纯函数，单测钉住）：
 *  - 禁自环、禁重复边（同 source+sourceHandle+target）
 *  - 禁成环 —— 引擎执行模型不允许图环（循环由 Iteration 节点的专用锚点表达），
 *    连线时从 target 反向 DFS 到 source 命中即拒绝
 */

import type { Connection } from '@xyflow/react'

/** 连线判定的最小结构（兼容 RF Edge 的 null 句柄）。 */
export interface EdgeLike {
  source: string
  target: string
  sourceHandle?: string | null
}

export function wouldCreateCycle(
  edges: EdgeLike[],
  source: string,
  target: string,
): boolean {
  // 新边 source→target 成环 ⇔ 原图存在 target →…→ source 的正向路径
  //（沿正向邻接从 target 走到 source 即闭环）
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(adj.get(cur) ?? []))
  }
  return false
}

export function isDuplicateEdge(
  edges: EdgeLike[],
  source: string,
  target: string,
  sourceHandle: string | null | undefined,
): boolean {
  return edges.some(
    (e) =>
      e.source === source &&
      e.target === target &&
      (e.sourceHandle ?? undefined) === (sourceHandle ?? undefined),
  )
}

export function connectionAllowed(
  edges: EdgeLike[],
  connection: Pick<Connection, 'source' | 'target' | 'sourceHandle'>,
): boolean {
  const { source, target, sourceHandle } = connection
  if (!source || !target) return false
  if (source === target) return false
  if (isDuplicateEdge(edges, source, target, sourceHandle)) return false
  if (wouldCreateCycle(edges, source, target)) return false
  return true
}
