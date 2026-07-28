import type { FlowData, FlowEdge, FlowNode } from '../types/flow.js'
import type { INode, INodeData, INodeOutput } from '../types/node.js'
import type { IExecutionContext, IExecutedNode, ExecutionStatus } from '../types/execution.js'
import { NodeRegistry } from './node-registry.js'
import { RuntimeState } from './runtime.js'

/** Result of a DAG execution. */
export interface ExecutionResult {
  status: ExecutionStatus
  executedNodes: IExecutedNode[]
  /** The final output (last node's output), or null if execution failed. */
  finalOutput: Record<string, unknown> | null
  /** Error message if status === 'failed'. */
  error?: string
  /** Final runtime state snapshot. */
  state: Record<string, unknown>
}

/** Options passed to `DagExecutor.execute`. */
export interface ExecuteOptions {
  chatId: string
  runId: string
  state: Record<string, unknown>
  isLastNode: boolean
  sseStreamer?: import('../types/stream.js').IServerSideEventStreamer
  startInput?: string
  sessionId?: string
  signal?: AbortSignal
}

/**
 * DAG executor — topological sort + dependency-based execution with branching.
 *
 * Supports:
 * - Linear DAGs (backward compatible)
 * - Conditional branching via Condition / ConditionAgent nodes with sourceHandle
 * - Iteration / Loop nodes (handled internally by the nodes themselves)
 *
 * Branch routing:
 * - Edges with sourceHandle='true' only activate when the source node's output
 *   indicates a true/matched condition
 * - Edges with sourceHandle='false' only activate when the source node's output
 *   indicates a false/unmatched condition
 * - Edges with other sourceHandle values (e.g. scenario names) activate when
 *   the source node's `selected` or `result` field matches
 * - Edges without sourceHandle always activate
 *
 * Algorithm:
 *   1. Build adjacency list from edges
 *   2. Topological sort (Kahn's algorithm) for cycle detection and ordering
 *   3. Execute nodes in topo order, skipping nodes whose incoming edges are
 *      all inactive (pruned by conditional branches)
 *   4. For each executed node, determine which outgoing edges are active
 *   5. Merge inputs from all active incoming edges when a node has multiple
 */
export class DagExecutor {
  constructor(private readonly registry: NodeRegistry) {}

  async execute(flow: FlowData, input: unknown, opts: ExecuteOptions): Promise<ExecutionResult> {
    const runtime = new RuntimeState()
    runtime.merge(opts.state)

    const executedNodes: IExecutedNode[] = []

    try {
      const sorted = this.topologicalSort(flow.nodes, flow.edges)
      if (sorted.kind === 'cycle') {
        return {
          status: 'failed',
          executedNodes: [],
          finalOutput: null,
          error: `Cycle detected: ${sorted.cycle.join(' → ')}`,
          state: runtime.snapshot(),
        }
      }

      const order = sorted.order
      const nodeOutputs = new Map<string, Record<string, unknown>>()
      const executedNodeIds = new Set<string>()
      const incomingEdges = this.buildIncomingEdges(flow.edges)

      let lastOutput: Record<string, unknown> = {}
      let lastExecutedIndex = -1

      for (let i = 0; i < order.length; i++) {
        const flowNode = order[i]
        const nodeIncoming = incomingEdges.get(flowNode.id) ?? []
        const isStartNode = nodeIncoming.length === 0

        const activeIncoming = nodeIncoming.filter((edge) => {
          const sourceOutput = nodeOutputs.get(edge.source)
          if (!sourceOutput) {
            return false
          }
          return this.shouldExecuteEdge(edge, sourceOutput)
        })

        const shouldExecute = isStartNode || activeIncoming.length > 0

        if (!shouldExecute) {
          continue
        }

        const nodeInstance = this.registry.get(flowNode.data.name as string)
        if (!nodeInstance) {
          return {
            status: 'failed',
            executedNodes,
            finalOutput: null,
            error: `Node type "${flowNode.data.name}" not registered`,
            state: runtime.snapshot(),
          }
        }

        const nodeInput = isStartNode
          ? input
          : this.mergeInputs(activeIncoming, nodeOutputs)

        const nodeInputRecord = this.toRecord(nodeInput)

        const nodeData: INodeData = {
          id: flowNode.id,
          name: flowNode.data.name as string,
          inputs: flowNode.data,
        }

        const isLast = this.isLastExecutableNode(
          i,
          order,
          flow.edges,
          nodeOutputs,
          executedNodeIds,
          opts.isLastNode,
        )

        const ctx: IExecutionContext = {
          chatId: opts.chatId,
          runId: opts.runId,
          state: runtime.state,
          isLastNode: isLast,
          sseStreamer: opts.sseStreamer,
          startInput: opts.startInput,
          sessionId: opts.sessionId,
          signal: opts.signal,
          agentflowRuntime: { state: runtime.state },
        }

        const startedAt = new Date().toISOString()
        let output: INodeOutput
        try {
          output = await nodeInstance.run(nodeData, nodeInput, ctx)
        } catch (err) {
          const endedAt = new Date().toISOString()
          executedNodes.push({
            nodeId: flowNode.id,
            nodeName: flowNode.data.name as string,
            startedAt,
            endedAt,
            status: 'failed',
            input: nodeInputRecord,
            output: {},
            error: err instanceof Error ? err.message : String(err),
          })
          return {
            status: 'failed',
            executedNodes,
            finalOutput: null,
            error: err instanceof Error ? err.message : String(err),
            state: runtime.snapshot(),
          }
        }
        const endedAt = new Date().toISOString()

        executedNodes.push({
          nodeId: flowNode.id,
          nodeName: flowNode.data.name as string,
          startedAt,
          endedAt,
          status: 'success',
          input: output.input,
          output: output.output,
        })

        runtime.merge(output.state)
        nodeOutputs.set(flowNode.id, output.output)
        executedNodeIds.add(flowNode.id)
        lastOutput = output.output
        lastExecutedIndex = i
      }

      return {
        status: 'success',
        executedNodes,
        finalOutput: lastExecutedIndex >= 0 ? lastOutput : null,
        state: runtime.snapshot(),
      }
    } catch (err) {
      return {
        status: 'failed',
        executedNodes,
        finalOutput: null,
        error: err instanceof Error ? err.message : String(err),
        state: runtime.snapshot(),
      }
    }
  }

  /**
   * Determine whether an edge should be executed based on the source node's output.
   *
   * Rules:
   * - No sourceHandle → always active
   * - sourceHandle='true' → active when output.matched/result === 'true' or output.matched === true
   * - sourceHandle='false' → active when output.matched/result === 'false' or output.matched === false
   * - Other sourceHandle → active when output.selected or output.result matches the handle
   */
  private shouldExecuteEdge(edge: FlowEdge, nodeOutput: Record<string, unknown>): boolean {
    const handle = edge.sourceHandle
    if (!handle) {
      return true
    }

    if (handle === 'true') {
      const matched = nodeOutput.matched
      const result = nodeOutput.result
      return matched === 'true' || matched === true || result === 'true' || result === true
    }

    if (handle === 'false') {
      const matched = nodeOutput.matched
      const result = nodeOutput.result
      return matched === 'false' || matched === false || result === 'false' || result === false
    }

    const selected = nodeOutput.selected
    const result = nodeOutput.result
    return selected === handle || result === handle
  }

  /**
   * Merge inputs from multiple active incoming edges.
   *
   * - Single active input: uses Flowise convention (content string if available,
   *   otherwise the whole output object)
   * - Multiple active inputs: shallow-merges output objects. For `content`,
   *   concatenates all content strings with newlines.
   */
  private mergeInputs(
    activeEdges: FlowEdge[],
    nodeOutputs: Map<string, Record<string, unknown>>,
  ): unknown {
    if (activeEdges.length === 0) {
      return undefined
    }

    if (activeEdges.length === 1) {
      const output = nodeOutputs.get(activeEdges[0].source) ?? {}
      const content = output.content
      return typeof content === 'string' ? content : output
    }

    const merged: Record<string, unknown> = {}
    const contents: string[] = []

    for (const edge of activeEdges) {
      const output = nodeOutputs.get(edge.source) ?? {}
      Object.assign(merged, output)
      if (typeof output.content === 'string') {
        contents.push(output.content)
      }
    }

    if (contents.length > 0) {
      merged.content = contents.join('\n')
    }

    return merged
  }

  /**
   * Convert an arbitrary input value to a Record<string, unknown> for
   * consistent storage in executed node traces.
   */
  private toRecord(value: unknown): Record<string, unknown> {
    if (value == null) {
      return {}
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return { value }
  }

  /**
   * Build a map of node id → list of incoming edges.
   */
  private buildIncomingEdges(edges: FlowEdge[]): Map<string, FlowEdge[]> {
    const incoming = new Map<string, FlowEdge[]>()
    for (const edge of edges) {
      const list = incoming.get(edge.target) ?? []
      list.push(edge)
      incoming.set(edge.target, list)
    }
    return incoming
  }

  /**
   * Determine if the node at currentIndex is the last executable node.
   * A node is "last" if there are no subsequent nodes in topo order that
   * would be reachable via active edges.
   *
   * For simplicity and backward compatibility: returns true only when
   * opts.isLastNode is true AND this is the last node in topological order.
   */
  private isLastExecutableNode(
    currentIndex: number,
    order: FlowNode[],
    _edges: FlowEdge[],
    _nodeOutputs: Map<string, Record<string, unknown>>,
    _executedNodeIds: Set<string>,
    isLastNodeFlag: boolean,
  ): boolean {
    if (!isLastNodeFlag) return false
    return currentIndex === order.length - 1
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns `{ kind: 'ok', order }` on success or `{ kind: 'cycle', cycle }` on cycle.
   */
  private topologicalSort(
    nodes: FlowNode[],
    edges: FlowEdge[],
  ): { kind: 'ok'; order: FlowNode[] } | { kind: 'cycle'; cycle: string[] } {
    const adj = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    const nodeMap = new Map<string, FlowNode>()

    for (const node of nodes) {
      nodeMap.set(node.id, node)
      adj.set(node.id, [])
      inDegree.set(node.id, 0)
    }

    for (const edge of edges) {
      if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue
      adj.get(edge.source)!.push(edge.target)
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const order: FlowNode[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const node = nodeMap.get(id)
      if (node) order.push(node)

      for (const neighbor of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) queue.push(neighbor)
      }
    }

    if (order.length !== nodes.length) {
      const remaining = nodes.filter((n) => !order.includes(n)).map((n) => n.id)
      return { kind: 'cycle', cycle: remaining }
    }

    return { kind: 'ok', order }
  }
}
