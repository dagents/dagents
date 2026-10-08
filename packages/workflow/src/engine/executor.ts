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
import { HumanInputPendingError, SeedHashMismatchError, NodeRejectedError } from './errors.js'
import { RuntimeState } from './runtime.js'
import { runUserCode } from '../nodes/custom-function/user-code-exec.js'
import { computeInputHash } from '../utils/input-hash.js'
import { resolveVariables } from '../utils/variables.js'

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
  /** 会话检索器（2026-10-04）— LLM 节点 includeChatHistory 用。 */
  historyRetriever?: IExecutionContext['historyRetriever']
  /** 子流程执行器（2026-10-04）— ExecuteFlow 节点用（宿主注入，引擎 DB-free）。 */
  flowExecutor?: IExecutionContext['flowExecutor']
  /** 受控命令执行（R4，2026-10-07）— customFunction $exec 通道（宿主注入）。 */
  execRunner?: IExecutionContext['execRunner']
  /** flow 级上下文（P2a，2026-10-04）— 宿主预算预裁后的 context_md。 */
  flowContext?: string
  /**
   * Node lifecycle hooks — fire as each node starts / finishes so callers
   * (e.g. the gateway's canvas run) can persist live progress. Hooks are
   * synchronous from the executor's perspective: async work should be
   * fire-and-forget inside the callback so it never stalls a wave.
   */
  onNodeStart?: (node: { nodeId: string; nodeName: string; ordinal?: number }) => void
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
   * JournalFacade 接缝（2026-10-07 可恢复性地基，design-recover §3.1(e)）：
   * 宿主注入的 journal 读写面——引擎保持 DB-free。写入：节点终态
   * （done/failed/cached）时 recordDecision（与 onNodeEnd 相邻，落 decision
   * 行）；查询：lookup 供迭代体断点项短路寻址。resume/暖缓存的种子组装
   * 全部在 gateway 侧完成（引擎内不做 DB 查询）。
   */
  journal?: JournalFacade
  /**
   * 执行状态快照钩子（§6.2）：每波次收敛 / 迭代每项完成 / 终态前回调。
   * 同步 fire-and-forget（宿主自行节流落库），绝不阻塞调度。
   */
  onCheckpoint?: (snapshot: RunCheckpointSnapshot) => void
  /**
   * run 级 token 预算（2026-10-04）：累计 usage 越线即停机，终态
   * budget_exceeded（产出截至停机点，根因明确）——失控循环不再只靠
   * MAX_LOOP/迭代上限兜底烧钱。
   */
  tokenBudget?: number
  /**
   * 试运行模式（R10，2026-10-07，design-sharp §3.4）：透传到每个节点的
   * IExecutionContext.trialMode——http 节点据此 skip/real。缺省 = 正式执行。
   */
  trialMode?: { http: 'skip' | 'real' }
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
  /**
   * 每项 body 节点输出映射（2026-10-07 地基，design-recover §3.1(c)3）：
   * `[i][nodeId] = output`。gateway 从 journal 的 per-ordinal decision 行组装
   * 传入；引擎据此在串行路径为第 i 项预填迭代体克隆，让种子跳过机制对迭代
   * 体生效（项粒度短路）。引擎只消费不生产（快照经 progress 透传保真）。
   */
  itemNodeOutputs?: Array<Record<string, Record<string, unknown>>>
}

/** 断点续跑种子（§6.3 ResumeOptions 的载荷）。 */
export interface ResumeOptions {
  /** 已完成节点的原始引擎输出 —— 命中者跳过执行（结构保证，非 best-effort）。 */
  seedOutputs: Record<string, Record<string, unknown>>
  /** 预填充的 runtime state 顶层（含 $start 别名 / 各节点键 / humanInputs 应答）。 */
  seedRuntime?: Record<string, unknown>
  /** 迭代游标：controllerId → 进度。 */
  iterationProgress?: Record<string, IterationProgress>
  /**
   * 种子携带的 expected input_hash（2026-10-07 地基，resume 严格校验用）：
   * journal decision 行的 payload.inputHash。引擎跳过种子节点前按当前
   * runtime 预演重算对比，不一致抛 SeedHashMismatchError（AC-R1-3）。暖缓存
   * 校验在 gateway 侧已完成（不传）；checkpoint 老种子无 hash（缺省跳过
   * 校验照旧种子化，PRD R1.7）。
   */
  seedHashes?: Record<string, string>
  /** 种子来源标注（cached 钩子/journal lineage 载荷用）。 */
  seedSource?: { kind: 'resume' | 'warm-cache'; fromRunId: string }
  /**
   * 种子携带的前驱 token 用量（PRD R2.3 定稿，2026-10-08 修复）：journal
   * decision 行的 payload.tokens——cached 节点的 span.tokens 记继承值（结果
   * 面板徽章如实显示「这段产出烧了多少」）+ journal lineage 的
   * inheritedTokens（双口径对账：谱系继承累计 + 本次新增）。仅 ordinal=0
   * 根图种子（cached 钩子面）；引擎只消费不生产。
   */
  seedTokens?: Record<string, ITokenUsage | null>
}

/**
 * journal decision 行的引擎侧形状（写入条目 = 查询结果，design-recover §1.1
 * payload 契约）。持久化与 runId/flowId 补齐由宿主的 journal-writer 承载。
 */
export interface JournalDecision {
  nodeId: string
  /** per-node 执行实例序号（AD-R4）。 */
  ordinal: number
  status: 'done' | 'failed' | 'cached'
  /** AD-R3 口径指纹（computeInputHash 单源）；老种子路径可缺省。 */
  inputHash?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  tokens?: ITokenUsage | null
  resolvedModel?: string
  /** cached 决策的继承标注（R2 谱系）。 */
  lineage?: { inheritedFromRunId: string; inheritedTokens?: number }
}

/** 引擎侧 journal 接缝（宿主注入；引擎 DB-free 红线不破，§3.1(e)）。 */
export interface JournalFacade {
  recordDecision(entry: JournalDecision): void
  lookup(nodeId: string, ordinal: number): Promise<JournalDecision | null>
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
  /** 失败分支隔离（2026-10-04）：声明 isolateFailure 的失败节点记账处——
   *  非空 + 无未隔离错误 → run 终态 partial_success。 */
  isolatedFailures: string[]
  /** 已消耗 tokens（tokenBudget 对账用，2026-10-04）。 */
  tokensSpent: number
  /**
   * per-node 执行实例计数器（2026-10-07 地基，AD-R4）：nodeId → 已占位次数。
   * 节点开始执行（或种子跳过占位）时 takeOrdinal +1；迭代体并行项经
   * childCtx 展开共享同一 Map（引用传递），跨项分配天然唯一。
   */
  nodeOrdinals: Map<string, number>
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
          Object.entries(resume?.iterationProgress ?? {}).map(([k, v]) => [
            k,
            { ...v, itemOutputs: [...v.itemOutputs] },
          ]),
        ),
        rootOutputs: nodeOutputs,
        onCheckpoint: opts.onCheckpoint,
        isolatedFailures: [],
        tokensSpent: 0,
        nodeOrdinals: new Map(),
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
        // token 预算停机（2026-10-04）：与失败区分——产出截至停机点，
        // 错误消息自带对账数字，宿主据此落 budget_exceeded 终态。
        if (result.budgetExceeded) {
          this.fireCheckpoint(ctx, nodeOutputs, {
            nodeId: '',
            error: result.error,
          })
          return {
            status: 'budget_exceeded',
            executedNodes,
            finalOutput: ctx.finalOutput,
            error: result.error,
            state: runtime.snapshot(),
          }
        }
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

      // 失败分支隔离（2026-10-04）：隔离失败被记账而非中断——全部波次
      // 跑完后仍有产出（finalOutput 来自最深成功节点），终态如实标注
      // partial_success，调用方与 spans 里都能看出「有分支挂了」。
      if (ctx.isolatedFailures.length > 0) {
        this.fireCheckpoint(ctx, nodeOutputs)
        return {
          status: 'partial_success',
          executedNodes,
          finalOutput: ctx.finalOutput,
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

  /** Record a node output as the run's final output if it's topologically deepest.
   *  显式指定（2026-10-04）：节点声明 `finalOutput: true` 时压过「拓扑最深」
   *  默认——多个显式节点并存时，拓扑更深的那个赢。 */
  private recordExecution(
    ctx: RunContext,
    nodeId: string,
    output: Record<string, unknown>,
    flowNode?: FlowNode,
  ): void {
    const idx = ctx.topoIndex.get(nodeId) ?? -1
    const explicit = flowNode ? mergedNodeFlag(flowNode, 'finalOutput') === true : false
    // 显式位与大数偏移合成：显式恒胜隐式，显式之间仍按拓扑序分胜负。
    const rank = explicit ? 1_000_000_000 + idx : idx
    if (rank >= ctx.finalOutputIndex) {
      ctx.finalOutputIndex = rank
      ctx.finalOutput = output
    }
  }

  /** Build the IExecutionContext handed to one node run. */
  private buildNodeContext(
    ctx: RunContext,
    isLast: boolean,
    nodeId?: string,
    nodeName?: string,
    ordinal?: number,
  ): IExecutionContext {
    const { opts } = ctx
    return {
      chatId: opts.chatId,
      runId: opts.runId,
      state: ctx.runtime.state,
      isLastNode: isLast,
      sseStreamer: opts.sseStreamer,
      nodeOrdinal: ordinal,
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
      // 2026-10-04 新接缝：会话检索（LLM 节点 includeChatHistory）与
      // 子流程执行（ExecuteFlow 节点）——漏传会让节点拿到 undefined 而
      // 诚实报「宿主未装配」，测试逮出过一次。
      historyRetriever: opts.historyRetriever,
      flowExecutor: opts.flowExecutor,
      // R4 受控命令通道（2026-10-07）：漏传会让 customFunction 的 $exec 诚实
      // 报「宿主未提供受控执行通道」——与 historyRetriever/flowExecutor 同款
      // 接缝清单（design-permission §2.2）。
      execRunner: opts.execRunner,
      flowContext: opts.flowContext,
      // R10 试运行模式透传（design-sharp §3.4-②）：http 节点的 skip/real 短路
      // 依据；缺省 undefined = 正式执行（行为逐字不变）。
      trialMode: opts.trialMode,
    }
  }

  /** Execute one node instance (no scheduling). Throws on node failure.
   * 节点级 opt-in 重试（2026-09-17）：节点声明 `retries` 输入（0~3，缺省
   * 0 = 行为不变）时，失败自动重试并指数退避 —— LLM/HTTP 类瞬时故障的
   * 单节点自愈，不改变波次失败语义（重试耗尽仍按波次失败上报）。取消
   * 信号触发时不重试。 */
  private async runNode(
    ctx: RunContext,
    flowNode: FlowNode,
    nodeInput: unknown,
    ordinal?: number,
  ): Promise<INodeOutput> {
    const nodeInstance = this.registry.get(flowNode.data.name as string)
    if (!nodeInstance) {
      throw new Error(`Node type "${flowNode.data.name}" not registered`)
    }
    // 两种数据形态归一化：AI 生成/手工编写的 flow 把配置平铺在
    // `data.<field>`；画布编辑器（vendor/agentflow nodeFactory +
    // EditNodeDialog）把配置嵌套在 `data.inputs.<field>`。节点统一从
    // `nodeData.inputs.<field>` 读 —— 平铺键打底、嵌套 inputs 覆盖，
    // 这样画布保存后改的值生效，且老 flow 不受影响。
    const mergedInputs = mergedNodeInputs(flowNode)
    const nodeData: INodeData = {
      id: flowNode.id,
      name: flowNode.data.name as string,
      inputs: mergedInputs,
    }
    const isLast = this.isLastExecutableNode(flowNode, ctx.outgoingEdges, ctx.opts.isLastNode)
    const runCtx = this.buildNodeContext(
      ctx,
      isLast,
      flowNode.id,
      flowNode.data.name as string,
      ordinal,
    )

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
        if (ctx.opts.signal?.aborted) throw err
        if (attempt >= retries) {
          // 声明型预算耗尽归「节点拒绝」档（R9 9d，design-sharp §2.4）：
          // **仅在声明了 retries ≥ 1 且耗尽时**包装为 NodeRejectedError
          // （cause 挂原始错误）——run 走 partial_success 不整体翻红；
          // retries=0（缺省）保持原错误直抛 = run failed 红态语义原样保留
          // （未购买自愈预算的失败仍是执行失败；RM-01 e2e「失败→resume
          // 零重跑」场景不受波及）。取消信号优先直抛（取消 ≠ 拒绝档）。
          if (retries >= 1 && err instanceof Error && !(err instanceof NodeRejectedError)) {
            throw new NodeRejectedError(
              `节点被拒绝：重试 ${retries} 次后仍失败（${err.message}）`,
              { cause: err },
            )
          }
          throw err
        }
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
    preseeded?: Set<string>,
  ): Promise<{
    processed: Set<string>
    error?: string
    failedNodeId?: string
    pending?: { nodeId: string; prompt: string; inputType: string; options: unknown[] }
    /** token 预算停机标记（2026-10-04）：error 为对账消息。 */
    budgetExceeded?: boolean
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
    // 根图判定 outputs === ctx.rootOutputs；迭代体的 per-ordinal 预填
    // （2026-10-07 地基，§3.1(c)3）不能用该判据 —— 克隆里混着上游根输出，
    // 只有 preseeded 显式列出的 body 节点才按种子短路（嵌套迭代 2×2 塌成
    // 1×2 的教训对两种来源都成立）。
    const rootSeeds = outputs === ctx.rootOutputs
    const itemSeeds = preseeded ?? new Set<string>()
    if (rootSeeds || itemSeeds.size > 0) {
      for (const id of outputs.keys()) {
        if (!scope.has(id) || processed.has(id)) continue
        if (!rootSeeds && !itemSeeds.has(id)) continue
        // 种子哈希对账（§3.1(c)1）：种子携带 expected input_hash 时，跳过前
        // 用当前 runtime 对该节点做 mergeInputs + resolveVariables 预演重算
        // ——上游种子输出已在 outputs 里，预演与真实执行同路径。不一致抛
        // SeedHashMismatchError，冒泡为 run failed（AC-R1-3）。无 hash 的
        // checkpoint 老种子跳过校验照旧种子化（PRD R1.7）。
        const seedHash = rootSeeds ? ctx.opts.resume?.seedHashes?.[id] : undefined
        const flowNode = nodeById.get(id)
        if (seedHash && flowNode) {
          const incoming = this.activeIncomingEdges(ctx, id, outputs)
          const previewInput = incoming.length > 0 ? this.mergeInputs(incoming, outputs) : ctx.input
          const got = nodeInputHash(ctx, flowNode, previewInput)
          if (got !== seedHash) throw new SeedHashMismatchError(id, seedHash, got)
        }
        // cached 钩子回放（§3.1(c)2）：种子节点跳过时发 nodeEnd(cached) ——
        // span-writer 落 cached span（徽章）、live registry 发 nodeEnd 帧、
        // journal 记 cached decision（lineage 载荷）。种子占位取 ordinal
        // （AD-R4：迭代 body 第 n 项的预填占第 n 号，断点项短路键稳定）。
        const ordinal = takeOrdinal(ctx, id)
        const seedOutput = outputs.get(id) ?? {}
        const nowIso = new Date().toISOString()
        // 继承 token（PRD R2.3，2026-10-08）：cached span.tokens 记前驱
        // decision 的用量（种子组装时随 seedTokens 传入）——「这段产出烧了
        // 多少」对账可见；缺省 null（老种子无数据）。
        const seedTokens = ctx.opts.resume?.seedTokens?.[id] ?? null
        ctx.opts.onNodeEnd?.({
          nodeId: id,
          nodeName: (flowNode?.data.name as string) ?? id,
          startedAt: nowIso,
          endedAt: nowIso,
          status: 'cached',
          input: {},
          output: seedOutput,
          tokens: seedTokens,
          ordinal,
        })
        ctx.opts.journal?.recordDecision({
          nodeId: id,
          ordinal,
          status: 'cached',
          ...(seedHash ? { inputHash: seedHash } : {}),
          output: seedOutput,
          tokens: seedTokens,
          ...(ctx.opts.resume?.seedSource
            ? {
                lineage: {
                  inheritedFromRunId: ctx.opts.resume.seedSource.fromRunId,
                  ...(seedTokens?.total_tokens != null
                    ? { inheritedTokens: seedTokens.total_tokens }
                    : {}),
                },
              }
            : {}),
        })
        processed.add(id)
        for (const edge of ctx.outgoingEdges.get(id) ?? []) {
          if (scope.has(edge.target)) {
            localPending.set(edge.target, (localPending.get(edge.target) ?? 1) - 1)
          }
        }
      }
    }
    let wave = [...scope]
      .filter((id) => (localPending.get(id) ?? 0) === 0 && !processed.has(id))
      .sort(byTopo)

    while (wave.length > 0) {
      if (opts.signal?.aborted) {
        return { processed, error: 'Execution cancelled' }
      }
      // token 预算闸（2026-10-04）：波次间检查——本波内已消耗的 tokens
      // 越线就不再装配下一波（当前波成员已完成的产出保留）。
      if (opts.tokenBudget != null && ctx.tokensSpent > opts.tokenBudget) {
        return {
          processed,
          error: `Token 预算超限：已消耗 ${ctx.tokensSpent} tokens，预算 ${opts.tokenBudget}（调度器停机，产出截至停机点）`,
          budgetExceeded: true,
        }
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
          const shouldExecute = isStartNode || incoming.length > 0 || seedEntries.length > 0

          if (!shouldExecute) {
            return { kind: 'skipped', nodeId }
          }

          const nodeInput =
            seedEntries.length > 0
              ? this.mergeInputs(seedEntries, seed)
              : isStartNode
                ? ctx.input
                : this.mergeInputs(incoming, outputs)

          const startedAt = new Date().toISOString()
          // 实例序号占位（AD-R4）：节点开始执行时取号（per-node 从 0 单调递增
          // —— 非迭代节点恒 0，迭代 body 第 n 次执行 = n）。
          const ordinal = takeOrdinal(ctx, nodeId)
          try {
            opts.onNodeStart?.({ nodeId, nodeName: flowNode.data.name as string, ordinal })
            const output = await this.runNode(ctx, flowNode, nodeInput, ordinal)
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
              ordinal,
              // resolved model（2026-10-07 R8 §3.6(c)）：节点输出携带
              // （llm/platform-agent 透传；无模型语义的节点缺席）。
              ...(output.output?.resolvedModel != null &&
              typeof output.output.resolvedModel === 'string'
                ? { resolvedModel: output.output.resolvedModel }
                : {}),
            }
            executedNodes.push(executed)
            opts.onNodeEnd?.(executed)
            // journal decision（§3.1(e) 写入接缝）：节点终态与 onNodeEnd 相邻
            // 记档——inputHash 按 AD-R3 口径（配置预演 + 引擎输入原样）。
            opts.journal?.recordDecision({
              nodeId,
              ordinal,
              status: 'done',
              inputHash: nodeInputHash(ctx, flowNode, nodeInput),
              input: this.toRecord(nodeInput),
              output: output.output,
              tokens: output.usage ?? null,
              // resolved model（R8 §3.6(c)）：journal decision 载荷——
              // runs.models 聚合 / 暖缓存对账的可查面（AC-R8-4）。
              ...(output.output?.resolvedModel != null &&
              typeof output.output.resolvedModel === 'string'
                ? { resolvedModel: output.output.resolvedModel }
                : {}),
            })
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
            this.recordExecution(ctx, nodeId, output.output, flowNode)
            // token 预算对账（2026-10-04）：节点 usage 累计进 run 级账本。
            const spent = (output.usage?.total_tokens as number | undefined) ?? 0
            if (Number.isFinite(spent) && spent > 0) ctx.tokensSpent += Math.trunc(spent)
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
            // 节点拒绝分类（R9 9d，design-sharp §2.4）：声明型超限
            // （NodeRejectedError）→ isolated 恒真（**不读节点
            // isolateFailure 声明、由错误类型决定**），span 状态落
            // 'rejected'（可重试黄警档）——后续既有管道把它并入
            // ctx.isolatedFailures → run 终态 partial_success，不整体翻红。
            const rejected = err instanceof NodeRejectedError
            // 被看门狗清理/取消的 CLI 调用把已产生的 usage 附着在错误
            // 对象上（见 gateway createCliLlmClient）—— 失败节点的 span
            // 也能如实记录烧掉的 tokens，而不是恒 0。
            const errUsage = (err as { usage?: ITokenUsage }).usage
            const executed: IExecutedNode = {
              nodeId,
              nodeName: flowNode.data.name as string,
              startedAt,
              endedAt: new Date().toISOString(),
              status: rejected ? 'rejected' : 'failed',
              input: this.toRecord(nodeInput),
              output: {},
              tokens: errUsage ?? null,
              error: message,
              ordinal,
            }
            executedNodes.push(executed)
            opts.onNodeEnd?.(executed)
            // 失败也是终态：decision 记档（resume 种子过滤 status IN done/cached，
            // failed 行不进种子，但「试过且失败」的事实入档；rejected 同记
            // failed——拒绝对 resume 语义同样是终态失败）。
            opts.journal?.recordDecision({
              nodeId,
              ordinal,
              status: 'failed',
              inputHash: nodeInputHash(ctx, flowNode, nodeInput),
              input: this.toRecord(nodeInput),
              tokens: errUsage ?? null,
            })
            // 失败分支隔离（2026-10-04）：节点声明 isolateFailure 时，失败
            // 只塌缩本分支（无产出 → 下游自然剪枝），不中断整个 run。
            // rejected 失败视同 isolated（由错误类型决定，不读声明）。
            const isolated = rejected || mergedNodeFlag(flowNode, 'isolateFailure') === true
            return { kind: 'failed', nodeId, error: message, isolated, rejected }
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

      const failure = outcomes.find((o): o is FailedOutcome => o.kind === 'failed' && !o.isolated)
      const isolatedFailures = outcomes.filter(
        (o): o is FailedOutcome => o.kind === 'failed' && o.isolated === true,
      )
      if (isolatedFailures.length > 0) {
        // 隔离失败记账（2026-10-04）：不中断——节点仍进 processed/released，
        // 其下游因拿不到输出而走 skipped 传递剪枝。
        for (const o of isolatedFailures) ctx.isolatedFailures.push(o.nodeId)
      }
      if (failure) {
        for (const o of outcomes) processed.add(o.nodeId)
        return { processed, error: failure.error, failedNodeId: failure.nodeId }
      }

      // token 预算闸（2026-10-04）：波次结算后对账——本波把账目推过线就
      // 地停机（产出截至本波，错误消息带对账数字）。顶部检查覆盖「续跑
      // 种子已超线」的启动态。
      if (opts.tokenBudget != null && ctx.tokensSpent > opts.tokenBudget) {
        for (const o of outcomes) processed.add(o.nodeId)
        return {
          processed,
          error: `Token 预算超限：已消耗 ${ctx.tokensSpent} tokens，预算 ${opts.tokenBudget}（调度器停机，产出截至停机点）`,
          budgetExceeded: true,
        }
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
          // 拒绝档（R9 9d）：兜底路径的迭代超限同样不翻红——控制器计入
          // isolatedFailures（partial_success），错误消息透传给 runError。
          if (iterationResult.rejected) {
            ctx.isolatedFailures.push(o.nodeId)
            continue
          }
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
   * Execute an iteration controller's body once per item.
   * Each iteration runs the body sub-DAG against a fresh clone of the
   * global outputs (minus the controller's raw output, so entry edges
   * resolve via the per-iteration seed: the current item wrapped in the
   * content-string convention). Iteration metadata is merged into runtime
   * state so prompts can reference it via template variables.
   *
   * 2026-10-04 两项新语义（多人格优化轮）：
   *  - `concurrency` 输入（默认 1 = 原串行行为）：有界并行逐项执行——
   *    每项拿独立的 runtime 覆盖层与 executedNodes 收集器，完成后按项序
   *    归并（executedNodes 确定性 + runtime「最后完成项覆盖」语义保持）。
   *    体内嵌套迭代控制器时强制串行（嵌套隔离语义复杂度不值当）。
   *  - `whileCondition` 输入（JS 表达式，经 user-code-exec 硬化求值）：
   *    每项完成后对当前聚合状态求值，真值即停止剩余项（受 maxIterations
   *    硬顶约束的「循环直到 X」原生表达），聚合输出带 earlyExit 标记。
   */
  private async runIterationBody(
    ctx: RunContext,
    controller: FlowNode,
    plan: IterationPlan,
    globalOutputs: Map<string, Record<string, unknown>>,
  ): Promise<{ output: Record<string, unknown>; error?: string; rejected?: boolean }> {
    const { runtime, topoIndex } = ctx
    const controllerOutput = globalOutputs.get(controller.id) ?? {}
    // 纵深防御：IterationNode.run 已在节点侧对超上限抛 NodeRejectedError
    // （span 带 'rejected' 终态，R9 9d），这里兜住绕过节点校验直接进入
    // body 计划的路径 —— 同值同语义（rejected = 节点拒绝档，run 不翻红）。
    const MAX_ITERATION_ITEMS = 100
    if (plan.items.length > MAX_ITERATION_ITEMS) {
      return {
        output: {},
        rejected: true,
        error:
          `节点被拒绝：Iteration 节点「${controller.data?.name ?? controller.id}」的列表有 ` +
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

    // ── 并发与提前收敛配置（2026-10-04）──
    const MAX_ITEM_CONCURRENCY = 8
    const concurrencyRaw = Number(mergedNodeFlag(controller, 'concurrency'))
    const concurrency = Number.isFinite(concurrencyRaw)
      ? Math.min(Math.max(Math.trunc(concurrencyRaw), 1), MAX_ITEM_CONCURRENCY)
      : 1
    const whileConditionRaw = mergedNodeFlag(controller, 'whileCondition')
    const whileCondition =
      typeof whileConditionRaw === 'string' && whileConditionRaw.trim().length > 0
        ? whileConditionRaw.trim()
        : null
    const hasNestedController = [...plan.body].some((id) =>
      ITERATION_CONTROLLERS.has(ctx.nodeById.get(id)?.data?.name as string),
    )
    const parallel = concurrency > 1 && !hasNestedController && whileCondition == null
    let earlyExit = false

    /** whileCondition 求值（硬化执行）：真值 = 停止调度剩余项。 */
    const shouldStopEarly = async (): Promise<boolean> => {
      if (!whileCondition) return false
      try {
        const verdict = await runUserCode(
          `return (${whileCondition})`,
          lastBodyOutput,
          typeof lastBodyOutput.content === 'string'
            ? lastBodyOutput.content
            : JSON.stringify(lastBodyOutput),
          runtime.snapshot(),
          { signal: ctx.opts.signal, timeoutMs: 2_000 },
        )
        return verdict === true
      } catch (err) {
        throw new Error(
          `Iteration 节点「${controller.data?.name ?? controller.id}」的 whileCondition 求值失败：` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (parallel) {
      // ── 有界并行：每项独立 runtime 覆盖层 + executedNodes 收集器 ──
      const itemOutputsByIdx = new Map<number, Record<string, unknown>>()
      const itemExecutedByIdx = new Map<number, IExecutedNode[]>()
      const itemRuntimeByIdx = new Map<number, Record<string, unknown>>()
      const doneIdx = new Set<number>()
      let nextIdx = completed
      let stopped = false
      let failError: string | null = null

      const runItem = async (i: number): Promise<void> => {
        const item = plan.items[i]
        const seedValue: Record<string, unknown> = {
          content: typeof item === 'string' ? item : JSON.stringify(item),
          item,
          iterationIndex: i,
        }
        const seed = new Map<string, Record<string, unknown>>([[controller.id, seedValue]])
        const childRuntime = new RuntimeState()
        childRuntime.merge(runtime.snapshot())
        childRuntime.merge({
          iterationIndex: i,
          iterationCount: count,
          iterationItem: item ?? null,
          iteration: item ?? null,
        })
        const childCtx: RunContext = {
          ...ctx,
          runtime: childRuntime,
          executedNodes: [],
          isolatedFailures: [],
          tokensSpent: 0,
        }
        const iterationOutputs = new Map(globalOutputs)
        iterationOutputs.delete(controller.id)
        const result = await this.runWaves(
          childCtx,
          plan.body,
          plan.entryEdges,
          iterationOutputs,
          seed,
        )
        // 聚合对账：tokens 与隔离失败回父账本（并行内的越限在下一波次闸收敛）
        ctx.tokensSpent += childCtx.tokensSpent
        ctx.isolatedFailures.push(...childCtx.isolatedFailures)
        itemExecutedByIdx.set(i, childCtx.executedNodes)
        itemRuntimeByIdx.set(i, childRuntime.snapshot())
        if (result.error) {
          failError = result.error
          stopped = true
          return
        }
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
        itemOutputsByIdx.set(i, iterationFinal)
        doneIdx.add(i)
      }

      const inFlight = new Set<Promise<void>>()
      while (!stopped && nextIdx < count) {
        if (ctx.opts.signal?.aborted) break
        while (inFlight.size < concurrency && nextIdx < count && !stopped) {
          const p = runItem(nextIdx).finally(() => inFlight.delete(p))
          inFlight.add(p)
          nextIdx += 1
        }
        if (inFlight.size > 0) await Promise.race(inFlight)
      }
      if (inFlight.size > 0) await Promise.allSettled(inFlight)

      if (failError) return { output: {}, error: failError }

      // 按项序归并：executedNodes 确定性、游标只沿「连续完成前缀」推进
      //（并行竞态下跳号完成项不进游标——断点续跑不产生洞，代价是极端
      // 情况下个别已完项重跑，正确性优先）。runtime 取最高完成项的覆盖层
      //（与串行「最后一项的写键留存」语义一致）。
      for (let i = completed; i < count; i++) {
        if (!doneIdx.has(i)) break
        for (const rec of itemExecutedByIdx.get(i) ?? []) ctx.executedNodes.push(rec)
        iterations.push(itemOutputsByIdx.get(i) ?? {})
        completed = i + 1
        lastBodyOutput = itemOutputsByIdx.get(i) ?? {}
        ctx.iterationProgress.set(controller.id, {
          completed,
          itemOutputs: [...iterations],
          ...(progress.itemNodeOutputs ? { itemNodeOutputs: progress.itemNodeOutputs } : {}),
        })
      }
      const highestDone = Math.max(-1, ...[...doneIdx.values()])
      if (highestDone >= 0) {
        const snap = itemRuntimeByIdx.get(highestDone)
        if (snap) {
          runtime.merge(snap)
        }
      }
    } else {
      // ── 串行（默认）：原语义 + whileCondition 提前收敛 ──
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
        // per-ordinal 种子预填（2026-10-07 地基，§3.1(c)3）：progress.
        // itemNodeOutputs[i] 的 body 节点输出预填进本项克隆，runWaves 按
        // preseeded 短路（断点项的 body 不重跑，占原 ordinal）。仅串行路径；
        // 嵌套迭代 v1 不承诺 per-ordinal 短路（内层控制器每轮重置游标）。
        const preseeded = new Set<string>()
        const prefill = progress.itemNodeOutputs?.[i]
        if (prefill) {
          for (const [pid, pout] of Object.entries(prefill)) {
            if (!plan.body.has(pid)) continue
            iterationOutputs.set(pid, pout)
            preseeded.add(pid)
          }
        }
        const result = await this.runWaves(
          ctx,
          plan.body,
          plan.entryEdges,
          iterationOutputs,
          seed,
          preseeded,
        )
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
        // 游标增量维护 + 快照（§6.2：迭代每项完成后）。itemNodeOutputs 是
        // gateway 组装的 per-ordinal 种子载荷——引擎不生产只透传（快照保真，
        // 崩溃后 resume 仍能拿到断点项种子）。
        ctx.iterationProgress.set(controller.id, {
          completed,
          itemOutputs: [...iterations],
          ...(progress.itemNodeOutputs ? { itemNodeOutputs: progress.itemNodeOutputs } : {}),
        })
        if (ctx.onCheckpoint && ctx.rootOutputs === globalOutputs) {
          this.fireCheckpoint(ctx, globalOutputs)
        }

        // whileCondition（2026-10-04）：真值即停止剩余项——「循环直到 X」
        // 的原生表达（仍受 items 数量硬顶约束）。
        if (await shouldStopEarly()) {
          earlyExit = true
          break
        }
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
        ...(earlyExit ? { earlyExit: true } : {}),
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
    // 委托模块级单源实现（2026-10-07 R2 暖缓存提取，design-recover §3.7(b)3）：
    // gateway 的 buildWarmCacheSeed 需要与引擎完全同源的活动边判定/输入合并
    // ——口径漂移即 inputHash 漂移（误杀/漏杀种子），单点抽取。
    return shouldExecuteEdge(edge, nodeOutput, sourceNode)
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
    // 委托模块级单源实现（同 shouldExecuteEdge 的提取理由）。
    return mergeInputs(activeEdges, nodeOutputs)
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
/**
 * 多入边合并的 content 拼接上限（2026-10-04）：N 路上游的正文无界拼接
 * 会撑爆下游 LLM 的上下文（宽扇入图的静默炸弹）。超限保头尾 + 中间省略
 * 标记（带对账数字，不静默截断）；完整内容仍在 `inputs` 数组里，下游
 * 模板可显式取用。默认 64KB，DAGENTS_MERGE_CONTENT_CAP 可调（0 = 不限）。
 */
const MERGE_CONTENT_CAP = (() => {
  const raw = Number(process.env.DAGENTS_MERGE_CONTENT_CAP)
  return Number.isFinite(raw) && raw >= 0 ? raw : 65_536
})()

function capJoinedContent(contents: string[]): string {
  const joined = contents.join('\n')
  if (MERGE_CONTENT_CAP === 0 || joined.length <= MERGE_CONTENT_CAP) return joined
  const head = Math.floor(MERGE_CONTENT_CAP * 0.6)
  const tail = Math.floor(MERGE_CONTENT_CAP * 0.4)
  const omitted = joined.length - head - tail
  return (
    joined.slice(0, head) +
    `\n\n[合并截断：${contents.length} 路上游共 ${joined.length} 字符，超出上限 ${MERGE_CONTENT_CAP}，` +
    `中间省略约 ${omitted} 字符——完整内容见本输入的 inputs 数组]\n\n` +
    joined.slice(joined.length - tail)
  )
}

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
  /** 失败分支隔离（2026-10-04）：节点声明 isolateFailure 时为 true。 */
  isolated?: boolean
  /** 节点拒绝（R9 9d）：声明型超限（NodeRejectedError）——恒伴随 isolated。 */
  rejected?: boolean
}

/**
 * 读节点配置旗标（平铺 `data.<key>` 打底、嵌套 `data.inputs.<key>` 覆盖
 * —— 与 runNode 的双形态归一化同语义）。返回原值，调用方自行判 true。
 */
function mergedNodeFlag(flowNode: FlowNode, key: string): unknown {
  const flat = flowNode.data as Record<string, unknown> | undefined
  const nested = flat?.inputs as Record<string, unknown> | undefined
  if (nested && typeof nested === 'object' && nested[key] !== undefined) return nested[key]
  return flat?.[key]
}

/**
 * 节点 mergedInputs（平铺 `data.<field>` 打底、嵌套 `data.inputs.<field>`
 * 覆盖）——runNode 的节点数据归一化与 hash 预演（nodeInputHash）共用同源，
 * 口径漂移即 hash 漂移，单点抽取。
 *
 * 2026-10-07 R2 暖缓存（design-recover §3.7(b)3）：导出给 gateway 的
 * buildWarmCacheSeed——预演与真实执行的配置归一必须是同一个函数。
 */
export function mergedNodeInputs(flowNode: FlowNode): Record<string, unknown> {
  const flat = (flowNode.data ?? {}) as Record<string, unknown>
  const nested = flat.inputs
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...flat, ...(nested as Record<string, unknown>) }
  }
  return { ...flat }
}

/**
 * resolveVariables 预演（AD-R3）：深拷贝后对字符串逐个解析——**只用于 hash，
 * 不改变传给节点的输入**。未引用变量保持字面量（与节点侧解析行为一致，
 * 同一函数保证预演与真实解析的口径是同一个）。
 *
 * 2026-10-07 R2：导出理由同 mergedNodeInputs（暖缓存预演同源）。
 */
export function previewResolved(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === 'string') return resolveVariables(value, state)
  if (Array.isArray(value)) return value.map((item) => previewResolved(item, state))
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = previewResolved(v, state)
    }
    return out
  }
  return value
}

// ── 暖缓存预演单源（2026-10-07 R2，design-recover §3.7(b)3）──
// 从 class private 提取的模块级实现：活动边判定与多入边合并的真实执行语义。
// gateway 的 buildWarmCacheSeed 沿谱系链预演「命中节点用旧输出、miss 节点
// 无输出」的一致世界线时，必须与引擎 runWaves 的实际调度完全同源——
// 判定漂移即 inputHash 漂移（误杀/漏杀种子，比浪费更严重）。

/** 活动边判定（单源；语义见 DagExecutor.shouldExecuteEdge 的 jsdoc）。 */
export function shouldExecuteEdge(
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
    const anchorMatch = sourceNode
      ? /^-output-(\d+)$/.exec(handle.replace(sourceNode.id, ''))
      : null
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

/** 多入边合并（单源；语义见 DagExecutor.mergeInputs 的 jsdoc）。 */
export function mergeInputs(
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
    merged.content = capJoinedContent(contents)
  }
  merged.inputs = inputs

  return merged
}

/** AD-R3 口径的节点输入指纹：nodeType + 配置预演 + 引擎输入原样（单源）。 */
function nodeInputHash(ctx: RunContext, flowNode: FlowNode, nodeInput: unknown): string {
  return computeInputHash({
    nodeType: String(flowNode.data?.name ?? ''),
    resolvedConfig: previewResolved(mergedNodeInputs(flowNode), ctx.runtime.state),
    nodeInput,
  })
}

/** 占用该节点的下一个执行实例序号（AD-R4：从 0 单调递增）。 */
function takeOrdinal(ctx: RunContext, nodeId: string): number {
  const next = ctx.nodeOrdinals.get(nodeId) ?? 0
  ctx.nodeOrdinals.set(nodeId, next + 1)
  return next
}
