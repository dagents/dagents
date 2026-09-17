import { createHash } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import {
  HumanInputPendingError,
  type IterationProgress,
  type RunCheckpointSnapshot,
} from '@dagents/workflow'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import { aggregateExecutedNodesUsage, recordUsageEvent } from '../usage-events.js'
import { getCheckpoint, updateCheckpointStatus, upsertCheckpoint } from '../repositories/run-checkpoints.repo.js'
import { assembleWorkflowEngine, toRunStatus } from './workflow-engine-service.js'

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
  return createHash('sha1').update(`${nodes.join(',')}|${edges.join(';')}`).digest('hex')
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
  terminalize: (status: 'resumable' | 'terminal', failedAt?: { nodeId: string; error: string }) => void
  /** 链内挂起写：awaiting 载荷走同一串行链（直连写会被在途波次快照后发覆盖）。 */
  suspend: (awaiting: { nodeId: string; prompt: string; inputType: string; options: unknown[]; deadlineAt: string }) => void
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
  }
  /** checkpoint 行归属（resume 期间=原 run id；首跑=runId 自身）。 */
  checkpointRunId: string
  /** 续跑谱系：新 run 行指向原 run。 */
  resumedFromRunId?: string
  cwd?: string
  /** 触发来源标记（runs 行溯源）。 */
  source?: string
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

export function startWorkflowExecution(req: RunExecutionInput): RunExecutionHandleResult {
  activeResumeCheckpoints.add(req.checkpointRunId)
  const { executor, spanWriter, baseOptions } = assembleWorkflowEngine({
    flowData: req.flowData as Parameters<typeof assembleWorkflowEngine>[0]['flowData'],
    runId: req.runId,
    flowId: req.flowId,
    cwd: req.cwd,
    logger: log,
  })

  const checkpointHook = makeCheckpointHook({
    checkpointRunId: req.checkpointRunId,
    flowId: req.flowId,
    flowData: req.flowData,
  })

  const abort = new AbortController()
  const startedAt = Date.now()
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

  const persistRunRow = async (
    status: string,
    extra?: { output?: unknown; error?: string; durationMs?: number; resumedFrom?: string },
  ): Promise<void> => {
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms, cost, chat_id, resumed_from_run_id)
       VALUES ($1::uuid, $2::text, $3::uuid, $4, $5, $6, NOW(), NOW(), $7, 0, $8, $9::uuid)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         output = EXCLUDED.output,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         resumed_from_run_id = COALESCE(EXCLUDED.resumed_from_run_id, runs.resumed_from_run_id)`,
      [
        req.runId,
        req.runId,
        req.flowId,
        status,
        JSON.stringify({ input: req.input }),
        extra?.output ? JSON.stringify(extra.output) : null,
        extra?.durationMs ?? Date.now() - startedAt,
        req.chatId || null,
        extra?.resumedFrom ?? null,
      ],
    ).catch((err) => log.warn('resume runs upsert failed', { runId: req.runId, error: String(err) }))
  }

  const execute = async (): Promise<void> => {
    // 先落一行 running（旁观端立即有终态可查）；resume 首次也先翻 running
    await persistRunRow('running', { resumedFrom: req.resumedFromRunId })
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
                  ...(req.resume.iterationProgress ? { iterationProgress: req.resume.iterationProgress } : {}),
                },
              }
            : {}),
          onCheckpoint: checkpointHook,
        },
      )

      if (result.status === 'awaiting' && result.awaiting) {
        // 持久挂起（§6.3）：经钩子串行链写 awaiting —— 直连写会被在途波次
        // 快照（status=running）后发覆盖（RM-03 全量 e2e 实测竞态）
        const deadlineAt = new Date(Date.now() + AWAITING_TIMEOUT_MS).toISOString()
        checkpointHook.suspend({ ...result.awaiting, deadlineAt })
        await persistRunRow('awaiting_input')
        return
      }

      const runStatus = result.status === 'success' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed'
      // 终态经钩子串行链（快照 + status 合并一次写；failedAt 由引擎终态快照携带）
      checkpointHook.terminalize(runStatus === 'completed' ? 'terminal' : 'resumable')
      await persistRunRow(runStatus, {
        output: result.finalOutput,
        error: result.error,
        durationMs: Date.now() - startedAt,
      })

      // usage rollup（对齐 workflows.ts AD-3 路径）
      const usageRollup = aggregateExecutedNodesUsage(result.executedNodes)
      void recordUsageEvent({
        source: 'workflow_run',
        runId: req.runId,
        flowId: req.flowId,
        usage: usageRollup as unknown as object,
      }).catch(() => {})
    } catch (err) {
      log.error('resume execution crashed', { runId: req.runId, error: String(err) })
      await updateCheckpointStatus(req.checkpointRunId, 'resumable').catch(() => {})
      await persistRunRow('failed', { error: String(err), durationMs: Date.now() - startedAt })
    } finally {
      resolveDone()
      executionRegistry.unregister(handle)
      activeResumeCheckpoints.delete(req.checkpointRunId)
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
    ? ((flowData as { nodes: unknown[] }).nodes as Array<{ id?: unknown; data?: { name?: unknown } }>)
    : []
  for (const n of nodes) {
    if (n?.data?.name === 'iterationAgentflow' && typeof n.id === 'string') {
      controllerIds.add(n.id)
    }
  }
  const seedOutputs: Record<string, Record<string, unknown>> = {}
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
export async function answerAwaitingRunForChat(chatId: string, answer: string): Promise<string | null> {
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
      },
      checkpointRunId: runId,
      cwd,
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
