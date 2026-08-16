import type { FlowData, FlowEdge, FlowNode } from '../types/flow.js'
import type { INodeData, INodeOutput } from '../types/node.js'
import type {
  IExecutionContext,
  IExecutedNode,
  ExecutionStatus,
  IAgentTool,
} from '../types/execution.js'
import { NodeRegistry } from './node-registry.js'
import { RuntimeState } from './runtime.js'

/** Result of a DAG execution. */
export interface ExecutionResult {
  status: ExecutionStatus
  executedNodes: IExecutedNode[]
  /** The final output (deepest executed node), or null if execution failed. */
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
  /** LLM client — passed through to LLM/Agent/PlatformAgent nodes. */
  llmClient?: IExecutionContext['llmClient']
  /** Platform agent fetcher — passed through to PlatformAgentNode. */
  agentFetcher?: IExecutionContext['agentFetcher']
  /** Tool registry — base tools for the run; Tool nodes add more as they execute. */
  toolRegistry?: IExecutionContext['toolRegistry']
  /** History retriever — passed through to the Retriever node. */
  historyRetriever?: IExecutionContext['historyRetriever']
  /** Human input resolver — passed through to HumanInput nodes. */
  humanInputResolver?: IExecutionContext['humanInputResolver']
  /** Flow executor — passed through to ExecuteFlow nodes (subflow execution). */
  flowExecutor?: IExecutionContext['flowExecutor']
}

/** Node type names whose loop body the executor repeats. */
const LOOP_CONTROLLER_NAMES = new Set(['loopAgentflow', 'iterationAgentflow'])

/** A loop controller's parsed execution plan (see `planLoopBody`). */
interface LoopPlan {
  kind: 'loop' | 'iteration'
  /** Body node ids — transitive closure from the body anchor, excluding the controller. */
  body: Set<string>
  /** Edges from the controller into the body entries. */
  entryEdges: FlowEdge[]
  /** Loop-only: optional early-exit condition expression. */
  condition?: string
  /** Iteration-only: the items to iterate over. */
  items: unknown[]
}

/**
 * DAG executor — dependency-based wave scheduling with branching and loops.
 *
 * Supports:
 * - Linear DAGs (backward compatible)
 * - Parallel branches: nodes whose incoming edges are all resolved form a
 *   "wave" and execute concurrently (`Promise.all`); waves advance in
 *   topological order, so `executedNodes` stays deterministic
 * - Conditional branching via Condition / ConditionAgent nodes with sourceHandle
 * - Loop / Iteration nodes: the executor detects them, extracts their loop
 *   body (the sub-DAG reachable from the `loop` / `iteration` output anchor —
 *   legacy single-anchor graphs treat every outgoing edge as body), and
 *   re-executes it once per iteration with loop metadata exposed in runtime
 *   state (`loopIndex` / `loopCount` / `iterationIndex` / `iterationItem`)
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
 *   1. Build adjacency lists from edges
 *   2. Topological sort (Kahn's algorithm) for cycle detection and ordering
 *   3. Repeat: take every node whose incoming edges are all resolved (the
 *      "wave"), execute the members concurrently, then release their outgoing
 *      edges to assemble the next wave. A node whose incoming edges resolved
 *      but none are active (and that has incoming edges at all) is skipped —
 *      skipping propagates downstream because a skipped node produces no
 *      output for its outgoing edges.
 *   4. For each executed node, merge inputs from all active incoming edges
 */
export class DagExecutor {
  constructor(private readonly registry: NodeRegistry) {}

  async execute(flow: FlowData, input: unknown, opts: ExecuteOptions): Promise<ExecutionResult> {
    const runtime = new RuntimeState()
    runtime.merge(opts.state)
    // `$flow.*` scope for template variables (chatId / sessionId). The flat
    // runtime state is NOT nested under `flow.state` — resolveVariables maps
    // that path onto the state's top level so the container stays acyclic.
    runtime.merge({ flow: { chatId: opts.chatId, sessionId: opts.sessionId } })

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
      const nodeById = new Map(order.map((n) => [n.id, n]))
      const topoIndex = new Map(order.map((n, i) => [n.id, i]))
      const nodeOutputs = new Map<string, Record<string, unknown>>()
      const incomingEdges = this.buildIncomingEdges(flow.edges)
      const outgoingEdges = this.buildOutgoingEdges(flow.edges)

      // Per-run tool registry overlay. Tool nodes register themselves into it
      // as they execute, so downstream Agent / Platform Agent nodes can call
      // them — without leaking registrations into the caller's base registry.
      const toolRegistry: Record<string, IAgentTool> = { ...(opts.toolRegistry ?? {}) }

      // Final output = the deepest (max topological index) executed node.
      let finalOutput: Record<string, unknown> | null = null
      let finalOutputIndex = -1
      const recordExecution = (nodeId: string, output: Record<string, unknown>): void => {
        const idx = topoIndex.get(nodeId) ?? -1
        if (idx >= finalOutputIndex) {
          finalOutputIndex = idx
          finalOutput = output
        }
      }

      const buildContext = (isLast: boolean): IExecutionContext => ({
        chatId: opts.chatId,
        runId: opts.runId,
        state: runtime.state,
        isLastNode: isLast,
        sseStreamer: opts.sseStreamer,
        startInput: opts.startInput,
        sessionId: opts.sessionId,
        signal: opts.signal,
        agentflowRuntime: { state: runtime.state },
        llmClient: opts.llmClient,
        agentFetcher: opts.agentFetcher,
        toolRegistry,
        historyRetriever: opts.historyRetriever,
        humanInputResolver: opts.humanInputResolver,
        flowExecutor: opts.flowExecutor,
      })

      /** Execute one node instance (no scheduling). Throws on node failure. */
      const runNode = async (flowNode: FlowNode, nodeInput: unknown): Promise<INodeOutput> => {
        const nodeInstance = this.registry.get(flowNode.data.name as string)
        if (!nodeInstance) {
          throw new Error(`Node type "${flowNode.data.name}" not registered`)
        }
        const nodeData: INodeData = {
          id: flowNode.id,
          name: flowNode.data.name as string,
          inputs: flowNode.data,
        }
        const isLast = this.isLastExecutableNode(flowNode, outgoingEdges, opts.isLastNode)
        return nodeInstance.run(nodeData, nodeInput, buildContext(isLast))
      }

      /** Incoming edges of `nodeId` that are active given `outputs`. */
      const activeIncoming = (
        nodeId: string,
        outputs: Map<string, Record<string, unknown>>,
      ): FlowEdge[] => {
        const edges = incomingEdges.get(nodeId) ?? []
        return edges.filter((edge) => {
          const sourceOutput = outputs.get(edge.source)
          if (!sourceOutput) return false
          return this.shouldExecuteEdge(edge, sourceOutput)
        })
      }

      /**
       * Wave scheduler over a restricted node scope (the whole graph, or a
       * loop body). Mutates `outputs` and appends to `executedNodes`; merges
       * node state into `runtime`. Returns the processed ids (executed +
       * skipped) and the first error, if any.
       *
       * `entryEdges` are scope-entry edges whose source lives outside the
       * scope (the loop controller's body edges). They count as satisfied for
       * readiness and resolve against `seed` — a per-iteration pseudo-output
       * map — instead of `outputs`.
       */
      const runWaves = async (
        scope: Set<string>,
        entryEdges: FlowEdge[],
        outputs: Map<string, Record<string, unknown>>,
        seed: Map<string, Record<string, unknown>>,
      ): Promise<{ processed: Set<string>; error?: string }> => {
        // Local pending counts: only edges internal to the scope gate
        // readiness — entry edges are pre-satisfied (their source, the loop
        // controller, already ran) and resolve via `seed`.
        const entrySet = new Set(entryEdges)
        const localPending = new Map<string, number>()
        for (const nodeId of scope) {
          const edges = (incomingEdges.get(nodeId) ?? []).filter(
            (e) => scope.has(e.source) && !entrySet.has(e),
          )
          localPending.set(nodeId, edges.length)
        }

        const byTopo = (a: string, b: string) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0)

        const processed = new Set<string>()
        let wave = [...scope].filter((id) => (localPending.get(id) ?? 0) === 0).sort(byTopo)

        while (wave.length > 0) {
          if (opts.signal?.aborted) {
            return { processed, error: 'Execution aborted' }
          }

          // Evaluate every wave member: execute or skip. Tasks never reject —
          // failures are carried in the outcome.
          const outcomes = await Promise.all(
            wave.map(async (nodeId): Promise<WaveOutcome> => {
              const flowNode = nodeById.get(nodeId)!
              const nodeIncoming = incomingEdges.get(nodeId) ?? []
              const isStartNode = nodeIncoming.length === 0

              // Entry edges with no resolved source output resolve via seed.
              const seedEntries = entryEdges.filter(
                (e) => e.target === nodeId && !outputs.has(e.source),
              )
              const incoming = activeIncoming(nodeId, outputs)
              const shouldExecute =
                isStartNode || incoming.length > 0 || seedEntries.length > 0

              if (!shouldExecute) {
                return { kind: 'skipped', nodeId }
              }

              const nodeInput = seedEntries.length > 0
                ? this.mergeInputs(seedEntries, seed)
                : isStartNode
                  ? input
                  : this.mergeInputs(incoming, outputs)

              const startedAt = new Date().toISOString()
              try {
                const output = await runNode(flowNode, nodeInput)
                executedNodes.push({
                  nodeId,
                  nodeName: flowNode.data.name as string,
                  startedAt,
                  endedAt: new Date().toISOString(),
                  status: 'success',
                  input: output.input,
                  output: output.output,
                  tokens: output.usage ?? null,
                  cost: null,
                })
                runtime.merge(output.state)
                // Expose the node's output to template variables under its
                // node id (the canvas variable picker inserts `{{<nodeId>}}`),
                // spread at top level for `{{id.field}}` AND nested under
                // `output` for `{{id.output.field}}`.
                const nodeOut = output.output
                runtime.merge({ [nodeId]: { ...nodeOut, output: nodeOut } })
                outputs.set(nodeId, output.output)
                recordExecution(nodeId, output.output)
                return { kind: 'executed', nodeId, output: output.output, input: nodeInput }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                executedNodes.push({
                  nodeId,
                  nodeName: flowNode.data.name as string,
                  startedAt,
                  endedAt: new Date().toISOString(),
                  status: 'failed',
                  input: this.toRecord(nodeInput),
                  output: {},
                  error: message,
                })
                return { kind: 'failed', nodeId, error: message }
              }
            }),
          )

          const failure = outcomes.find((o): o is FailedOutcome => o.kind === 'failed')
          if (failure) {
            for (const o of outcomes) processed.add(o.nodeId)
            return { processed, error: failure.error }
          }

          // Everything processed this round — loop controllers additionally
          // run their whole body inline, which processes the body nodes too.
          const released = new Set<string>()
          for (const o of outcomes) {
            processed.add(o.nodeId)
            released.add(o.nodeId)

            const flowNode = nodeById.get(o.nodeId)!
            if (o.kind !== 'executed' || !LOOP_CONTROLLER_NAMES.has(flowNode.data.name as string)) {
              continue
            }

            const plan = this.planLoopBody(flowNode, outgoingEdges, o.output, scope)
            if (plan.body.size === 0) {
              continue
            }
            const loopResult = await runLoopBody(flowNode, plan, outputs, o.input)
            if (loopResult.error) {
              for (const bodyId of plan.body) processed.add(bodyId)
              return { processed, error: loopResult.error }
            }
            for (const bodyId of plan.body) {
              processed.add(bodyId)
              released.add(bodyId)
            }
            // Downstream (result-path) nodes consume the aggregate output,
            // and the controller's trace record reflects it too.
            outputs.set(o.nodeId, loopResult.output)
            recordExecution(o.nodeId, loopResult.output)
            for (let i = executedNodes.length - 1; i >= 0; i--) {
              if (executedNodes[i].nodeId === o.nodeId) {
                executedNodes[i].output = loopResult.output
                break
              }
            }
          }

          // Release outgoing edges of everything processed this round, then
          // assemble the next wave from the scope's remaining nodes.
          const nextWave: string[] = []
          for (const releasedId of released) {
            for (const edge of outgoingEdges.get(releasedId) ?? []) {
              if (!scope.has(edge.target)) continue
              localPending.set(edge.target, (localPending.get(edge.target) ?? 1) - 1)
            }
          }
          for (const nodeId of scope) {
            if (!processed.has(nodeId) && (localPending.get(nodeId) ?? 0) === 0) {
              nextWave.push(nodeId)
            }
          }
          wave = nextWave.sort(byTopo)
        }

        return { processed }
      }

      /**
       * Execute a loop controller's body N times sequentially. Each iteration
       * runs the body sub-DAG against a fresh clone of the global outputs
       * (minus the controller's raw output, so entry edges resolve via the
       * per-iteration seed: the item for Iteration, the previous iteration's
       * result for Loop). Loop metadata is merged into runtime state so
       * prompts can reference it via template variables.
       */
      const runLoopBody = async (
        controller: FlowNode,
        plan: LoopPlan,
        globalOutputs: Map<string, Record<string, unknown>>,
        controllerInput: unknown,
      ): Promise<{ output: Record<string, unknown>; error?: string }> => {
        const controllerOutput = globalOutputs.get(controller.id) ?? {}
        const iterations: Array<Record<string, unknown>> = []
        const count = plan.kind === 'loop' ? Number(controllerOutput.loopCount ?? 0) : plan.items.length
        let lastBodyOutput: Record<string, unknown> = {}
        let completed = 0

        // Optional early-exit condition (Loop node only): a JS expression
        // evaluated against `$flow.state` before each subsequent iteration.
        let breakCondition: ((state: Record<string, unknown>) => boolean) | null = null
        if (plan.kind === 'loop' && typeof plan.condition === 'string' && plan.condition.trim() !== '') {
          try {
            const fn = new Function('$flow', `return (${plan.condition});`)
            breakCondition = (state) => Boolean(fn({ state }))
          } catch {
            breakCondition = null
          }
        }

        for (let i = 0; i < count; i++) {
          if (opts.signal?.aborted) break
          if (breakCondition && i > 0 && breakCondition(runtime.state)) {
            break
          }

          const item = plan.kind === 'iteration' ? plan.items[i] : undefined
          // Loop seed: the controller's upstream input for the first
          // iteration, then the previous iteration's final output. String
          // inputs keep the Flowise content-string convention so text nodes
          // downstream receive them directly.
          const seedValue: Record<string, unknown> =
            item !== undefined
              ? {
                  content: typeof item === 'string' ? item : JSON.stringify(item),
                  item,
                  iterationIndex: i,
                }
              : i === 0
                ? typeof controllerInput === 'string'
                  ? { content: controllerInput }
                  : this.toRecord(controllerInput)
                : lastBodyOutput
          const seed = new Map<string, Record<string, unknown>>([[controller.id, seedValue]])
          runtime.merge(
            plan.kind === 'iteration'
              ? { iterationIndex: i, iterationCount: count, iterationItem: item ?? null, iteration: item ?? null }
              : { loopIndex: i, loopCount: count },
          )

          const iterationOutputs = new Map(globalOutputs)
          iterationOutputs.delete(controller.id)
          const result = await runWaves(plan.body, plan.entryEdges, iterationOutputs, seed)
          if (result.error) {
            return { output: {}, error: result.error }
          }

          // The iteration's final output = deepest body node executed.
          let iterationFinal: Record<string, unknown> = {}
          let iterationFinalIndex = -1
          for (const nodeId of result.processed) {
            const out = iterationOutputs.get(nodeId)
            if (!out) continue
            const idx = topoIndex.get(nodeId) ?? -1
            if (idx >= iterationFinalIndex) {
              iterationFinalIndex = idx
              iterationFinal = out
            }
          }
          iterations.push(iterationFinal)
          lastBodyOutput = iterationFinal
          completed = i + 1
        }

        const content =
          typeof lastBodyOutput.content === 'string'
            ? lastBodyOutput.content
            : JSON.stringify(lastBodyOutput)
        return {
          output: {
            ...controllerOutput,
            iterations,
            completedIterations: completed,
            content,
          },
        }
      }

      const allScope = new Set(order.map((n) => n.id))
      const result = await runWaves(allScope, [], nodeOutputs, new Map())

      if (result.error) {
        return {
          status: 'failed',
          executedNodes,
          finalOutput: null,
          error: result.error,
          state: runtime.snapshot(),
        }
      }

      return {
        status: 'success',
        executedNodes,
        finalOutput,
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
   * Extract a loop controller's body plan from the graph.
   *
   * Body = transitive closure from the controller's body-anchor edges
   * (`loop` for Loop, `iteration` for Iteration). Legacy graphs built before
   * the dual-anchor canvas metadata (single unnamed output) have no
   * body-anchor edges — every outgoing edge is treated as body, matching the
   * old single-path semantics.
   */
  private planLoopBody(
    controller: FlowNode,
    outgoingEdges: Map<string, FlowEdge[]>,
    controllerOutput: Record<string, unknown>,
    scope: Set<string>,
  ): LoopPlan {
    const kind: LoopPlan['kind'] = controller.data.name === 'iterationAgentflow' ? 'iteration' : 'loop'
    const bodyHandle = kind === 'iteration' ? 'iteration' : 'loop'
    const edges = outgoingEdges.get(controller.id) ?? []

    let entryEdges = edges.filter((e) => e.sourceHandle === bodyHandle)
    const hasResultEdges = edges.some((e) => e.sourceHandle === 'result')
    if (entryEdges.length === 0 && !hasResultEdges) {
      entryEdges = edges
    }

    // Transitive closure from the entry targets, bounded by the scheduler's
    // scope (loop bodies nested inside loop bodies belong to the inner run).
    const body = new Set<string>()
    const queue = entryEdges.map((e) => e.target).filter((t) => scope.has(t) && t !== controller.id)
    while (queue.length > 0) {
      const id = queue.shift()!
      if (body.has(id)) continue
      body.add(id)
      for (const edge of outgoingEdges.get(id) ?? []) {
        if (scope.has(edge.target) && edge.target !== controller.id) {
          queue.push(edge.target)
        }
      }
    }

    const itemsRaw = controllerOutput.iterationInput
    const items = Array.isArray(itemsRaw) ? itemsRaw : []

    return {
      kind,
      body,
      entryEdges,
      condition: kind === 'loop' ? (controller.data.condition as string | undefined) : undefined,
      items,
    }
  }

  /**
   * Determine whether an edge should be executed based on the source node's output.
   *
   * Rules:
   * - No sourceHandle → always active
   * - sourceHandle='true' → active when output.matched/result === 'true' or output.matched === true
   * - sourceHandle='false' → active when output.matched/result === 'false' or output.matched === false
   * - Other sourceHandle → active when output.selected or output.result matches
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
   * Build a map of node id → list of outgoing edges.
   */
  private buildOutgoingEdges(edges: FlowEdge[]): Map<string, FlowEdge[]> {
    const outgoing = new Map<string, FlowEdge[]>()
    for (const edge of edges) {
      const list = outgoing.get(edge.source) ?? []
      list.push(edge)
      outgoing.set(edge.source, list)
    }
    return outgoing
  }

  /**
   * Determine if the node is the last executable node.
   * A node is "last" when it has no outgoing edges at all. This is a pre-run
   * heuristic: edges whose sourceHandle won't match the current output cannot
   * be detected here, but it correctly handles linear DAGs and active branch tails
   * (which themselves have no outgoing edges).
   *
   * Returns false when the caller disabled last-node handling (`isLastNodeFlag`).
   */
  private isLastExecutableNode(
    currentNode: FlowNode,
    outgoingEdges: Map<string, FlowEdge[]>,
    isLastNodeFlag: boolean,
  ): boolean {
    if (!isLastNodeFlag) return false
    const outgoing = outgoingEdges.get(currentNode.id) ?? []
    return outgoing.length === 0
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

/** Outcome of evaluating one wave member. */
type WaveOutcome =
  | { kind: 'skipped'; nodeId: string }
  | { kind: 'executed'; nodeId: string; output: Record<string, unknown>; input: unknown }
  | FailedOutcome

interface FailedOutcome {
  kind: 'failed'
  nodeId: string
  error: string
}
