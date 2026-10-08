import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FlowData, IExecutedNode } from '@dagents/workflow'
import {
  buildTrialSubgraph,
  buildTrialSeedRuntime,
  validateFlowTopology,
  type ExecutionResult,
} from '@dagents/workflow'
import { createLogger } from '@dagents/shared'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import { getFlowById, type FlowRow } from '../repositories/workflows.repo.js'
import { getDirectoryPath } from '../repositories/directories.repo.js'
import {
  persistWorkflowRunRow,
  initAsyncWorkflowRunRow,
  insertNodeSpansBatch,
} from '../repositories/runs.repo.js'
import {
  tryAcquireRunSlot,
  recordRunFinished,
  MAX_CONCURRENT_RUNS,
  runGateStats,
} from '../lib/run-gate.js'
import { makePersistentHumanInputResolver } from './resume-execution.js'
import { assembleWorkflowEngine, toRunStatus } from './workflow-engine-service.js'
import {
  createTrialLlmClient,
  getTrialCalls,
  recordTrialRunStarted,
  scheduleTrialCallsCleanup,
} from '../lib/trial-mock-llm.js'
import { ok, fail, UUID_RE } from '../lib/http.js'
import { notifyRunFinished } from '../lib/run-notify.js'

/**
 * 画布试运行路由（R10，design-sharp §3.4-④）。
 *
 * POST /workflows/:id/trial —— 直跑（workflows.ts runAndPersist）的姊妹编
 * 排，写入口径按 §3.5 裁剪：
 *   - 写：runs（source='trial'）+ spans + live + journal（三视图/回放同栈）
 *   - 不写：checkpoint（无 resume 语义——路由不传 onCheckpoint）、
 *     usage_events（零账单行）、Langfuse（不污染观测 trace）
 *   - 走 run 并发闸（试运行占真执行资源：customFunction 真跑）；可取消
 *     （executionRegistry 按 runId 注册，cancel 端点天然覆盖）
 *
 * GET /runs/:runId/trial-calls —— mock 调用记录（进程内 registry；404 =
 * 重启丢失/非试运行，诚实回退 spans 投影）。
 */

export const workflowTrialRoutes = new Hono()

const log = createLogger({ svc: 'gateway:workflow-trial' })

const mockRespondSchema = z.object({
  mode: z.enum(['ok', 'error', 'malformed', 'empty', 'toolLoop']).optional(),
  text: z.string().optional(),
  toolCalls: z.array(z.unknown()).optional(),
  usage: z.unknown().optional(),
  delayMs: z.number().optional(),
  streamChunkSize: z.number().optional(),
  streamIntervalMs: z.number().optional(),
})

const mockRuleSchema = z.object({
  match: z.record(z.string(), z.unknown()).optional(),
  label: z.string().optional(),
  respond: mockRespondSchema.optional(),
})

const mockScriptSchema: z.ZodType<{
  rules: z.infer<typeof mockRuleSchema>[]
  fallback?: z.infer<typeof mockRespondSchema>
}> = z.object({
  rules: z.array(mockRuleSchema).default([]),
  fallback: mockRespondSchema.optional(),
})

export const trialRunBodySchema = z.object({
  input: z.string().optional(),
  scope: z
    .object({
      nodeIds: z.array(z.string().min(1)).min(1).max(200),
    })
    .optional(),
  mockScript: z
    .union([
      // ScriptSet 形态必须显式带 byNode/default 键——若单脚本分支排在前面，
      // 其全 optional + rules.default([]) 的宽形状会把 `{default:{…}}` 吞成
      // `{rules:[]}`（zod strip 未知键 + default 填充），fallback 静默丢失
      // → mock 全部回落 mock:unmatched（e2e 26 首跑逮出，2026-10-08 集成批；
      // refine 拒绝后 union 会继续尝试单脚本分支，语义不变）。
      z
        .object({
          byNode: z.record(z.string(), mockScriptSchema).optional(),
          default: mockScriptSchema.optional(),
        })
        .refine((s) => s.byNode !== undefined || s.default !== undefined, {
          message: 'script set 需带 byNode 或 default 键',
        }),
      mockScriptSchema,
    ])
    .optional(),
  httpMode: z.enum(['skip', 'real']).optional(),
  seedInputs: z.record(z.string(), z.string()).optional(),
  humanInputs: z.record(z.string(), z.string()).optional(),
  directoryId: z.string().uuid().optional(),
})

type RunResultShape = Omit<ExecutionResult, 'awaiting'> & {
  awaiting?: { nodeId: string; prompt: string; inputType: string; options: unknown[] }
}

workflowTrialRoutes.post('/:id/trial', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid flow id', { id })

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = trialRunBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  let row: FlowRow | null
  try {
    row = await getFlowById(id)
  } catch (err) {
    log.error('trial flow query failed', { id, error: String(err) })
    return fail(c, 502, 'trial run failed')
  }
  if (!row) return fail(c, 404, 'flow not found', { id })

  const originalFlow = row.flow_data as FlowData
  if (!originalFlow || !Array.isArray(originalFlow.nodes) || !Array.isArray(originalFlow.edges)) {
    return fail(c, 400, 'invalid flow data', { id })
  }

  // 子图裁剪（design-sharp §3.3）+ 裁剪图完整拓扑校验（AC-R10-6：防未保存
  // 草稿/手改 JSON 未过保存门；错误带 node 定位，console 走保存校验同款
  // 标红管线）。
  let trial: ReturnType<typeof buildTrialSubgraph>
  try {
    trial = buildTrialSubgraph(originalFlow, data.scope ?? null)
  } catch (err) {
    return fail(c, 400, err instanceof Error ? err.message : 'invalid trial scope')
  }
  const verdict = validateFlowTopology(trial.flowData)
  if (!verdict.ok) {
    const fatal = verdict.errors.filter((e) => (e.severity ?? 'error') === 'error')
    return fail(c, 422, '试运行前置校验未通过（与保存校验同源）', {
      errors: fatal.length > 0 ? fatal : verdict.errors,
    })
  }

  // run 并发闸：试运行占真执行资源（customFunction 真跑），满载同款 429。
  const releaseRunSlot = tryAcquireRunSlot()
  if (!releaseRunSlot) {
    return fail(c, 429, `并发运行已达上限（${MAX_CONCURRENT_RUNS()}）——请取消闲置运行或稍后重试`, {
      active: runGateStats().active,
    })
  }

  // 项目目录语境（customFunction 的 cwd；与直跑同解析、同降级）。
  let runCwd: string | undefined
  if (data.directoryId) {
    try {
      const path = await getDirectoryPath(data.directoryId)
      if (path) runCwd = path
    } catch (err) {
      log.warn('trial directory lookup failed — CLI/customFunction 用网关 cwd', {
        id,
        error: String(err),
      })
    }
  }

  const runId = randomUUID()
  const chatId = randomUUID()
  const startedAt = new Date()
  recordTrialRunStarted()

  // fake llmClient 换装（design-sharp §3.4-①②）：不经 llm_providers、不动
  // active 行（AC-R10-4：试运行后正式 run 仍走原 active provider）。
  const trialClient = createTrialLlmClient({
    runId,
    script: (data.mockScript as never) ?? { rules: [] },
  })

  const { executor, spanWriter, live, journal, nodeLabelById, nodeTypeById, baseOptions } =
    assembleWorkflowEngine({
      flowData: trial.flowData,
      runId,
      flowId: id,
      cwd: runCwd,
      logger: log,
      flowContextMd: row.context_md ?? null,
      llmClientOverride: trialClient,
    })

  // HumanInput：预供答案命中即答；未预供则 awaiting（试运行不支持挂起——
  // checkpoint 不落，boot sweep 收敛；过程流提示预供答案，见 live 帧语义）。
  const humanInputResolver = makePersistentHumanInputResolver(data.humanInputs ?? {})

  // 外部上游种子（design-sharp §3.3 D9）：手填优先；缺省空串（console 侧
  // 已预填「最近一次正式 run 同 nodeId 输出」的默认值）。
  const seedRuntime = buildTrialSeedRuntime(trial.externalUpstreams, data.seedInputs ?? {})

  const abort = new AbortController()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const execHandle: ExecutionHandle = {
    chatId,
    runId,
    kind: 'workflow-run',
    startedAt: startedAt.getTime(),
    abort: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled by caller')),
    done,
  }
  executionRegistry.register(execHandle)

  // runs.input 载荷：{input} 内层形状兼容 extractInputPreview（runs.ts:28-35），
  // 试运行元数据（scope/httpMode）随载荷可查。
  const inputJson = JSON.stringify({
    input: data.input ?? '',
    trialScope: data.scope?.nodeIds ?? null,
    httpMode: data.httpMode ?? 'skip',
  })

  const executeTrial = async (): Promise<void> => {
    let result!: RunResultShape
    let finalStatus = 'failed'
    try {
      // 先落一行 running（旁观端立即有终态可查；source='trial' 隔离标记）。
      await initAsyncWorkflowRunRow({
        runId,
        flowId: id,
        inputJson,
        startedAt,
        directoryId: data.directoryId ?? null,
        source: 'trial',
      }).catch((err) => log.warn('trial runs row init failed', { runId, error: String(err) }))

      result = await executor.execute(trial.flowData, data.input ?? '', {
        ...baseOptions,
        chatId,
        runId,
        state: {},
        isLastNode: true,
        startInput: data.input ?? '',
        signal: abort.signal,
        humanInputResolver,
        trialMode: { http: data.httpMode ?? 'skip' },
        ...(Object.keys(seedRuntime).length > 0
          ? { resume: { seedOutputs: {}, seedRuntime } }
          : {}),
        // 故意不传 onCheckpoint（§3.5：试运行无 resume 语义，零 checkpoint 行）
      })
    } catch (err) {
      log.error('trial execution crashed', { runId, error: String(err) })
      result = {
        status: 'failed',
        finalOutput: null,
        executedNodes: [],
        state: {},
        error: String(err),
      }
    } finally {
      resolveDone()
      executionRegistry.unregister(execHandle)
      releaseRunSlot()
      recordRunFinished(finalStatus === 'running' ? 'failed' : finalStatus)
      // journal 收口（同栈三视图/回放保留，§3.5 表格「spans + journal 写」）。
      journal.close()
      // 调用记录 TTL 清理（进程内证据，10 分钟后让位给 spans 投影）。
      scheduleTrialCallsCleanup(runId)
    }

    const runStatus =
      result.status === 'awaiting' ? 'awaiting_input' : toRunStatus(result.status).status
    finalStatus = runStatus
    live.finish(runStatus)
    // run 完成通知（R9b）：试运行同样经单点发射（订阅者 = 试运行面板页）。
    notifyRunFinished({ runId, flowId: id, status: runStatus })

    // 事后批量补写 spans（增量路径已写的由 writtenNodes 过滤；与直跑同款）。
    try {
      const spanRows: Parameters<typeof insertNodeSpansBatch>[0] = []
      for (const en of result.executedNodes as IExecutedNode[]) {
        if (spanWriter.writtenNodes.has(en.nodeId)) continue
        spanRows.push({
          run_id: runId,
          flow_id: id,
          node_id: en.nodeId,
          node_label: nodeLabelById.get(en.nodeId) ?? null,
          node_type: nodeTypeById.get(en.nodeId) ?? null,
          status:
            en.status === 'success'
              ? 'done'
              : en.status === 'failed'
                ? 'failed'
                : en.status === 'rejected'
                  ? 'rejected'
                  : en.status === 'cached'
                    ? 'cached'
                    : 'unknown',
          started_at: en.startedAt ? new Date(en.startedAt) : startedAt,
          finished_at: en.endedAt ? new Date(en.endedAt) : new Date(),
          duration_ms: Math.max(
            0,
            (en.endedAt ? Date.parse(en.endedAt) : Date.now()) -
              (en.startedAt ? Date.parse(en.startedAt) : startedAt.getTime()),
          ),
          tokens: en.tokens ? JSON.stringify(en.tokens) : null,
          cost: en.cost ?? null,
          error: en.error ?? null,
          input: Object.keys(en.input ?? {}).length > 0 ? JSON.stringify(en.input) : null,
          output: Object.keys(en.output ?? {}).length > 0 ? JSON.stringify(en.output) : null,
        })
      }
      await insertNodeSpansBatch(spanRows)
    } catch (err) {
      log.warn('trial persist run_node_spans failed', { runId, error: String(err) })
    }

    // 终态 runs 行（source='trial'；不写 usage_events / Langfuse，§3.5）。
    const finishedAt = new Date()
    await persistWorkflowRunRow({
      runId,
      flowId: id,
      status: runStatus,
      inputJson,
      outputJson: JSON.stringify(result.finalOutput ?? null),
      startedAt,
      finishedAt,
      durationMs: Math.round(finishedAt.getTime() - startedAt.getTime()),
      cost: 0,
      chatId: null,
      directoryId: data.directoryId ?? null,
      source: 'trial',
    }).catch((err) => log.warn('trial runs upsert failed', { runId, error: String(err) }))
  }

  void executeTrial().catch((err) => {
    log.error('trial run crashed', { id, runId, error: String(err) })
  })

  c.header('x-run-id', runId)
  return ok(c, { runId, async: true })
})

/** trial-calls 证据端点（挂 /api/v1/runs 前缀——契约路径 GET /api/v1/runs/:runId/trial-calls）。 */
export const trialCallsRoutes = new Hono()

trialCallsRoutes.get('/:runId/trial-calls', async (c) => {
  const runId = c.req.param('runId')
  const calls = getTrialCalls(runId)
  if (calls === null) {
    return fail(c, 404, '试运行调用记录不存在（网关重启丢失或非试运行）——spans 投影仍可查', {
      runId,
    })
  }
  return ok(c, { runId, calls })
})
