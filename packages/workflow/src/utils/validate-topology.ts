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

export interface TopologyError {
  /** Offending node id, when the error is node-scoped. */
  node?: string
  /** Offending edge id, when the error is edge-scoped. */
  edge?: string
  message: string
}

export interface TopologyWarning {
  /** Offending node id, when the warning is node-scoped. */
  node?: string
  message: string
}

export type TopologyResult =
  | { ok: true; data: FlowData; warnings: TopologyWarning[] }
  | { ok: false; errors: TopologyError[]; warnings: TopologyWarning[] }

/**
 * Node type names the executor can dispatch to. Derived from the same list
 * the gateway assembles its NodeRegistry from, so registering a new node type
 * makes it valid here automatically — no parallel whitelist to keep in sync.
 */
const KNOWN_NODE_TYPES = new Set(allNodes().map((node) => node.name))

const START_TYPE = 'startAgentflow'
const PLATFORM_AGENT_TYPE = 'platformAgentAgentflow'

/**
 * Resolve a node's engine type name. Flows in the wild store it in one of two
 * places: canvas-saved / gateway-generated nodes carry the registry name in
 * `data.name` (with `type` holding a React Flow render type like
 * 'agentflowNode'), while console AI-generated flows put the registry name in
 * `type` with flat `data`. `data.name` wins when both exist because that is
 * what the executor dispatches on.
 */
function resolveNodeType(node: FlowNode): string | undefined {
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
    } else if (!KNOWN_NODE_TYPES.has(type)) {
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

  // A Platform Agent node without an agentId throws at run time; it stays a
  // warning (not an error) so an in-progress draft still validates for its
  // other structure.
  for (const node of flow.nodes) {
    if (resolveNodeType(node) !== PLATFORM_AGENT_TYPE) continue
    const agentId = resolveAgentId(node)
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      warnings.push({
        node: node.id,
        message: `platform agent node "${node.id}" has no agentId — it will fail when executed`,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, data: flow, warnings }
}
