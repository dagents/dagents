import { createHash } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import {
  HumanInputPendingError,
  type IterationProgress,
  type RunCheckpointSnapshot,
} from '@dagents/workflow'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import {
  aggregateExecutedNodesUsage,
  recordUsageEvent,
  rollupPrimaryModel,
} from '../usage-events.js'
import {
  getCheckpoint,
  updateCheckpointStatus,
  upsertCheckpoint,
} from '../repositories/run-checkpoints.repo.js'
import { findDecisions } from '../repositories/run-node-journal.repo.js'
import { runLineageChain, lineageTokensSpent } from '../lineage.js'
import { persistWorkflowRunRow } from '../repositories/runs.repo.js'
import { collectRunSessions } from './workflow-clients.js'
import { tryAcquireRunSlot, recordRunFinished } from '../lib/run-gate.js'
import { notifyRunFinished } from '../lib/run-notify.js'
import {
  assembleWorkflowEngine,
  toRunStatus,
  classifyAbortReason,
  classifyFailureReason,
} from './workflow-engine-service.js'
import { RUN_MARKER_NODE_ID } from '../journal-writer.js'

const log = createLogger({ svc: 'gateway:resume' })

/**
 * 同一 checkpoint 的在途 resume 互斥（设计 §6.7 幂等护栏，2026-09-18
 * 测试轮实弹逮出缺失：并发两发曾双双 200 各自起跑 —— 重复烧 token +
 * 历史混乱）。checkpointRunId 维度的进程内 Set，执行 done 时清除。
 */
const activeResumeCheckpoints = new Set<string>()

/** HumanInput 挂起时限（应答窗；过期由 boot sweep 收敛 failed）。 */
const AWAITING_TIMEOUT_MS = Number(process.env.HUMAN_INPUT_TIMEOUT_MS ?? 300_000)

/**
 * 断点续跑编排（docs/design-run-checkpoint-resume.md §6）。
 *
 * 职责：拓扑指纹 / checkpoint 生命周期 / resume·answer 两种续跑入口的
 * 异步执行（registry + span writer + runs/usage 落库，与画布直跑同款语义）。
 * 与 workflows.ts 的 runAndPersist 有意保持一份受控重复（同步响应形态
 * 不同）；收敛进 run-orchestrator 是后续项。
 */

// ── 拓扑指纹 ────────────────────────────────────────────────────────────────

/** 节点 id/类型 + 出边三元组的排序序列化 SHA-1（§6.4：配置变更允许，拓扑变拒绝）。 */
export function computeTopoHash(flowData: unknown): string {
  const fd = (flowData ?? {}) as { nodes?: unknown; edges?: unknown }
  const nodes = (Array.isArray(fd.nodes) ? fd.nodes : [])
    .map((n) => String((n as { id?: unknown }).id ?? ''))
    .sort()
  const edges = (Array.isArray(fd.edges) ? fd.edges : [])
    .map(
      (e) =>
        `${String((e as { source?: unknown }).source ?? '')}>` +
        `${String((e as { sourceHandle?: unknown }).sourceHandle ?? '')}>` +
        `${String((e as { target?: unknown }).target ?? '')}`,
    )
    .sort()
  return createHash('sha1')
    .update(`${nodes.join(',')}|${edges.join(';')}`)
    .digest('hex')
}

// ── checkpoint 生命周期 ─────────────────────────────────────────────────────

export interface CheckpointContext {
  /** checkpoint 行归属的 runId（续跑期间保持原 run id —— 续跑谱系在 runs.resumed_from_run_id）。 */
  checkpointRunId: string
  flowId: string
  flowData: { nodes?: unknown[]; edges?: unknown[] }
}

/**
 * 组装 onCheckpoint 钩子：波次/迭代粒度快照 → upsert（status=running）。
 * 写入经**串行链**（同 span-writer 的 nodeQueues 模式）——终态 status 写
 * 与终态快照写在链尾合并为一次 upsert，杜绝「迟到的波次快照覆盖终态
 * failedAt」竞态（RM-01 e2e 实测暴露）。
 */
export interface CheckpointHook {
  (snap: RunCheckpointSnapshot): void
  /** 链尾终态化：合并 failedAt（如有）与最后一次快照，status 一次到位。 */
  terminalize: (
    status: 'resumable' | 'terminal',
    failedAt?: { nodeId: string; error: string },
  ) => void
  /** 链内挂起写：awaiting 载荷走同一串行链（直连写会被在途波次快照后发覆盖）。 */
  suspend: (awaiting: {
    nodeId: string
    prompt: string
    inputType: string
    options: unknown[]
    deadlineAt: string
  }) => void
}

export function makeCheckpointHook(ctx: CheckpointContext): CheckpointHook {
  const topoHash = computeTopoHash(ctx.flowData)
  let chain: Promise<void> = Promise.resolve()
  let lastSnapshot: Record<string, unknown> = {}

  const enqueue = (write: () => Promise<void>): void => {
    chain = chain.then(write, write)
    void chain.catch(() => {})
  }

  const hook = ((snap: RunCheckpointSnapshot): void => {
    lastSnapshot = snap as unknown as Record<string, unknown>
    enqueue(() =>
      upsertCheckpoint({
        runId: ctx.checkpointRunId,
        flowId: ctx.flowId,
        status: 'running',
        topoHash,
        snapshot: snap as unknown as Record<string, unknown>,
      }),
    )
  }) as CheckpointHook

  hook.suspend = (awaiting) => {
    enqueue(() =>
      upsertCheckpoint({
        runId: ctx.checkpointRunId,
        flowId: ctx.flowId,
        status: 'awaiting_input',
        topoHash,
        snapshot: lastSnapshot,
        awaiting,
      }),
    )
  }

  hook.terminalize = (status, failedAt) => {
    // 空快照守护（2026-10-08 集成批，RM-01 复现逮出）：resume/answer 的
    // checkpointRunId 指向**原 run** 的 checkpoint 行——引擎顶层失败（如种子
    // 哈希对账 SeedHashMismatchError）时本 run 零 onCheckpoint 快照，这里
    // 若照常用空 lastSnapshot upsert 会把原 run 的进度快照（completed
    // 节点清单 + failedAt）冲成空——断点信息丢失。空快照 = 只翻 status。
    if (Object.keys(lastSnapshot).length === 0) {
      enqueue(() => updateCheckpointStatus(ctx.checkpointRunId, status))
      return
    }
    const snapshot = failedAt ? { ...lastSnapshot, failedAt } : lastSnapshot
    enqueue(() =>
      upsertCheckpoint({
        runId: ctx.checkpointRunId,
        flowId: ctx.flowId,
        status,
        topoHash,
        snapshot,
      }),
    )
  }
  return hook
}

// ── 持久 HumanInput resolver（§6.3：预供答案 or 挂起信号）──────────────────

/**
 * 全路径统一的持久 resolver：先查预供答案（画布运行面板的答案区 /
 * answer 回流注入），无则 reject HumanInputPendingError —— 引擎收敛为
 * awaiting，本函数不持有任何内存 Promise（重启安全）。
 *
 * 边界判据互引（2026-10-07 R9a）：本 resolver 是挂起双轨制的「持久
 * checkpoint 轨」（兑现者 = resume/应答回流的新执行，跨进程/跨时段可续）；
 * 与 chat SSE 内存 promise 轨（pendingByChat，同连接续流、重启即死）的
 * 选择规则见 ADR：
 * docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md
 */
export function makePersistentHumanInputResolver(
  answers: Record<string, string>,
): (prompt: string, inputType: string, options?: unknown[]) => Promise<string> {
  return async (prompt: string, _inputType: string, _options?: unknown[]) => {
    const answer = answers[prompt]
    if (answer !== undefined) return answer
    throw new HumanInputPendingError(prompt, _inputType, _options ?? [])
  }
}

// ── 异步执行（resume / answer 共用）────────────────────────────────────────

export interface RunExecutionInput {
  flowId: string
  flowData: { nodes: unknown[]; edges: unknown[] }
  runId: string
  chatId: string
  input: string
  directoryId?: string
  humanInputs: Record<string, string>
  /** 断点续跑种子（answer 回流也走它：seedOutputs + 应答回填 humanInputs）。 */
  resume?: {
    seedOutputs: Record<string, Record<string, unknown>>
    seedRuntime: Record<string, unknown>
    iterationProgress?: Record<string, IterationProgress>
    /** 种子携带的 expected input_hash（journal 化种子，§3.5(a)）——引擎
     *  跳过种子节点前预演重算对账，不一致抛 SeedHashMismatchError（AC-R1-3）。 */
    seedHashes?: Record<string, string>
    /** 暖缓存标注（cached span/journal lineage 载荷，§3.7）。 */
    seedSource?: { kind: 'resume' | 'warm-cache'; fromRunId: string }
  }
  /** checkpoint 行归属（resume 期间=原 run id；首跑=runId 自身）。 */
  checkpointRunId: string
  /** 续跑谱系：新 run 行指向原 run。 */
  resumedFromRunId?: string
  cwd?: string
  /** 触发来源标记（runs 行溯源）。 */
  source?: string
  /**
   * run 级 token 预算（R3.4 budget resume 双路径，§3.3(d)）：覆盖前驱预算
   * 或沿用其值；新 run 预算从零起算（引擎 tokensSpent 启动置 0、种子不
   * 结转）。resume 启动时过程流黄警披露谱系链累计已耗（NFR-6）。
   */
  tokenBudget?: number
  /**
   * persona 冻结快照（R8 §3.6(b)，AC-R8-2 跨进程冻结）：路由层读
   * runs.frozen_agents 注入——agent 行已删/改不影响在途与续跑 run。
   */
  frozenAgents?: Record<string, unknown> | null
}

export interface RunExecutionHandleResult {
  runId: string
  done: Promise<void>
}

/**
 * 发起一次异步工作流执行（resume 语义可选）。立即返回；进度经 span writer
 * 落 run_node_spans，终态落 runs + usage + checkpoint。
 */
/**
 * 原子认领：在途则返回 false（check-then-act 竞态的解——两发并发时只有
 * 第一发认领成功，第二发立即 409）。执行 done 时释放。
 */
export function claimCheckpointRun(checkpointRunId: string): boolean {
  if (activeResumeCheckpoints.has(checkpointRunId)) return false
  activeResumeCheckpoints.add(checkpointRunId)
  return true
}

/**
 * 认领的显式释放：路由层在「认领成功 → startWorkflowExecution 接管」之间
 * 的校验/种子组装失败路径必须调用，否则该 checkpoint 永久 409 直到重启
 * （架构审计 G1）。接管后由 execute 的 finally 统一释放。
 */
export function releaseCheckpointRun(checkpointRunId: string): void {
  activeResumeCheckpoints.delete(checkpointRunId)
}

export function startWorkflowExecution(req: RunExecutionInput): RunExecutionHandleResult {
  activeResumeCheckpoints.add(req.checkpointRunId)
  // 同步装配段（引擎组装 / registry 注册）若抛出（坏 flowData 等）够不到
  // execute 的 finally —— 显式释放认领再抛（架构审计 G2）。
  try {
    return startWorkflowExecutionInner(req)
  } catch (err) {
    activeResumeCheckpoints.delete(req.checkpointRunId)
    throw err
  }
}

/** run 并发闸满载（稳定性专项）：路由层捕获后映射 429。 */
export class RunGateFullError extends Error {
  constructor(message = 'concurrent run cap reached') {
    super(message)
    this.name = 'RunGateFullError'
  }
}

function startWorkflowExecutionInner(req: RunExecutionInput): RunExecutionHandleResult {
  // run 并发闸（稳定性专项）：满载抛 RunGateFullError —— 上层 startWorkflowExecution
  // 的 catch 会释放认领，路由层映射 429。release 挂 execute 的 finally。
  const releaseRunSlot = tryAcquireRunSlot()
  if (!releaseRunSlot) throw new RunGateFullError()

  const { executor, live, journal, baseOptions } = assembleWorkflowEngine({
    flowData: req.flowData as Parameters<typeof assembleWorkflowEngine>[0]['flowData'],
    runId: req.runId,
    flowId: req.flowId,
    cwd: req.cwd,
    logger: log,
    // persona 冻结（R8 §3.6(b)）：resume 跨进程注入前驱快照——agent 行
    // 已删/改不影响续跑 run（AC-R8-2）；快照内的 sessions 映射同时是 CLI
    // 会话 --resume 重挂的查表数据源。
    ...(req.frozenAgents ? { frozenAgents: req.frozenAgents } : {}),
  })

  const checkpointHook = makeCheckpointHook({
    checkpointRunId: req.checkpointRunId,
    flowId: req.flowId,
    flowData: req.flowData,
  })

  const abort = new AbortController()
  const startedAt = Date.now()
  // run 级模型快照（R8 §3.6(c)）：execute 终态聚合后 persistRunRow 读取
  // （persist 定义在前、赋值在后——提升到本作用域）。
  let runModels: Record<string, string> | null = null
  let resolveDone!: () => void
  const done = new Promise<void>((r) => {
    resolveDone = r
  })
  const handle: ExecutionHandle = {
    chatId: req.chatId,
    runId: req.runId,
    kind: 'workflow-run',
    startedAt,
    abort: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled by caller')),
    done,
  }
  executionRegistry.register(handle)

  // runs 行落库收敛到 repo 单源（架构优化轮）：此前这里是裸 SQL 副本，
  // runs 表结构知识存在第二处漂移风险；upsert + COALESCE 语义由
  // persistWorkflowRunRow 统一承载（resumedFromRunId 已并入该 helper）。
  const persistRunRow = async (
    status: string,
    extra?: {
      output?: unknown
      durationMs?: number
      resumedFrom?: string
      stopReason?: string | null
    },
  ): Promise<void> => {
    await persistWorkflowRunRow({
      runId: req.runId,
      flowId: req.flowId,
      status,
      inputJson: JSON.stringify({
        input: req.input,
        ...(req.tokenBudget != null ? { tokenBudget: req.tokenBudget } : {}),
      }),
      outputJson: extra?.output ? JSON.stringify(extra.output) : null,
      startedAt: new Date(startedAt),
      finishedAt: new Date(),
      durationMs: extra?.durationMs ?? Date.now() - startedAt,
      cost: 0,
      chatId: req.chatId || null,
      directoryId: req.directoryId ?? null,
      resumedFromRunId: extra?.resumedFrom ?? null,
      // 2026-10-07 R10：RunExecutionInput.source 从死字段接通为实写——
      // resume/answer 路径缺省 'resume'，chat 应答回流由调用方传 'answer'。
      source: req.source ?? 'resume',
      // 2026-10-07 R3（§3.3(c)）：stop_reason 落库（stopped: user/superseded；
      // failed: model/provider——五值词表见 RunStopReason）。
      stopReason: extra?.stopReason ?? null,
      // 2026-10-07 R8（§3.6(b)）：冻结快照谱系延续（新 run 继承前驱快照 +
      // 本轮新采集的会话映射）。
      frozenAgentsJson:
        status !== 'running' && req.frozenAgents
          ? JSON.stringify({ ...req.frozenAgents, sessions: collectRunSessions(req.runId) })
          : null,
      // 2026-10-07 R8（§3.6(c)）：run 级模型快照（终态聚合，execute 闭包
      // 传入；running 先行行不落）。
      modelsJson: status !== 'running' && runModels ? JSON.stringify(runModels) : null,
    }).catch((err) =>
      log.warn('resume runs upsert failed', { runId: req.runId, error: String(err) }),
    )
  }

  const execute = async (): Promise<void> => {
    // 先落一行 running（旁观端立即有终态可查）；resume 首次也先翻 running
    await persistRunRow('running', { resumedFrom: req.resumedFromRunId })
    // 预算黄警（R3.4，NFR-6）：resume 携带/沿用预算时披露谱系链累计已耗
    // ——新 run 预算从零起算（引擎 tokensSpent 启动置 0、种子不结转），
    // 没有这条黄警，用户会把「前驱烧掉的 tokens」误读成本次续跑消耗。
    if (req.tokenBudget != null && req.resumedFromRunId) {
      try {
        const chain = await runLineageChain(req.resumedFromRunId)
        const lineageTokens = await lineageTokensSpent(chain)
        live.delta(
          { nodeId: RUN_MARKER_NODE_ID, nodeName: 'Run' },
          {
            type: 'activity',
            kind: 'status',
            label: `预算重新起算（谱系链累计已耗 ${lineageTokens} tokens）——本次续跑预算 ${req.tokenBudget}`,
          },
        )
      } catch {
        /* 黄警是披露增益不是依赖：谱系查询失败静默跳过 */
      }
    }
    let finalStatus = 'failed'
    let finalStopReason: string | null = null
    try {
      const result = await executor.execute(
        req.flowData as Parameters<typeof executor.execute>[0],
        req.input,
        {
          ...baseOptions,
          chatId: req.chatId,
          runId: req.runId,
          state: {},
          isLastNode: true,
          startInput: req.input,
          signal: abort.signal,
          humanInputResolver: makePersistentHumanInputResolver(req.humanInputs),
          ...(req.resume
            ? {
                resume: {
                  seedOutputs: req.resume.seedOutputs,
                  seedRuntime: req.resume.seedRuntime,
                  ...(req.resume.iterationProgress
                    ? { iterationProgress: req.resume.iterationProgress }
                    : {}),
                  ...(req.resume.seedHashes ? { seedHashes: req.resume.seedHashes } : {}),
                  ...(req.resume.seedSource ? { seedSource: req.resume.seedSource } : {}),
                },
              }
            : {}),
          ...(req.tokenBudget != null ? { tokenBudget: req.tokenBudget } : {}),
          onCheckpoint: checkpointHook,
        },
      )

      if (result.status === 'awaiting' && result.awaiting) {
        // 持久挂起（§6.3）：经钩子串行链写 awaiting —— 直连写会被在途波次
        // 快照（status=running）后发覆盖（RM-03 全量 e2e 实测竞态）
        const deadlineAt = new Date(Date.now() + AWAITING_TIMEOUT_MS).toISOString()
        checkpointHook.suspend({ ...result.awaiting, deadlineAt })
        await persistRunRow('awaiting_input')
        finalStatus = 'awaiting_input'
        return
      }

      // 引擎状态 → runs 行（2026-10-07 R3 §3.3(a)：单源收敛——此前这里是
      // 手写三元链（漂移温床），AC-R3-3 三入口一致：直跑/resume/answer 全走
      // toRunStatus；cancelled→stopped 写新 + superseded 归属由 abort reason 判定）。
      const { status: runStatus, stopReason } = toRunStatus(result.status, {
        superseded: classifyAbortReason(abort.signal) === 'superseded',
      })
      finalStatus = runStatus
      finalStopReason = stopReason ?? null
      // 运行实时终端：续跑 settle 同样上报终态（重开的条目再次收口）；
      // runEnd 帧带 stopReason（客户端过滤 superseded 通知，R3.5）。
      live.finish(runStatus, stopReason)
      // run 完成通知（R9b）：单点发射 + 幂等 claim + superseded 抑制。
      notifyRunFinished({
        runId: req.runId,
        flowId: req.flowId,
        status: runStatus,
        stopReason,
      })
      // 终态经钩子串行链（快照 + status 合并一次写；failedAt 由引擎终态快照携带）
      checkpointHook.terminalize(runStatus === 'completed' ? 'terminal' : 'resumable')
      runModels = (() => {
        const modelsMap: Record<string, string> = {}
        for (const en of result.executedNodes) {
          if (en.resolvedModel) modelsMap[en.nodeId] = en.resolvedModel
        }
        return Object.keys(modelsMap).length > 0 ? modelsMap : null
      })()
      await persistRunRow(runStatus, {
        output: result.finalOutput,
        durationMs: Date.now() - startedAt,
        stopReason: stopReason ?? null,
      })

      // usage rollup（对齐 workflows.ts AD-3 路径）；model（R8 §3.6(c)）=
      // rollup 主模型（用量最大节点的 resolvedModel）。
      const usageRollup = aggregateExecutedNodesUsage(result.executedNodes)
      void recordUsageEvent({
        source: 'workflow_run',
        runId: req.runId,
        flowId: req.flowId,
        usage: usageRollup as unknown as object,
        model: rollupPrimaryModel(result.executedNodes),
      }).catch(() => {})
    } catch (err) {
      log.error('resume execution crashed', { runId: req.runId, error: String(err) })
      const stopReason = classifyFailureReason(err)
      finalStatus = 'failed'
      finalStopReason = stopReason
      await updateCheckpointStatus(req.checkpointRunId, 'resumable').catch(() => {})
      await persistRunRow('failed', { durationMs: Date.now() - startedAt, stopReason })
    } finally {
      journal.close()
      resolveDone()
      executionRegistry.unregister(handle)
      activeResumeCheckpoints.delete(req.checkpointRunId)
      releaseRunSlot()
      recordRunFinished(finalStatus)
      void finalStopReason
    }
  }

  void execute()
  return { runId: req.runId, done }
}

// ── 供路由层使用的种子组装 ─────────────────────────────────────────────────

export async function buildResumeSeed(
  checkpointRunId: string,
  flowData?: unknown,
): Promise<{
  seedOutputs: Record<string, Record<string, unknown>>
  seedRuntime: Record<string, unknown>
  iterationProgress?: Record<string, IterationProgress>
  /** journal 化种子携带的 expected input_hash（引擎预演对账，AC-R1-3）；
   *  checkpoint 兜底路径无 hash（跳过校验照旧种子化，PRD R1.7）。 */
  seedHashes?: Record<string, string>
  /** 种子来源标注（cached 钩子/journal lineage 载荷）。 */
  seedSource?: { kind: 'resume' | 'warm-cache'; fromRunId: string }
} | null> {
  const ckpt = await getCheckpoint(checkpointRunId)
  if (!ckpt) return null
  const snap = ckpt.snapshot as {
    outputs?: Record<string, Record<string, unknown>>
    runtime?: Record<string, unknown>
    iterationProgress?: Record<string, IterationProgress>
  }
  // 迭代控制器不种子化（2026-09-18 测试轮逮出的 P1 缺陷）：控制器被跳过
  // → runIterationBody 的项级循环机制整个旁路，body 退化为普通节点只跑
  // 一次。控制器重跑 planning（解析 items），游标让 body 从断点项续。
  const controllerIds = new Set<string>()
  const nodes = Array.isArray((flowData as { nodes?: unknown } | undefined)?.nodes)
    ? ((flowData as { nodes: unknown[] }).nodes as Array<{
        id?: unknown
        data?: { name?: unknown }
      }>)
    : []
  for (const n of nodes) {
    if (n?.data?.name === 'iterationAgentflow' && typeof n.id === 'string') {
      controllerIds.add(n.id)
    }
  }
  const seedOutputs: Record<string, Record<string, unknown>> = {}
  // ── journal 化种子（2026-10-07 R1 §3.5(a)，AD-R2 真相源）──
  // kind='decision' AND status IN ('done','cached') 的行按 (node_id, ordinal)
  // 组装：ordinal=0 → 根图种子 + seedHashes（引擎跳过前预演对账，AC-R1-3）；
  // ordinal>=1 → 迭代体 per-ordinal 种子（itemNodeOutputs，§3.1(c)3——断点
  // 项的 body 部分短路）。failed 行不进种子（重跑语义）。checkpoint snapshot
  // 兜底：无 journal 行的老 run（迁移前失败存量）回落现状种子（无 hash
  // 跳过校验，行为不劣于今天，AC-R1-5）。
  const decisions = await findDecisions(checkpointRunId, { statuses: ['done', 'cached'] }).catch(
    () => [],
  )
  const seedHashes: Record<string, string> = {}
  let iterationProgress: Record<string, IterationProgress> | undefined = snap.iterationProgress
  if (decisions.length > 0) {
    const itemNodeOutputs: Array<Record<string, Record<string, unknown>>> = []
    for (const d of decisions) {
      if (controllerIds.has(d.nodeId)) continue
      const out = d.payload.output
      if (out == null) continue
      if (d.ordinal === 0) {
        seedOutputs[d.nodeId] = out
        if (d.payload.inputHash) seedHashes[d.nodeId] = d.payload.inputHash
      } else {
        // 迭代 body 的第 ordinal 项输出：`[i][nodeId] = output`——引擎串行
        // 路径据此为第 i 项预填克隆（preseeded 短路，地基 §3.1(c)3）。
        const slot = itemNodeOutputs[d.ordinal] ?? (itemNodeOutputs[d.ordinal] = {})
        slot[d.nodeId] = out
      }
    }
    // 游标（completed / itemOutputs 聚合）仍从 checkpoint snapshot —— journal
    // 的 ordinal 行只有「项内 body 输出」没有「项完成度」（completed 的推进
    // 语义在引擎游标，§3.5(a) 既有裁决）。
    if (snap.iterationProgress) {
      const merged: Record<string, IterationProgress> = {}
      for (const [controllerId, progress] of Object.entries(snap.iterationProgress)) {
        merged[controllerId] = {
          ...progress,
          ...(itemNodeOutputs.length > 0 ? { itemNodeOutputs } : {}),
        }
      }
      iterationProgress = merged
    }
    return {
      seedOutputs,
      seedRuntime: snap.runtime ?? {},
      ...(iterationProgress ? { iterationProgress } : {}),
      ...(Object.keys(seedHashes).length > 0 ? { seedHashes } : {}),
      seedSource: { kind: 'resume' as const, fromRunId: checkpointRunId },
    }
  }
  // checkpoint snapshot 兜底（无 journal 行的老 run）。
  for (const [id, out] of Object.entries(snap.outputs ?? {})) {
    if (!controllerIds.has(id)) seedOutputs[id] = out
  }
  return {
    seedOutputs,
    seedRuntime: snap.runtime ?? {},
    iterationProgress: snap.iterationProgress,
  }
}

// ── 聊天应答回流（P2 §6.5）：消息到达时查该 chat 的 awaiting run ───────────

/**
 * chat 的新消息若命中本 chat 挂起中的 run（checkpoint awaiting_input 且
 * 未过期），把消息当作该 HumanInput 的应答原地续跑（同 runId）。
 * 返回续跑的 runId；无挂起/已过期返回 null（消息走正常路由）。
 */
export async function answerAwaitingRunForChat(
  chatId: string,
  answer: string,
): Promise<string | null> {
  try {
    const { records } = await runQuery<{ run_id: string }>(
      `SELECT c.run_id
         FROM run_checkpoints c
         JOIN runs r ON r.id = c.run_id
        WHERE r.chat_id = $1::text
          AND c.status = 'awaiting_input'
          AND (c.awaiting->>'deadlineAt')::timestamptz > NOW()
        ORDER BY c.updated_at DESC
        LIMIT 1`,
      [chatId],
    )
    const runId = records[0]?.run_id
    if (!runId) return null

    const ckpt = await getCheckpoint(runId)
    if (!ckpt?.awaiting) return null
    const flow = await loadFlowForResume(ckpt.flow_id)
    if (!flow || computeTopoHash(flow.flowData) !== ckpt.topo_hash) return null

    const seed = await buildResumeSeed(runId, flow.flowData)
    if (!seed) return null
    const seedRuntime = { ...(seed.seedRuntime ?? {}) }
    const humanInputs = (seedRuntime.humanInputs as Record<string, string> | undefined) ?? {}
    humanInputs[ckpt.awaiting.prompt] = answer
    seedRuntime.humanInputs = humanInputs

    // 原 run 的目录语境延续
    const { records: dirRows } = await runQuery<{ input: unknown }>(
      `SELECT input FROM runs WHERE id = $1::uuid`,
      [runId],
    ).catch(() => ({ records: [] as Array<{ input: unknown }> }))
    const dirId = (dirRows[0]?.input as { directoryId?: string } | undefined)?.directoryId
    const cwd = dirId ? await resolveDirectoryPath(dirId) : undefined

    // 认领互斥（架构审计 G6）：并发消息只允许一发原地续跑；认领失败说明
    // 已有 resume/answer 在途 —— 消息回落正常聊天路由。
    if (!claimCheckpointRun(runId)) {
      log.info('awaiting run already resuming — message routed normally', { chatId, runId })
      return null
    }
    startWorkflowExecution({
      flowId: ckpt.flow_id,
      flowData: flow.flowData,
      runId,
      chatId,
      input: '',
      humanInputs,
      resume: {
        seedOutputs: seed.seedOutputs,
        seedRuntime,
        ...(seed.iterationProgress ? { iterationProgress: seed.iterationProgress } : {}),
        ...(seed.seedHashes ? { seedHashes: seed.seedHashes } : {}),
        ...(seed.seedSource ? { seedSource: seed.seedSource } : {}),
      },
      checkpointRunId: runId,
      cwd,
      source: 'answer',
    })
    log.info('chat answer resumed awaiting run', { chatId, runId })
    return runId
  } catch (err) {
    log.warn('answerAwaitingRunForChat failed', { chatId, error: String(err) })
    return null
  }
}

async function loadFlowForResume(flowId: string): Promise<{
  flowData: { nodes: unknown[]; edges: unknown[] }
} | null> {
  const { records } = await runQuery<{ flow_data: unknown }>(
    `SELECT flow_data FROM flows WHERE id = $1::uuid`,
    [flowId],
  )
  const raw = records[0]?.flow_data as { nodes?: unknown[]; edges?: unknown[] } | undefined
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  return { flowData: { nodes: raw.nodes, edges: raw.edges } }
}

async function resolveDirectoryPath(directoryId: string): Promise<string | undefined> {
  try {
    const { records } = await runQuery<{ path: string }>(
      `SELECT path FROM directories WHERE id = $1::uuid`,
      [directoryId],
    )
    return records[0]?.path ?? undefined
  } catch {
    return undefined
  }
}
