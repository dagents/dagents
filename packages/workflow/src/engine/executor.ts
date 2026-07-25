import type { FlowData, FlowNode } from '../types/flow.js'
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
 * DAG executor — topological sort + linear execution.
 *
 * Plan A scope: linear DAGs only. No branching (Condition/ConditionAgent)
 * or looping (Iteration/Loop) — those are Plan B. If the graph contains
 * a branch or loop, this executor will execute nodes in topological order
 * but won't skip branches or repeat loops — the results will be incorrect
 * for non-linear graphs. Plan B replaces this with the full executor.
 *
 * Algorithm:
 *   1. Build adjacency list from edges
 *   2. Topological sort (Kahn's algorithm)
 *   3. Execute nodes in topo order, passing each node's output to its successors
 *   4. The last node in topo order gets `isLastNode: true` for SSE streaming
 */
export class DagExecutor {
  constructor(private readonly registry: NodeRegistry) {}

  async execute(flow: FlowData, input: unknown, opts: ExecuteOptions): Promise<ExecutionResult> {
    const runtime = new RuntimeState()
    runtime.merge(opts.state)

    const executedNodes: IExecutedNode[] = []

    try {
      // 1. Topological sort
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

      // 2. Execute nodes in topo order
      let lastOutput: Record<string, unknown> = {}
      // Input to pass to the next node. Starts as the original flow input;
      // updated each iteration to the previous node's output (content string
      // when available — Flowise convention — otherwise the whole output object).
      let nextInput: unknown = input
      for (let i = 0; i < order.length; i++) {
        const flowNode = order[i]
        const isLast = i === order.length - 1

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

        const nodeData: INodeData = {
          id: flowNode.id,
          name: flowNode.data.name as string,
          inputs: flowNode.data,
        }

        const ctx: IExecutionContext = {
          chatId: opts.chatId,
          runId: opts.runId,
          state: runtime.state,
          isLastNode: isLast && opts.isLastNode,
          sseStreamer: opts.sseStreamer,
          startInput: opts.startInput,
          sessionId: opts.sessionId,
          signal: opts.signal,
          agentflowRuntime: { state: runtime.state },
        }

        const startedAt = new Date().toISOString()
        let output: INodeOutput
        try {
          output = await nodeInstance.run(nodeData, nextInput, ctx)
        } catch (err) {
          const endedAt = new Date().toISOString()
          executedNodes.push({
            nodeId: flowNode.id,
            nodeName: flowNode.data.name as string,
            startedAt,
            endedAt,
            status: 'failed',
            input: lastOutput,
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

        // Merge state from node output
        runtime.merge(output.state)

        // Store output for the next node
        lastOutput = output.output

        // Flowise convention: a node's `output.content` string flows as the
        // next node's input. Falls back to the whole output object for nodes
        // that don't produce a content string.
        const content = output.output.content
        nextInput = typeof content === 'string' ? content : output.output
      }

      return {
        status: 'success',
        executedNodes,
        finalOutput: lastOutput,
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
   * Topological sort using Kahn's algorithm.
   * Returns `{ kind: 'ok', order }` on success or `{ kind: 'cycle', cycle }` on cycle.
   */
  private topologicalSort(
    nodes: FlowNode[],
    edges: { source: string; target: string }[],
  ): { kind: 'ok'; order: FlowNode[] } | { kind: 'cycle'; cycle: string[] } {
    // Build adjacency list + in-degree map
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

    // Start with nodes that have no incoming edges
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

    // If not all nodes are in order, there's a cycle
    if (order.length !== nodes.length) {
      const remaining = nodes.filter((n) => !order.includes(n)).map((n) => n.id)
      return { kind: 'cycle', cycle: remaining }
    }

    return { kind: 'ok', order }
  }
}
