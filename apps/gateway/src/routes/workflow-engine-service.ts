import {
  DagExecutor,
  NodeRejectedError,
  type FlowData,
  type IExecutionContext,
  type PlatformAgentConfig,
  resolveNodeType,
} from '@dagents/workflow'
import { NodeRegistry } from '@dagents/workflow'
import type { Logger } from '@dagents/shared'
import { runQuery } from '@dagents/db'
import type { RunStatus, RunStopReason } from '@dagents/db'
import { allNodes } from '@dagents/workflow'
import { makeIncrementalSpanWriter, type IncrementalSpanWriter } from '../span-writer.js'
import { forRunLive, allocRunLiveSeq, type RunLiveTap } from '../run-live-registry.js'
import { makeJournalWriter, type JournalWriter } from '../journal-writer.js'
import { getFlowById } from '../repositories/workflows.repo.js'
import { composeSystemPrompt } from '../skill-injection.js'
import { getChatContextSummary, CHAT_SUMMARY_MAX_CHARS } from '../lib/chat-context-summary.js'
import { declareCounter } from '../lib/metrics.js'
// R4 受控命令通道宿主侧（no-shell spawn + 闸 + 超时强杀 + viaShell 拒）
import { runControlledExec } from '../lib/controlled-exec.js'
import {
  createDefaultLlmClient,
  createAgentFetcher,
  createBuiltInToolRegistry,
  resetProviderCache,
} from './workflow-clients.js'

/**
 * 工作流引擎装配单一来源（2026-09-17 评审收敛）。
 *
 * 此前「NodeRegistry + DagExecutor + CLI-first clients + spanWriter」这段
 * 装配在三个入口各复制一份（workflows.ts 画布直跑 / chats.ts chat 流式 /
 * chat-execute.ts @flow），行为差异不是设计而是复制漂移的产物 —— @flow
 * 路径漏接 spanWriter 就是这么来的（该运行在画布旁观里永远「无进度」）。
 * 三个入口现在共用本函数；入口特有差异（sseStreamer / humanInputResolver
 * / 静态预供答案）由调用方在 baseOptions 之上 spread 合并。
 */

// 组装字节可观测（P3）：LLM/Agent 节点的 contextBudget 对账 → 按节点类型
// 累计（count + 总字符），"谁在吃上下文"从推断变成曲线。
const assembledNodesTotal = declareCounter(
  'dagents_llm_assembled_nodes_total',
  'LLM nodes assembled with a context budget report, by node type',
  ['nodeType'],
)
const assembledCharsTotal = declareCounter(
  'dagents_llm_assembled_chars_total',
  'Total assembled context characters reported by LLM nodes, by node type',
  ['nodeType'],
)
const assembledOverBudgetTotal = declareCounter(
  'dagents_llm_assembled_over_budget_total',
  'LLM nodes whose fixed (system+prompt+schema) block alone exceeded the context cap',
  ['nodeType'],
)

export interface AssembleWorkflowEngineOptions {
  flowData: FlowData
  runId: string
  flowId: string
  /** CLI 工作目录（项目目录语境）；缺省时 CLI 在网关进程 cwd 执行。 */
  cwd?: string
  /** 调用方 logger（span-writer 依赖注入，必传）。 */
  logger: Logger
  /** 会话 id（historyRetriever 的检索锚点；缺省用 runId）。 */
  chatId?: string
  /** 子流程嵌套深度（根图 = 0；flowExecutor 递归装配时 +1，上限 3）。 */
  subflowDepth?: number
  /** flow 级上下文（P2a）：flows.context_md 原文——这里按子预算预裁后注入。 */
  flowContextMd?: string | null
  /** 祖先 flowId 链（防子流程环引用；根图 = 空）。 */
  ancestorFlowIds?: ReadonlySet<string>
  /**
   * LLM client 覆盖注入位（R10 试运行，design-sharp §3.4-②）：非空时整个
   * 引擎的 llmClient 用它（fake mock client），不经 llm_providers、不动
   * active 行——试运行后正式 run 仍走原 provider。其他入口不传 = 行为
   * 逐字不变（resetProviderCache 对 fake 注入无害空转）。
   */
  llmClientOverride?: IExecutionContext['llmClient']
  /**
   * persona 冻结快照（R8/AD-R6，design-recover §3.6(b)）：
   *  - 直跑路径：调用方先 `await snapshotFlowAgents(flowData)` 传入（run
   *    创建期读一次 agents 行——run 执行中改人格不再影响本 run）；
   *  - resume/answer 路径：读 runs.frozen_agents 注入（跨进程冻结，
   *    AC-R8-2——agent 行已删/改不影响续跑）。
   * 缺省 = 不冻结（沿用实时 fetcher 的既有行为，chat 流式等旧路径兼容）。
   * 载荷形状：`{ [agentId]: PlatformAgentConfig }` + 可选 `sessions` 键
   * （deriveSessionId → 后端真实会话 id 的映射，跨进程重挂查表）。
   */
  frozenAgents?: Record<string, unknown> | null
}

export interface AssembledWorkflowEngine {
  executor: DagExecutor
  /** 增量节点进度（run_node_spans）；onNodeStart/End/Delta 已并入 baseOptions。 */
  spanWriter: IncrementalSpanWriter
  /** 运行实时终端的发射入口（与 spanWriter 同源旁路）；执行路径 settle
   *  时调用 `live.finish(runStatus, stopReason?)` 上报终态（漏报由注册表清扫器兜底）。 */
  live: RunLiveTap
  /** journal 写侧单点（R1/R7，§3.4）：ExecuteOptions.journal 接缝的实现，
   *  已并入 baseOptions；执行路径 settle 时调 `journal.close()` flush delta 微批。 */
  journal: JournalWriter
  /** persona 冻结快照（R8 §3.6(b)）：执行路径 persist 时落 runs.frozen_agents
   *  （快照 + collectRunSessions 的会话映射）。null = 无快照（不冻结的路径）。 */
  frozenAgents: Record<string, unknown> | null
  /** 节点 label/type 查找表（事后批量落库 spans 时复用）。 */
  nodeLabelById: Map<string, string | null>
  nodeTypeById: Map<string, string | null>
  /** executor.execute 的公共基座参数 —— 调用方 spread 后叠加自己的字段。 */
  baseOptions: {
    /** 引擎接口形状（R10 试运行起 llmClientOverride 可注入 fake client）。 */
    llmClient: IExecutionContext['llmClient']
    agentFetcher: ReturnType<typeof createAgentFetcher>
    toolRegistry: ReturnType<typeof createBuiltInToolRegistry>
    historyRetriever: IExecutionContext['historyRetriever']
    flowExecutor: IExecutionContext['flowExecutor']
    /** R4 受控命令通道（customFunction $exec）——controlled-exec.ts 受控 spawn。 */
    execRunner: IExecutionContext['execRunner']
    flowContext?: string
    onNodeStart: IncrementalSpanWriter['onNodeStart']
    onNodeEnd: IncrementalSpanWriter['onNodeEnd']
    onNodeDelta: IncrementalSpanWriter['onNodeDelta']
    /** 引擎 journal 接缝（§3.1(e)）：decision 行写入 + 迭代断点 lookup。 */
    journal: JournalWriter
  }
}

/** 子流程嵌套上限（防自引用/互相引用的死循环烧钱）。 */
const MAX_SUBFLOW_DEPTH = 3

export function assembleWorkflowEngine(
  opts: AssembleWorkflowEngineOptions,
): AssembledWorkflowEngine {
  const registry = new NodeRegistry()
  registry.registerMany(allNodes())
  const executor = new DagExecutor(registry)

  // Reset the LLM provider cache so each run picks up the latest config.
  resetProviderCache()
  // CLI-first：配了 provider 走 HTTP（加速），否则 LLM/Agent 节点全部跑
  // 本地 CLI —— 与聊天一致零配置可用。试运行（R10）经 llmClientOverride
  // 整体换装 fake mock client（design-sharp §3.4-②）。
  // initialSessions（R8 §3.6(a)）：frozenAgents.sessions 的会话映射——
  // CLI 查表透传 --resume（跨进程后端会话延续，claude 档）。
  const frozenSessions =
    (opts.frozenAgents?.['sessions'] as Record<string, string> | undefined) ?? undefined
  const llmClient =
    opts.llmClientOverride ??
    createDefaultLlmClient('claude', {
      cwd: opts.cwd,
      runId: opts.runId,
      ...(frozenSessions ? { initialSessions: frozenSessions } : {}),
    })
  // persona 冻结（R8 §3.6(b)，AC-R8-2）：frozenAgents 注入时整个 run 用闭包
  // 快照 fetcher——run 执行中/跨进程改人格不再影响本 run；缺省沿用实时
  // fetcher（行为不变）。不回写 agents 表（与 agent-library drift 语义划界）。
  const liveFetcher = createAgentFetcher()
  const frozenSnapshot = opts.frozenAgents ?? null
  const agentFetcher: typeof liveFetcher = frozenSnapshot
    ? async (agentId) =>
        (frozenSnapshot[agentId] as Awaited<ReturnType<typeof liveFetcher>> | undefined) ?? null
    : liveFetcher
  const toolRegistry = createBuiltInToolRegistry()
  const historyRetriever = createHybridHistoryRetriever()

  // flow 级上下文（P2a）：按子预算预裁（DAGENTS_FLOW_CONTEXT_CAP，默认 8KB）
  // ——引擎/节点不再感知体积。dsh 取舍序：这是「最特定」的注入块。
  const FLOW_CONTEXT_CAP = (() => {
    const raw = Number(process.env.DAGENTS_FLOW_CONTEXT_CAP)
    return Number.isFinite(raw) && raw > 0 ? raw : 8192
  })()
  const rawCtx = (opts.flowContextMd ?? '').trim()
  const flowContext =
    rawCtx.length <= FLOW_CONTEXT_CAP
      ? rawCtx
      : rawCtx.slice(0, Math.floor(FLOW_CONTEXT_CAP * 0.85)) +
        `\n[流程上下文截断：原文 ${rawCtx.length} 字符，上限 ${FLOW_CONTEXT_CAP}]`
  if (rawCtx.length > FLOW_CONTEXT_CAP) {
    opts.logger.warn('flow context truncated to cap', {
      flowId: opts.flowId,
      rawChars: rawCtx.length,
      cap: FLOW_CONTEXT_CAP,
    })
  }

  // 子流程执行器（2026-10-04 ExecuteFlow 复活）：引擎侧 DB-free，这里持有
  // flows 表访问。递归装配同 runId 的子引擎——spans 自然并入同一 run 的
  // 增量写入（旁观/轨迹无缝）；深度与祖先链守卫防环引用。
  const depth = opts.subflowDepth ?? 0
  const ancestors = new Set(opts.ancestorFlowIds ?? [])
  ancestors.add(opts.flowId)
  const flowExecutor: NonNullable<IExecutionContext['flowExecutor']> = async (
    flowId,
    input,
    execOpts,
  ) => {
    if (flowId === opts.flowId || ancestors.has(flowId)) {
      throw new Error('子流程不能引用自身或其祖先链（环引用防护）')
    }
    if (depth + 1 > MAX_SUBFLOW_DEPTH) {
      // 声明型超限 = 节点拒绝档（R9 9d，design-sharp §2.4）：错误穿越
      // flowExecutor 到引擎 catch，分类标记随错误对象走（无需引擎感知
      // gateway）——run 走 partial_success，ExecuteFlow 节点 span 'rejected'。
      throw new NodeRejectedError(`节点被拒绝：子流程嵌套超过 ${MAX_SUBFLOW_DEPTH} 层上限`)
    }
    const row = await getFlowById(flowId)
    if (!row) throw new Error(`子流程 ${flowId} 不存在（可能已被删除）`)
    const flowData = row.flow_data as FlowData
    if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
      throw new Error(`子流程 ${flowId} 的 flow 数据无效`)
    }
    const sub = assembleWorkflowEngine({
      flowData,
      runId: opts.runId,
      flowId,
      cwd: opts.cwd,
      logger: opts.logger,
      chatId: opts.chatId,
      subflowDepth: depth + 1,
      ancestorFlowIds: ancestors,
      flowContextMd: opts.flowContextMd,
    })
    const result = await sub.executor.execute(flowData, input, {
      ...sub.baseOptions,
      chatId: opts.chatId ?? opts.runId,
      runId: opts.runId,
      state: {},
      isLastNode: true,
      signal: execOpts.signal,
    })
    sub.live.finish(toRunStatus(result.status).status)
    return { output: result.finalOutput ?? {}, status: result.status }
  }

  // 节点 label/type 查找表：span 携带画布 inspector 同款人类可读元数据。
  // nodeType 用引擎同款解析（resolveNodeType：data.name 优先、type 回退，
  // 2026-09-22 单源化）—— 此前直接写画布渲染类型，画布保存的 flow 恒为
  // 'customNode'，console 终端 `$` 提示行随之退化成无信息的 "$ customNode"。
  const nodeLabelById = new Map<string, string | null>()
  const nodeTypeById = new Map<string, string | null>()
  for (const n of opts.flowData.nodes) {
    nodeLabelById.set(n.id, (n.data as { label?: string })?.label ?? n.id)
    nodeTypeById.set(n.id, resolveNodeType(n) ?? n.type ?? 'customNode')
  }
  const spanWriter = makeIncrementalSpanWriter({
    runId: opts.runId,
    flowId: opts.flowId,
    nodeLabelById,
    nodeTypeById,
    log: opts.logger,
  })

  // 运行实时终端（live attach）：钩子与 span-writer 组合旁路 —— 引擎的
  // start/end/delta（含插话回显：sink.onDelta 即引擎绑定的 onNodeDelta）
  // 一份进 DB 节流落库，一份进进程内帧缓冲实时分发。run 的 settle 由各
  // 执行路径显式 live.finish(status, stopReason?) 上报（漏报由注册表清扫器
  // 兜底收敛）。
  // journal 写侧（2026-10-07 R1/R7，§3.4）：结构帧 write-through 先落库后
  // 发帧、delta 帧 write-behind 微批、decision 行 onNodeEnd 相邻写入——
  // seq 取号与 emit 同一 per-run 计数器（allocRunLiveSeq，AD-R5 单写者）。
  // 注意构造顺序：writer 先建（allocSeq 闭包懒求值），forRunLive 后拿
  // （此时 entry 已创建，取号链路闭合）。
  const journal = makeJournalWriter({
    runId: opts.runId,
    flowId: opts.flowId,
    allocSeq: () => allocRunLiveSeq(opts.runId),
  })
  const live = forRunLive(
    opts.runId,
    opts.flowId,
    (nodeId) => nodeTypeById.get(nodeId) ?? null,
    journal,
  )

  return {
    executor,
    spanWriter,
    live,
    journal,
    frozenAgents: frozenSnapshot,
    nodeLabelById,
    nodeTypeById,
    baseOptions: {
      llmClient,
      agentFetcher,
      toolRegistry,
      historyRetriever,
      flowExecutor,
      // R4 受控命令通道（2026-10-07）：宿主注入 execRunner——一处注入，
      // 画布直跑 / chat 流式 / @flow / resume / 子流程递归装配全部路径
      // 自动继承（子引擎同函数递归构造）。cwd 与 CLI 节点同源（runCwd）。
      execRunner: (req) => runControlledExec(req, { cwd: opts.cwd }),
      flowContext: flowContext.length > 0 ? flowContext : undefined,
      journal,
      onNodeStart: (n) => {
        spanWriter.onNodeStart(n)
        live.nodeStart(n)
      },
      onNodeEnd: (n) => {
        spanWriter.onNodeEnd(n)
        live.nodeEnd(n)
        // P3 可观测：contextBudget 对账上指标（无账目的节点零开销跳过）
        const budget = (
          n.output as
            | { contextBudget?: { totalCharsLikeNever?: never } & Record<string, unknown> }
            | undefined
        )?.contextBudget as
          | {
              inputChars?: number
              historyChars?: number
              fixedChars?: number
              overBudget?: boolean
            }
          | undefined
        if (budget) {
          const nodeType = nodeTypeById.get(n.nodeId) ?? 'unknown'
          const total =
            (budget.inputChars ?? 0) + (budget.historyChars ?? 0) + (budget.fixedChars ?? 0)
          assembledNodesTotal.inc(1, { nodeType })
          assembledCharsTotal.inc(total, { nodeType })
          if (budget.overBudget) assembledOverBudgetTotal.inc(1, { nodeType })
        }
      },
      onNodeDelta: (n, chunk) => {
        spanWriter.onNodeDelta(n, chunk)
        live.delta(n, chunk)
      },
    },
  }
}

/**
 * 引擎执行状态 → runs 行 status（三入口共用映射，防再漂移）。
 * 2026-10-04：partial_success（失败分支隔离后的有产出终态）与
 * budget_exceeded（token 预算停机）作为独立终态如实落库——runs.status
 * 是 text 列，console 侧按标签映射渲染。
 *
 * 2026-10-07 可恢复性第 1 批（design-recover §3.3(a)，cancelled→stopped
 * 写新翻转）：引擎 cancelled 翻译为 `stopped(stop_reason)`，来源由
 * `ctx.superseded` 判定（user / superseded，AD-R7）；存量 cancelled 行
 * 不迁移，读侧双读（NFR-1）。resume-execution.ts 的手写三元链已收敛到
 * 本单源（AC-R3-3 三入口一致：直跑 workflows.ts / resume / answer）。
 * RunStatus 九态与迁移 1720000111000 的 CHECK 同源。
 */
export function toRunStatus(
  executionStatus: string,
  ctx?: { superseded?: boolean },
): { status: RunStatus; stopReason?: RunStopReason } {
  if (executionStatus === 'success') return { status: 'completed' }
  if (executionStatus === 'cancelled') {
    return { status: 'stopped', stopReason: ctx?.superseded ? 'superseded' : 'user' }
  }
  if (executionStatus === 'partial_success') return { status: 'partial_success' }
  if (executionStatus === 'budget_exceeded') return { status: 'budget_exceeded' }
  return { status: 'failed' }
}

/**
 * abort 信号的中止来源分类（design-recover §3.3(b)，R3.2 归属）：
 * `superseded` = chat 域 latest-wins（execution-registry register 时
 * `abort('superseded by a new execution in this chat')` 使 signal.reason
 * 携带该串）；其余（用户取消 / shutdown）一律 `user`。写侧
 * `stopped(stop_reason)` 的归属判定单源——单测钉住（AC-R3-3）。
 */
export function classifyAbortReason(signal: AbortSignal | undefined): 'user' | 'superseded' {
  const reason = signal?.reason
  if (reason instanceof Error && /superseded/.test(reason.message)) return 'superseded'
  if (typeof reason === 'string' && /superseded/.test(reason)) return 'superseded'
  return 'user'
}

/**
 * 失败类错误的 stop_reason 归属（design-recover §3.3(a)，R3.2）：
 * `provider` = HTTP provider 故障且 pin 拒绝降级（R8 §3.6(d) 的错误对象
 * 挂 `providerFailure: true`）；其余（引擎/模型错误）默认 `model`。
 * failed 行五值无死值、无双重归属（PRD R3.2 定稿）。
 */
export function classifyFailureReason(err: unknown): 'model' | 'provider' {
  return (err as { providerFailure?: boolean } | null | undefined)?.providerFailure === true
    ? 'provider'
    : 'model'
}

/**
 * persona 创建期快照（R8 §3.6(b)，AD-R6）：扫 flow 的 platformAgent 节点
 * `agentId` 集合，读一次 agents 行（与 createAgentFetcher 同款查询 + 同款
 * skills 预解析）。直跑路径在 assemble 前调用（run 创建期冻结）；返回
 * `{ [agentId]: PlatformAgentConfig }`——落 runs.frozen_agents 与闭包注入
 * 共用。agent 行缺失的 id 静默跳过（节点执行时 fetcher 返回 null 报错）。
 */
export async function snapshotFlowAgents(
  flowData: FlowData,
): Promise<Record<string, PlatformAgentConfig> | null> {
  const agentIds = [
    ...new Set(
      flowData.nodes
        .map((n) => {
          const flat = (n.data ?? {}) as Record<string, unknown>
          const nested = flat.inputs as Record<string, unknown> | undefined
          const id = nested?.agentId ?? flat.agentId
          return typeof id === 'string' && id.length > 0 ? id : null
        })
        .filter((id): id is string => id != null),
    ),
  ]
  if (agentIds.length === 0) return null
  try {
    const { records } = await runQuery<{
      id: string
      name: string
      instructions: string
      model: string
      kind: string
      skills: unknown
    }>(
      `SELECT id, name, instructions, model, kind, skills
         FROM agents
        WHERE id = ANY($1::uuid[])`,
      [agentIds],
    )
    const snapshot: Record<string, PlatformAgentConfig> = {}
    for (const row of records) {
      snapshot[row.id] = {
        id: row.id,
        name: row.name,
        instructions: composeSystemPrompt(row.instructions, row.skills) ?? '',
        model: row.model,
        kind: row.kind,
        skills: [],
      }
    }
    return snapshot
  } catch {
    // 快照是冻结能力不是执行依赖：读取失败回落实时 fetcher（行为不变）。
    return null
  }
}

/**
 * 混合会话检索器（2026-10-04）：关键词命中 + 时间衰减 + 同会话加权的
 * 融合排序。作用域 = 当前会话 + 同目录其他会话（D8 删掉 Retriever 节点后，
 * chat 触发的工作流每轮冷启动——本检索器补上「记得刚才聊过什么」）。
 *
 * 向量检索的升级路径：换 embeddings + pgvector 时只需替换本实现
 * （节点契约不变）；当前的关键词+时间融合是零基础设施的诚实基线。
 */
function createHybridHistoryRetriever(): NonNullable<IExecutionContext['historyRetriever']> {
  return async (query, { chatId, limit }) => {
    // 两级历史（P1b）：摘要层（滚动 checkpoint）与原文层并行取，互不阻塞
    const summary = await getChatContextSummary(chatId)
    try {
      const records = await loadCandidateMessages(chatId)
      if (records.length === 0) return { summary, messages: [] }

      const tokens = [
        ...new Set(
          query
            .split(/[\s,.;:!?，。；：！？]+/)
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= 2),
        ),
      ].slice(0, 8)

      const now = Date.now()
      const scored = records.map((m) => {
        const lower = m.content.toLowerCase()
        const hits = tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0)
        const ageHours = Math.max(0, (now - Date.parse(m.created_at)) / 3_600_000)
        const recency = 1 / (1 + ageHours)
        const sameChat = m.chat_id === chatId ? 2 : 0
        return { m, score: hits * 3 + recency * 2 + sameChat }
      })
      return {
        summary: summary ? summary.slice(0, CHAT_SUMMARY_MAX_CHARS()) : null,
        messages: scored
          .filter((s) => s.score > 2) // 全无命中且久远的不进上下文
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((s) => ({
            role: s.m.role,
            content: s.m.content.slice(0, 2_000),
            createdAt: s.m.created_at,
          })),
      }
    } catch {
      // 检索是增益不是依赖：任何故障返回空上下文，不阻塞生成
      return { summary, messages: [] }
    }
  }
}

/** 原文层候选（近 7 天，当前会话 + 同目录，最近 200 条）。 */
async function loadCandidateMessages(
  chatId: string,
): Promise<Array<{ chat_id: string; role: string; content: string; created_at: string }>> {
  const { records } = await runQuery<{
    chat_id: string
    role: string
    content: string
    created_at: string
  }>(
    `SELECT m.chat_id, m.role, m.content, m.created_at
       FROM chat_messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE (m.chat_id = $1::uuid
             OR c.directory_id = (SELECT directory_id FROM chats WHERE id = $1::uuid))
        AND m.role IN ('user', 'assistant')
        AND m.created_at > NOW() - interval '7 days'
      ORDER BY m.created_at DESC
      LIMIT 200`,
    [chatId],
  )
  return records
}
