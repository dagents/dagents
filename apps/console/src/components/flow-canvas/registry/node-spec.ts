/**
 * 节点规格适配层 —— `@dagents/workflow` 的 CANVAS_NODES（唯一单源）到画布
 * 消费形态的薄适配。不在 workflow 包里加任何东西；console 专属的关注点
 * （出句柄解析、分类展示）都在这层完成。
 */

import {
  CANVAS_NODES,
  NODE_CATEGORIES,
  type CanvasNodeMeta,
  type INodeParams,
} from '@dagents/workflow'
import { DEFAULT_OUTPUT_ID } from '../model/flow-document'

export interface OutputAnchorSpec {
  /** 句柄 id = 分支路由的 sourceHandle 值（执行语义）。 */
  id: string
  label: string
}

export interface NodeSpec {
  name: string
  label: string
  category: string
  categoryLabel: string
  color: string
  /** registry/icons.tsx 的图标键。 */
  icon: string
  description?: string
  inputs: INodeParams[]
  outputs: OutputAnchorSpec[]
  defaultData: Record<string, unknown>
}

export const NODE_SPECS: NodeSpec[] = CANVAS_NODES.map((meta) => toSpec(meta))

const SPEC_BY_NAME = new Map(NODE_SPECS.map((s) => [s.name, s]))

export function getSpec(name: string): NodeSpec | undefined {
  return SPEC_BY_NAME.get(name)
}

/** 出句柄锚点列表；未知节点退化为单一默认锚点（渲染占位卡用）。 */
export function anchorsOf(name: string): OutputAnchorSpec[] {
  return SPEC_BY_NAME.get(name)?.outputs ?? [{ id: DEFAULT_OUTPUT_ID, label: 'Output' }]
}

function toSpec(meta: CanvasNodeMeta): NodeSpec {
  const outputs =
    meta.outputs && meta.outputs.length > 0
      ? meta.outputs.map((o) => ({ id: o.name, label: o.label }))
      : [{ id: DEFAULT_OUTPUT_ID, label: 'Output' }]
  return {
    name: meta.name,
    label: meta.label,
    category: meta.category,
    categoryLabel: NODE_CATEGORIES[meta.category as keyof typeof NODE_CATEGORIES]?.label ?? meta.category,
    color: meta.color,
    icon: meta.icon,
    ...(meta.description ? { description: meta.description } : {}),
    inputs: meta.inputs,
    outputs,
    defaultData: meta.defaultData,
  }
}

/** 面板分组：保持注册表顺序的类目列表（空类目自动隐藏）。 */
export function specGroups(): { key: string; label: string; specs: NodeSpec[] }[] {
  const groups: { key: string; label: string; specs: NodeSpec[] }[] = []
  for (const spec of NODE_SPECS) {
    let g = groups.find((x) => x.key === spec.category)
    if (!g) {
      g = { key: spec.category, label: spec.categoryLabel, specs: [] }
      groups.push(g)
    }
    g.specs.push(spec)
  }
  return groups
}
