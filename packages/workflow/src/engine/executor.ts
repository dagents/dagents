import type { FlowData, FlowEdge, FlowNode } from '../types/flow.js'
import type { INodeData, INodeOutput } from '../types/node.js'
import type {
  IExecutionContext,
  IExecutedNode,
  ExecutionStatus,
  IAgentTool,
  ITokenUsage,
} from '../types/execution.js'
import { NodeRegistry } from './node-registry.js'
import { HumanInputPendingError } from './errors.js'
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
  /** HumanInput 挂起载荷（status === 'awaiting' 时必带，§6.3）。 */
  awaiting?: { nodeId: string; prompt: string; inputType: string; options: unknown[] }
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
  /** Tool registry — base tools for the run, used by Agent tool-calling loops. */
  toolRegistry?: IExecutionContext['toolRegistry']
  /** Human input resolver — passed through to HumanInput nodes. */
  humanInputResolver?: IExecutionContext['humanInputResolver']
  /**
   * Node lifecycle hooks — fire as each node starts / finishes so callers
   * (e.g. the gateway's canvas run) can persist live progress. Hooks are
   * synchronous from the executor's perspective: async work should be
   * fire-and-forget inside the callback so it never stalls a wave.
   */
  onNodeStart?: (node: { nodeId: string; nodeName: string }) => void
  onNodeEnd?: (node: IExecutedNode) => void
  /**
   * 节点增量产出钩子（2026-08-30 流式展示）：LLM/Agent 节点生成过程中
   * 逐段回调（text 正文增量 / activity 过程活动）。同步 fire-and-forget
   * （宿主内部自行节流），绝不阻塞生成循环。
   */
  onNodeDelta?: (
    node: { nodeId: string; nodeName: string },
    chunk: import('../types/execution.js').IStreamDelta,
  ) => void
  /** 断点续跑种子（§6.3）：命中 seedOutputs 的节点跳过执行。 */
  resume?: ResumeOptions
  /**
   * 执行状态快照钩子（§6.2）：每波次收敛 / 迭代每项完成 / 终态前回调。
   * 同步 fire-and-forget（宿主自行节流落库），绝不阻塞调度。
   */
  onCheckpoint?: (snapshot: RunCheckpointSnapshot) => void
}

/** Node type names whose iteration body the executor repeats. */
const ITERATION_CONTROLLERS = new Set(['iterationAgentflow'])

/** 节点级重试上限（opt-in `retries` 输入的硬顶，防配置错误放大故障）。 */
const MAX_NODE_RETRIES = 3
const RETRY_BACKOFF_BASE_MS = 200

/** 迭代项级游标（断点续跑 §6.2）：controllerId → 已完成项数 + 每项末态。 */
export interface IterationProgress {
  completed: number
  itemOutputs: Array<Record<string, unknown>>
}

/** 断点续跑种子（§6.3 ResumeOptions 的载荷）。 */
export interface ResumeOptions {
  /** 已完成节点的原始引擎输出 —— 命中者跳过执行（结构保证，非 best-effort）。 */
  seedOutputs: Record<string, Record<string, unknown>>
  /** 预填充的 runtime state 顶层（含 $start 别名 / 各节点键 / humanInputs 应答）。 */
  seedRuntime?: Record<string, unknown>
  /** 迭代游标：controllerId → 进度。 */
  iterationProgress?: Record<string, IterationProgress>
}

/**
 * 执行状态快照（落库载荷形状，§6.2）。引擎只负责生产；持久化由宿主的
 * onCheckpoint 钩子完成（引擎保持 DB-free）。
 */
export interface RunCheckpointSnapshot {
  outputs: Record<string, Record<string, unknown>>
  runtime: Record<string, unknown>
  iterationProgress: Record<string, IterationProgress>
  failedAt?: { nodeId: string; error: string }
}

/** An iteration controller's parsed execution plan (see `planIterationBody`). */
interface IterationPlan {
  /** Body node ids — transitive closure from the body anchor, excluding the controller. */
  body: Set<string>
  /** Edges from the controller into the body entries. */
  entryEdges: FlowEdge[]
  /** The items to iterate over. */
  items: unknown[]
}

/**
 * Per-execution mutable state shared by the scheduler / node runner /
 * iteration runner（2026-09-17 拆解：此前这十余个可变量以闭包形式挤在
 * execute() 单方法里，任何改动只能整图级回归 —— 现在以显式上下文对象
 * 在私有方法间传递，行为逐字保持）。
 */
interface RunContext {
  opts: ExecuteOptions
  /** 本次执行的原始输入（start 节点的 nodeInput 来源）。 */
  input: unknown
  runtime: RuntimeState
  executedNodes: IExecutedNode[]
  nodeById: Map<string, FlowNode>
  topoIndex: Map<string, number>
  incomingEdges: Map<string, FlowEdge[]>
  outgoingEdges: Map<string, FlowEdge[]>
  /** Per-run tool registry overlay（不泄漏进调用方对象）。 */
  toolRegistry: Record<string, IAgentTool>
  /** finalOutput = 拓扑最深的已执行节点输出。 */
  finalOutput: Record<string, unknown> | null
  finalOutputIndex: number
  /** 迭代游标（断点续跑）：runIterationBody 增量维护。 */
  iterationProgress: Map<string, IterationProgress>
  /** 根图 outputs 引用（区分根调度与迭代体克隆，checkpoint 只拍根）。 */
  rootOutputs: Map<string, Record<string, unknown>> | null
  onCheckpoint?: (snapshot: RunCheckpointSnapshot) => void
}

/**
 * DAG executor — dependency-based wave scheduling with branching and iteration.
 *
 * Supports:
 * - Linear DAGs (backward compatible)
 * - Parallel branches: nodes whose incoming edges are all resolved form a
 *   "wave" and execute concurrently (`Promise.all`); waves advance in
 *   topological order, so `executedNodes` stays deterministic
 * - Conditional branching via Condition nodes with sourceHandle
 * - Iteration nodes: the executor detects them, extracts their body
 *   (the sub-DAG reachable from the `iteration` output anchor —
 *   legacy single-anchor graphs treat every outgoing edge as body), and
 *   re-executes it once per item with iteration metadata exposed in runtime
 *   state (`iterationIndex` / `iterationCount` / `iterationItem`)
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
      const topoIndex = new Map(order.map((n, i) => [n.id, i]))
      const outgoingEdges = this.buildOutgoingEdges(flow.edges)

      // 断点续跑种子（§6.3）：预填充节点输出 + runtime + 迭代游标。
      const resume = opts.resume
      const nodeOutputs = new Map<string, Record<string, unknown>>()
      const nodeById = new Map(order.map((n) => [n.id, n]))
      if (resume) {
        for (const [id, out] of Object.entries(resume.seedOutputs)) {
          if (nodeById.has(id)) nodeOutputs.set(id, out)
        }
        if (resume.seedRuntime) runtime.merge(resume.seedRuntime)
      }

      const ctx: RunContext = {
        opts,
        input,
        runtime,
        executedNodes,
        nodeById,
        topoIndex,
        incomingEdges: this.buildIncomingEdges(flow.edges),
        outgoingEdges,
        toolRegistry: { ...(opts.toolRegistry ?? {}) },
        finalOutput: null,
        finalOutputIndex: -1,
        iterationProgress: new Map(
          Object.entries(resume?.iterationProgress ?? {}).map(([k, v]) => [k, { ...v, itemOutputs: [...v.itemOutputs] }]),
        ),
        rootOutputs: nodeOutputs,
        onCheckpoint: opts.onCheckpoint,
      }

      // 种子节点计入 finalOutput 判定（续跑后无新节点执行时最终产出仍正确）
      if (resume) {
        for (const id of Object.keys(resume.seedOutputs)) {
          if (nodeById.has(id)) this.recordExecution(ctx, id, nodeOutputs.get(id) ?? {})
        }
      }

      const allScope = new Set(order.map((n) => n.id))
      const result = await this.runWaves(ctx, allScope, [], nodeOutputs, new Map())

      if (result.pending) {
        // HumanInput 持久挂起（§6.3）：不判失败 —— 宿主落 checkpoint
        // （awaiting_input）并结束本次执行；应答后以 resume 语义续跑。
        this.fireCheckpoint(ctx, nodeOutputs)
        return {
          status: 'awaiting',
          executedNodes,
          finalOutput: null,
          awaiting: {
            nodeId: result.pending.nodeId,
            prompt: result.pending.prompt,
            inputType: result.pending.inputType,
            options: result.pending.options,
          },
          state: runtime.snapshot(),
        }
      }

      if (result.error) {
        // A caller-aborted run reports `cancelled` (not `failed') so callers
        // can distinguish user intent from engine errors — the enum value
        // existed since the beginning but was never produced (spec D3).
        const cancelled = opts.signal?.aborted === true
        this.fireCheckpoint(ctx, nodeOutputs, {
          nodeId: result.failedNodeId ?? '',
          error: result.error,
        })
        return {
          status: cancelled ? 'cancelled' : 'failed',
          executedNodes,
          finalOutput: null,
          error: cancelled ? 'Execution cancelled by user' : result.error,
          state: runtime.snapshot(),
        }
      }

      this.fireCheckpoint(ctx, nodeOutputs)
      return {
        status: 'success',
        executedNodes,
        finalOutput: ctx.finalOutput,
        state: runtime.snapshot(),
      }
    } catch (err) {
      const cancelled = opts.signal?.aborted === true
      return {
        status: cancelled ? 'cancelled' : 'failed',
        executedNodes,
        finalOutput: null,
        error: cancelled
          ? 'Execution cancelled by user'
          : err instanceof Error
            ? err.message
            : String(err),
        state: runtime.snapshot(),
      }
    }
  }

  /** 组装并发射快照（§6.2）。只在根图上有意义 —— 迭代体克隆不拍。 */
  private fireCheckpoint(
    ctx: RunContext,
    rootOutputs: Map<string, Record<string, unknown>>,
    failedAt?: { nodeId: string; error: string },
  ): void {
    if (!ctx.onCheckpoint) return
    ctx.onCheckpoint({
      outputs: Object.fromEntries(rootOutputs),
      runtime: ctx.runtime.snapshot(),
      iterationProgress: Object.fromEntries(ctx.iterationProgress),
      ...(failedAt ? { failedAt } : {}),
    })
  }

  /** Record a node output as the run's final output if it's topologically deepest. */
  private recordExecution(ctx: RunContext, nodeId: string, output: Record<string, unknown>): void {
    const idx = ctx.topoIndex.get(nodeId) ?? -1
    if (idx >= ctx.finalOutputIndex) {
      ctx.finalOutputIndex = idx
      ctx.finalOutput = output
    }
  }

  /** Build the IExecutionContext handed to one node run. */
  private buildNodeContext(
    ctx: RunContext,
    isLast: boolean,
    nodeId?: string,
    nodeName?: string,
  ): IExecutionContext {
    const { opts } = ctx
    return {
      chatId: opts.chatId,
      runId: opts.runId,
      state: ctx.runtime.state,
      isLastNode: isLast,
      sseStreamer: opts.sseStreamer,
      startInput: opts.startInput,
      sessionId: opts.sessionId,
      signal: opts.signal,
      agentflowRuntime: { state: ctx.runtime.state },
      // 按当前节点绑定 delta 回调 —— 并行波次里每个节点报自己的增量
      onNodeDelta:
        opts.onNodeDelta && nodeId
          ? (chunk: import('../types/execution.js').IStreamDelta) =>
            opts.onNodeDelta!({ nodeId, nodeName: nodeName ?? nodeId }, chunk)
          : undefined,
      llmClient: opts.llmClient,
      agentFetcher: opts.agentFetcher,
      toolRegistry: ctx.toolRegistry,
      humanInputResolver: opts.humanInputResolver,
    }
  }

  /** Execute one node instance (no scheduling). Throws on node failure.
   * 节点级 opt-in 重试（2026-09-17）：节点声明 `retries` 输入（0~3，缺省
   * 0 = 行为不变）时，失败自动重试并指数退避 —— LLM/HTTP 类瞬时故障的
   * 单节点自愈，不改变波次失败语义（重试耗尽仍按波次失败上报）。取消
   * 信号触发时不重试。 */
  private async runNode(ctx: RunContext, flowNode: FlowNode, nodeInput: unknown): Promise<INodeOutput> {
    const nodeInstance = this.registry.get(flowNode.data.name as string)
    if (!nodeInstance) {
      throw new Error(`Node type "${flowNode.data.name}" not registered`)
    }
    // 两种数据形态归一化：AI 生成/手工编写的 flow 把配置平铺在
    // `data.<field>`；画布编辑器（vendor/agentflow nodeFactory +
    // EditNodeDialog）把配置嵌套在 `data.inputs.<field>`。节点统一从
    // `nodeData.inputs.<field>` 读 —— 平铺键打底、嵌套 inputs 覆盖，
    // 这样画布保存后改的值生效，且老 flow 不受影响。
    const flat = flowNode.data as Record<string, unknown>
    const nested = flat?.inputs
    const mergedInputs =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? { ...flat, ...(nested as Record<string, unknown>) }
        : { ...flat }
    const nodeData: INodeData = {
      id: flowNode.id,
      name: flowNode.data.name as string,
      inputs: mergedInputs,
    }
    const isLast = this.isLastExecutableNode(flowNode, ctx.outgoingEdges, ctx.opts.isLastNode)
    const runCtx = this.buildNodeContext(ctx, isLast, flowNode.id, flowNode.data.name as string)

    const retriesRaw = mergedInputs.retries
    const retries =
      typeof retriesRaw === 'number' && Number.isFinite(retriesRaw)
        ? Math.min(Math.max(Math.trunc(retriesRaw), 0), MAX_NODE_RETRIES)
        : 0

    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await nodeInstance.run(nodeData, nodeInput, runCtx)
      } catch (err) {
        if (attempt >= retries || ctx.opts.signal?.aborted) throw err
        attempt += 1
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_BASE_MS * attempt))
      }
    }
  }

  /** Incoming edges of `nodeId` that are active given `outputs`. */
  private activeIncomingEdges(
    ctx: RunContext,
    nodeId: string,
    outputs: Map<string, Record<string, unknown>>,
  ): FlowEdge[] {
    const edges = ctx.incomingEdges.get(nodeId) ?? []
    return edges.filter((edge) => {
      const sourceOutput = outputs.get(edge.source)
      if (!sourceOutput) return false
      return this.shouldExecuteEdge(edge, sourceOutput, ctx.nodeById.get(edge.source))
    })
  }

  /**
   * Wave scheduler over a restricted node scope (the whole graph, or a
   * iteration body). Mutates `outputs` and appends to `ctx.executedNodes`;
   * merges node state into `ctx.runtime`. Returns the processed ids
   * (executed + skipped) and the first error, if any.
   *
   * `entryEdges` are scope-entry edges whose source lives outside the
   * scope (an iteration controller's body edges). They count as satisfied for
   * readiness and resolve against `seed` — a per-iteration pseudo-output
   * map — instead of `outputs`.
   */
  private async runWaves(
    ctx: RunContext,
    scope: Set<string>,
    entryEdges: FlowEdge[],
    outputs: Map<string, Record<string, unknown>>,
    seed: Map<string, Record<string, unknown>>,
  ): Promise<{
    processed: Set<string>
    error?: string
    failedNodeId?: string
    pending?: { nodeId: string; prompt: string; inputType: string; options: unknown[] }
  }> {
    const { opts, runtime, executedNodes, nodeById, topoIndex, incomingEdges } = ctx

    // Local pending counts: only edges internal to the scope gate
    // readiness — entry edges are pre-satisfied (their source, the iteration
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
    // 断点续跑（§6.3）：outputs 里已有的节点视为已执行 —— 计入 processed
    // 并释放其出边的 pending 计数（首次波次装配即从断点之后开始）。
    // 仅根图生效：迭代体每项拿的是上游 outputs 的克隆，若误判会把
    // 前一项的 body 当「已完成」跳过（嵌套迭代 2×2 塌成 1×2 的教训）。
    if (outputs === ctx.rootOutputs) {
      for (const id of outputs.keys()) {
        if (!scope.has(id) || processed.has(id)) continue
        processed.add(id)
        for (const edge of ctx.outgoingEdges.get(id) ?? []) {
          if (scope.has(edge.target)) {
            localPending.set(edge.target, (localPending.get(edge.target) ?? 1) - 1)
          }
        }
      }
    }
    let wave = [...scope].filter((id) => (localPending.get(id) ?? 0) === 0 && !processed.has(id)).sort(byTopo)

    while (wave.length > 0) {
      if (opts.signal?.aborted) {
        return { processed, error: 'Execution cancelled' }
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
          const incoming = this.activeIncomingEdges(ctx, nodeId, outputs)
          const shouldExecute =
            isStartNode || incoming.length > 0 || seedEntries.length > 0

          if (!shouldExecute) {
            return { kind: 'skipped', nodeId }
          }

          const nodeInput = seedEntries.length > 0
            ? this.mergeInputs(seedEntries, seed)
            : isStartNode
              ? ctx.input
              : this.mergeInputs(incoming, outputs)

          const startedAt = new Date().toISOString()
          try {
            opts.onNodeStart?.({ nodeId, nodeName: flowNode.data.name as string })
            const output = await this.runNode(ctx, flowNode, nodeInput)
            const executed: IExecutedNode = {
              nodeId,
              nodeName: flowNode.data.name as string,
              startedAt,
              endedAt: new Date().toISOString(),
              status: 'success',
              input: output.input,
              output: output.output,
              tokens: output.usage ?? null,
              cost: null,
            }
            executedNodes.push(executed)
            opts.onNodeEnd?.(executed)
            runtime.merge(output.state)
            // Expose the node's output to template variables under its
            // node id (the canvas variable picker inserts `{{<nodeId>}}`),
            // spread at top level for `{{id.field}}` AND nested under
            // `output` for `{{id.output.field}}`.
            const nodeOut = output.output
            runtime.merge({ [nodeId]: { ...nodeOut, output: nodeOut } })
            // `{{$start.input}}` 别名（variables.ts resolveAlias 映射到
            // state.start.content）此前永远落空 —— Start 输出只挂在节点
            // id 键下，而画布运行面板的文案恰恰宣传这个语法。Start 节点
            // 输出额外登记 state.start（文档语义：$start = 流程入口）。
            if (flowNode.data.name === 'startAgentflow') {
              runtime.merge({ start: { ...nodeOut, output: nodeOut } })
            }
            outputs.set(nodeId, output.output)
            this.recordExecution(ctx, nodeId, output.output)
            return { kind: 'executed', nodeId, output: output.output, input: nodeInput }
          } catch (err) {
            // HumanInput 挂起信号（§6.3）：resolver reject HumanInputPendingError
            // —— 本波次收敛为 pending 而非 failure。
            if (err instanceof HumanInputPendingError) {
              return {
                kind: 'pending',
                nodeId,
                prompt: err.prompt,
                inputType: err.inputType,
                options: err.options,
              } satisfies WaveOutcome
            }
            const message = err instanceof Error ? err.message : String(err)
            // 被看门狗清理/取消的 CLI 调用把已产生的 usage 附着在错误
            // 对象上（见 gateway createCliLlmClient）—— 失败节点的 span
            // 也能如实记录烧掉的 tokens，而不是恒 0。
            const errUsage = (err as { usage?: ITokenUsage }).usage
            const executed: IExecutedNode = {
              nodeId,
              nodeName: flowNode.data.name as string,
              startedAt,
              endedAt: new Date().toISOString(),
              status: 'failed',
              input: this.toRecord(nodeInput),
              output: {},
              tokens: errUsage ?? null,
              error: message,
            }
            executedNodes.push(executed)
            opts.onNodeEnd?.(executed)
            return { kind: 'failed', nodeId, error: message }
          }
        }),
      )

      const pendingOutcome = outcomes.find((o): o is PendingOutcome => o.kind === 'pending')
      if (pendingOutcome) {
        for (const o of outcomes) processed.add(o.nodeId)
        return {
          processed,
          pending: {
            nodeId: pendingOutcome.nodeId,
            prompt: pendingOutcome.prompt,
            inputType: pendingOutcome.inputType,
            options: pendingOutcome.options,
          },
        }
      }

      const failure = outcomes.find((o): o is FailedOutcome => o.kind === 'failed')
      if (failure) {
        for (const o of outcomes) processed.add(o.nodeId)
        return { processed, error: failure.error, failedNodeId: failure.nodeId }
      }

      // Everything processed this round — iteration controllers additionally
      // run their whole body inline, which processes the body nodes too.
      const released = new Set<string>()
      for (const o of outcomes) {
        processed.add(o.nodeId)
        released.add(o.nodeId)

        const flowNode = nodeById.get(o.nodeId)!
        if (o.kind !== 'executed' || !ITERATION_CONTROLLERS.has(flowNode.data.name as string)) {
          continue
        }

        const plan = this.planIterationBody(flowNode, ctx.outgoingEdges, o.output, scope)
        if (plan.body.size === 0) {
          continue
        }
        const iterationResult = await this.runIterationBody(ctx, flowNode, plan, outputs)
        if (iterationResult.error) {
          for (const bodyId of plan.body) processed.add(bodyId)
          return { processed, error: iterationResult.error }
        }
        for (const bodyId of plan.body) {
          processed.add(bodyId)
          released.add(bodyId)
        }
        // Downstream (result-path) nodes consume the aggregate output,
        // and the controller's trace record reflects it too.
        outputs.set(o.nodeId, iterationResult.output)
        this.recordExecution(ctx, o.nodeId, iterationResult.output)
        for (let i = executedNodes.length - 1; i >= 0; i--) {
          if (executedNodes[i].nodeId === o.nodeId) {
            executedNodes[i].output = iterationResult.output
            // 体内执行发生在控制器节点的 onNodeEnd 之后 —— 若不重发
            // 钩子，增量 span 落库的是 start 快照（只有 iterationInput），
            // completedIterations/iterations 等终态字段永久丢失
            // （6 例 e2e 既有失败的根因）。endedAt 顺延到体内完成，
            // span 时长才等于整轮循环的真实耗时。
            executedNodes[i].endedAt = new Date().toISOString()
            opts.onNodeEnd?.(executedNodes[i])
            break
          }
        }
      }

      // Release outgoing edges of everything processed this round, then
      // assemble the next wave from the scope's remaining nodes.
      const nextWave: string[] = []
      for (const releasedId of released) {
        for (const edge of ctx.outgoingEdges.get(releasedId) ?? []) {
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
      // 根图每波次收敛后拍快照（§6.2 写入时机；迭代体克隆不拍 —— 判据
      // 是本 runWaves 操作的 outputs 即 ctx.rootOutputs）
      if (ctx.onCheckpoint && outputs === ctx.rootOutputs) {
        this.fireCheckpoint(ctx, outputs)
      }
    }

    return { processed }
  }

  /**
   * Execute an iteration controller's body once per item, sequentially.
   * Each iteration runs the body sub-DAG against a fresh clone of the
   * global outputs (minus the controller's raw output, so entry edges
   * resolve via the per-iteration seed: the current item wrapped in the
   * content-string convention). Iteration metadata is merged into runtime
   * state so prompts can reference it via template variables.
   */
  private async runIterationBody(
    ctx: RunContext,
    controller: FlowNode,
    plan: IterationPlan,
    globalOutputs: Map<string, Record<string, unknown>>,
  ): Promise<{ output: Record<string, unknown>; error?: string }> {
    const { runtime, topoIndex } = ctx
    const controllerOutput = globalOutputs.get(controller.id) ?? {}
    // 纵深防御：IterationNode.run 已在节点侧对超上限抛错（span 可见），
    // 这里兜住绕过节点校验直接进入 body 计划的路径 —— 同值同语义。
    const MAX_ITERATION_ITEMS = 100
    if (plan.items.length > MAX_ITERATION_ITEMS) {
      return {
        output: {},
        error:
          `Iteration 节点「${controller.data?.name ?? controller.id}」的列表有 ` +
          `${plan.items.length} 项，超过上限 ${MAX_ITERATION_ITEMS}（拒绝静默截断，` +
          `请在上游缩小列表或分批运行）`,
      }
    }
    const count = plan.items.length
    let lastBodyOutput: Record<string, unknown> = {}
    // 断点续跑（§6.2 迭代游标）：从 checkpoint 的已完成项继续；已完项的
    // 产出直接进聚合（不重跑）。仅根图直挂的控制器保留游标 —— 嵌套在内
    // 层的控制器随外层每轮重新执行，其游标必须重置（否则外层第 2 项的
    // 内层循环被上一轮的游标「续」空）。
    if (globalOutputs !== ctx.rootOutputs) {
      ctx.iterationProgress.delete(controller.id)
    }
    const progress = ctx.iterationProgress.get(controller.id) ?? { completed: 0, itemOutputs: [] }
    const iterations: Array<Record<string, unknown>> = [...progress.itemOutputs]
    let completed = progress.completed
    if (completed > 0 && iterations.length > 0) {
      lastBodyOutput = iterations[iterations.length - 1] ?? {}
    }

    for (let i = completed; i < count; i++) {
      if (ctx.opts.signal?.aborted) break

      const item = plan.items[i]
      const seedValue: Record<string, unknown> = {
        content: typeof item === 'string' ? item : JSON.stringify(item),
        item,
        iterationIndex: i,
      }
      const seed = new Map<string, Record<string, unknown>>([[controller.id, seedValue]])
      runtime.merge({
        iterationIndex: i,
        iterationCount: count,
        iterationItem: item ?? null,
        iteration: item ?? null,
      })

      const iterationOutputs = new Map(globalOutputs)
      iterationOutputs.delete(controller.id)
      const result = await this.runWaves(ctx, plan.body, plan.entryEdges, iterationOutputs, seed)
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
      // 游标增量维护 + 快照（§6.2：迭代每项完成后）
      ctx.iterationProgress.set(controller.id, { completed, itemOutputs: [...iterations] })
      if (ctx.onCheckpoint && ctx.rootOutputs === globalOutputs) {
        this.fireCheckpoint(ctx, globalOutputs)
      }
    }

    // 循环结束后清掉迭代元数据（2026-09-17 评审修复）：此前
    // iterationIndex/iterationItem 等保留字残留最后一项的值，循环后
    // 的下游节点模板里 {{iterationItem}} 会静默解析到脏数据。
    runtime.delete('iterationIndex')
    runtime.delete('iterationCount')
    runtime.delete('iterationItem')
    runtime.delete('iteration')

    // FR-06（PRD 决议）：Iteration 的聚合 content = 逐项正文有序拼接
    // （与 N 进 1 合并契约同语义）——此前只保留最后一项，下游
    // `{{iter.content}}` 静默丢 N-1 份产出。完整数组在 `.iterations`。
    const aggregateContent = iterations
      .map((it) => (typeof it.content === 'string' ? it.content : JSON.stringify(it)))
      .filter((s) => s.length > 0)
      .join('\n\n')
    const content =
      typeof lastBodyOutput.content === 'string'
        ? lastBodyOutput.content
        : JSON.stringify(lastBodyOutput)
    return {
      output: {
        ...controllerOutput,
        iterations,
        completedIterations: completed,
        content: aggregateContent || content,
      },
    }
  }

  /**
   * Extract an iteration controller's body plan from the graph.
   *
   * Body = transitive closure from the controller's `iteration`-anchor edges.
   * Legacy graphs built before the dual-anchor canvas metadata (single
   * unnamed output) have no body-anchor edges — every outgoing edge is
   * treated as body, matching the old single-path semantics.
   */
  private planIterationBody(
    controller: FlowNode,
    outgoingEdges: Map<string, FlowEdge[]>,
    controllerOutput: Record<string, unknown>,
    scope: Set<string>,
  ): IterationPlan {
    const edges = outgoingEdges.get(controller.id) ?? []

    let entryEdges = edges.filter((e) => e.sourceHandle === 'iteration')
    const hasResultEdges = edges.some((e) => e.sourceHandle === 'result')
    if (entryEdges.length === 0 && !hasResultEdges) {
      entryEdges = edges
    }

    // Transitive closure from the entry targets, bounded by the scheduler's
    // scope (iteration bodies nested inside iteration bodies belong to the
    // inner run).
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

    return { body, entryEdges, items }
  }

  /**
   * Determine whether an edge should be executed based on the source node's output.
   *
   * Rules:
   * - No sourceHandle → always active
   * - sourceHandle='true' → active when output.matched/result === 'true' or output.matched === true
   * - sourceHandle='false' → active when output.matched/result === 'false' or output.matched === false
   * - Other sourceHandle → active when output.selected or output.result matches.
   *   If the output carries neither `selected` nor `result`（普通数据节点：
   *   LLM/Agent/HTTP/Iteration 聚合输出等，画布给它们的边填的是锚点 id 如
   *   'output'/'data'/'result'/`${nodeId}-output-N`)，默认激活 —— 只有
   *   声明了分支语义且不匹配时才剪枝，否则整条下游会被静默跳过、运行
   *   却仍报 success。
   *
   * 画布 Condition 节点例外：它的输出只有 `matched`（引擎把多条条件 OR 成
   * 一个布尔），但画布锚点是 `${id}-output-0..N`（最后一个是 Else）。对带
   * `matched` 的输出：Else 锚点（index ≥ 条件数）→ false 分支，其余数字
   * 锚点 → true 分支。
   */
  private shouldExecuteEdge(
    edge: FlowEdge,
    nodeOutput: Record<string, unknown>,
    sourceNode?: FlowNode,
  ): boolean {
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
    if (selected !== undefined || result !== undefined) {
      return selected === handle || result === handle
    }

    const matched = nodeOutput.matched
    if (matched !== undefined) {
      // Condition 源节点：把画布数字/Else 锚点映射回 true/false 分支。
      const matchedTrue = matched === 'true' || matched === true
      if (/^else$/i.test(handle)) return !matchedTrue
      const anchorMatch = sourceNode ? /^-output-(\d+)$/.exec(handle.replace(sourceNode.id, '')) : null
      if (anchorMatch) {
        const index = Number(anchorMatch[1])
        const flat = sourceNode?.data as Record<string, unknown> | undefined
        const nested = flat?.inputs as Record<string, unknown> | undefined
        const conditions = (nested?.conditions ?? flat?.conditions) as unknown[] | undefined
        // 读不到 conditions 时无法判定「最后一个是 Else」—— 按条件锚点
        // 处理（显式分支，不再走 NaN 比较的隐式结果）。
        const conditionCount = Array.isArray(conditions) ? conditions.length : null
        const isElseAnchor = conditionCount !== null && index >= conditionCount
        return isElseAnchor ? !matchedTrue : matchedTrue
      }
      // 未知 handle 但输出声明了 matched —— 默认走 true 分支语义。
      return matchedTrue
    }

    return true
  }

  /**
   * Merge inputs from multiple active incoming edges.
   *
   * - Single active input: uses Flowise convention (content string if available,
   *   otherwise the whole output object)
   * - Multiple active inputs: shallow-merges output objects. For `content`,
   *   concatenates all content strings with newlines.
   *
   * 浅合并的覆盖语义（后到 edge 赢）是历史行为，保持兼容；但 2026-09-17
   * 起多输入合并额外携带 `inputs` 数组 —— 按边序保留每路上游的完整输出，
   * 下游模板/节点可确定性取用（`inputs[0].result`），不再依赖 Object.assign
   * 的覆盖顺序。注意：上游自己输出的 `inputs` 字段会被本引擎字段覆盖。
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
    const inputs: Array<Record<string, unknown>> = []

    for (const edge of activeEdges) {
      const output = nodeOutputs.get(edge.source) ?? {}
      inputs.push(output)
      Object.assign(merged, output)
      if (typeof output.content === 'string') {
        contents.push(output.content)
      }
    }

    if (contents.length > 0) {
      merged.content = contents.join('\n')
    }
    merged.inputs = inputs

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
   * Determine if the node is a "last executable node".
   * A node is "last" when it has no outgoing edges at all. This is a pre-run
   * heuristic: edges whose sourceHandle won't match the current output cannot
   * be detected here, but it correctly handles linear DAGs and active branch
   * tails (which themselves have no outgoing edges). 并行多尾时**每个执行到
   * 的尾节点**都拿到 isLastNode=true —— 每条分支的终点各自是「最后一节
   * 点」（SSE 终帧/DirectReply 语义）；静态挑唯一尾会被条件剪枝打破
   * （被剪掉的更深尾节点 vs 实际执行的尾节点），语义钉在
   * executor-semantics.test.ts。
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
  | PendingOutcome
  | FailedOutcome

interface PendingOutcome {
  kind: 'pending'
  nodeId: string
  prompt: string
  inputType: string
  options: unknown[]
}

interface FailedOutcome {
  kind: 'failed'
  nodeId: string
  error: string
}
