/**
 * 读写规范化（纯函数，golden 测试钉住往返语义）。
 *
 * 读（normalizeDocument）：宽容接收三类真实来源形状 ——
 *  1. 生成器/内置模板/团队模板：type 'customNode' + data.name + 扁平字段
 *  2. vendor 画布保存：type 'agentflowNode'|'iteration' + data.inputs 嵌套 +
 *     outputAnchors/version/hideInput 杂项 + targetHandle=<nodeId> 约定
 *  3. 手写 JSON / 已删类型的存量测试 flow：任意形状，未知名渲染占位卡
 *
 * 写（serializeDocument）：统一扁平规范形 —— { id, type:'customNode', position,
 * data:{ name, label, ...fields } }；legacy inputs/outputAnchors/version 在
 * 下一次保存时自然收敛。
 */

import type { FlowData } from '@dagents/workflow'
import { getNodeMeta } from '@dagents/workflow'
import {
  DEFAULT_OUTPUT_ID,
  INPUT_HANDLE_ID,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type FlowNodeData,
} from './flow-document'

/** vendor 时代写进 data 的杂项键 —— 读入丢弃、写出不再生成。 */
const LEGACY_DATA_KEYS = new Set(['outputAnchors', 'version', 'hideInput'])

/** 运行态/校验态的易变键 —— 只活在内存，绝不落库。 */
const VOLATILE_DATA_KEYS = new Set(['status', 'error', 'validationErrors'])

const STICKY_TYPES = new Set(['stickyNote', 'stickyNoteAgentflow'])

function resolveNodeName(raw: {
  type?: string
  data?: Record<string, unknown>
}): string {
  const byData = typeof raw.data?.name === 'string' ? (raw.data.name as string) : ''
  if (byData) return byData
  // 旧 vendor 形态把注册名放在 node.type 上（引擎 resolveNodeType 同款回退）
  const byType = raw.type ?? ''
  return byType.endsWith('Agentflow') ? byType : ''
}

function outputAnchorsOf(name: string): string[] {
  const meta = getNodeMeta(name)
  const outs = meta?.outputs?.map((o) => o.name)
  return outs && outs.length > 0 ? outs : [DEFAULT_OUTPUT_ID]
}

/** 出句柄 id（渲染与补缺共用）：未知节点退化为单一默认锚点。 */
export function outputAnchorsFor(name: string): string[] {
  return outputAnchorsOf(name)
}

function toNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function positionOf(raw: Record<string, unknown>): { x: number; y: number } {
  const p = raw.position as { x?: unknown; y?: unknown } | undefined
  return { x: toNumber(p?.x), y: toNumber(p?.y) }
}

function normalizeNode(raw: Record<string, unknown>): CanvasNode | null {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null
  const rawType = typeof raw.type === 'string' ? raw.type : ''
  const rawData = (raw.data ?? {}) as Record<string, unknown>

  if (!id) return null

  if (STICKY_TYPES.has(rawType)) {
    return {
      id,
      type: 'stickyNote',
      position: positionOf(raw),
      data: {
        text:
          (typeof rawData.text === 'string' && rawData.text) ||
          (typeof rawData.content === 'string' && rawData.content) ||
          '',
      },
      ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
      ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
    }
  }

  const name = resolveNodeName({ type: rawType, data: rawData })
  const inputs = (rawData.inputs ?? {}) as Record<string, unknown>
  // 与引擎 runNode 合并序一致：扁平先、嵌套后（嵌套覆盖）
  const merged: Record<string, unknown> = { ...rawData, ...inputs }
  const data: FlowNodeData = { name, label: '' }
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'name' || k === 'label' || k === 'inputs' || LEGACY_DATA_KEYS.has(k)) continue
    if (VOLATILE_DATA_KEYS.has(k)) continue
    if (k === 'inputHint' || k === 'inputExample') {
      if (typeof v === 'string' && v) (data as Record<string, unknown>)[k] = v
      continue
    }
    (data as Record<string, unknown>)[k] = v
  }
  const meta = getNodeMeta(name)
  data.label =
    (typeof rawData.label === 'string' && rawData.label) ||
    meta?.label ||
    (name ? name.replace(/Agentflow$/, '') : '未知节点') ||
    id

  return {
    id,
    type: 'flowNode',
    position: positionOf(raw),
    data,
  }
}

function normalizeEdge(
  raw: Record<string, unknown>,
  nodeById: Map<string, CanvasNode>,
): CanvasEdge | null {
  const source = typeof raw.source === 'string' ? raw.source : ''
  const target = typeof raw.target === 'string' ? raw.target : ''
  if (!source || !target) return null
  const id =
    typeof raw.id === 'string' && raw.id ? raw.id : `${source}-${target}`

  // sourceHandle：执行语义键 —— 有值原样保留（含 legacy 的 `${id}-output-N`，
  // 引擎有自己的回退解释）；缺值补源节点首个锚点（RF 渲染需要）。
  let sourceHandle: string | undefined =
    typeof raw.sourceHandle === 'string' && raw.sourceHandle ? raw.sourceHandle : undefined
  if (!sourceHandle) {
    const src = nodeById.get(source)
    const name = src?.type === 'flowNode' ? (src.data as FlowNodeData).name : ''
    if (name) sourceHandle = outputAnchorsOf(name)[0]
  }
  // targetHandle：无视 vendor 的 targetHandle=<nodeId> 约定，恒归一到唯一入句柄
  return {
    id,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    targetHandle: INPUT_HANDLE_ID,
  }
}

export function normalizeDocument(raw: unknown): CanvasDocument {
  const doc = (raw ?? {}) as { nodes?: unknown; edges?: unknown; viewport?: unknown }
  const rawNodes = Array.isArray(doc.nodes) ? (doc.nodes as Array<Record<string, unknown>>) : []
  const rawEdges = Array.isArray(doc.edges) ? (doc.edges as Array<Record<string, unknown>>) : []

  const nodes: CanvasNode[] = []
  const nodeById = new Map<string, CanvasNode>()
  for (const rn of rawNodes) {
    const n = normalizeNode(rn)
    if (!n) continue
    nodes.push(n)
    nodeById.set(n.id, n)
  }
  const seenEdgeIds = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const re of rawEdges) {
    const e = normalizeEdge(re, nodeById)
    // 悬空边（端点不存在）与重复 id 直接丢弃 —— 拓扑校验会在保存时再提醒
    if (!e || !nodeById.has(e.source) || !nodeById.has(e.target)) continue
    if (seenEdgeIds.has(e.id)) continue
    seenEdgeIds.add(e.id)
    edges.push(e)
  }

  const vp = doc.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined
  return {
    nodes,
    edges,
    viewport: vp
      ? { x: toNumber(vp.x), y: toNumber(vp.y), zoom: toNumber(vp.zoom, 1) }
      : undefined,
  }
}

export function serializeDocument(doc: CanvasDocument): FlowData {
  const nodes = doc.nodes.map((n) => {
    if (n.type === 'stickyNote') {
      return {
        id: n.id,
        type: 'stickyNote',
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        data: { text: (n.data as { text: string }).text },
        ...(n.width ? { width: n.width } : {}),
        ...(n.height ? { height: n.height } : {}),
      }
    }
    const data = n.data as FlowNodeData
    const out: Record<string, unknown> = { name: data.name, label: data.label }
    for (const [k, v] of Object.entries(data)) {
      if (k === 'name' || k === 'label') continue
      if (VOLATILE_DATA_KEYS.has(k)) continue
      out[k] = v
    }
    return {
      id: n.id,
      type: 'customNode',
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: out,
    }
  })
  const edges = doc.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
  }))
  return {
    nodes,
    edges,
    ...(doc.viewport ? { viewport: doc.viewport } : {}),
  }
}
