import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { ok, fail, UUID_RE } from '../lib/http.js'
import { getCheckpoint } from '../repositories/run-checkpoints.repo.js'
import {
  buildResumeSeed,
  computeTopoHash,
  claimCheckpointRun,
  releaseCheckpointRun,
  startWorkflowExecution,
} from './resume-execution.js'

/**
 * 断点续跑路由（design-run-checkpoint-resume.md §6.5）：
 *   GET  /workflows/runs/:runId/checkpoint —— UI 判定入口（resumable/awaiting 状态）
 *   POST /workflows/runs/:runId/resume    —— 失败/取消后从断点续跑（新 runId，谱系链）
 *   POST /workflows/runs/:runId/answer    —— awaiting 挂起的应答回流（同 runId 原地继续）
 */
export const runResumeRoutes = new Hono()

const log = createLogger({ svc: 'gateway:execution-resume' })

const resumeBodySchema = z.object({
  input: z.string().max(200_000).optional(),
  directoryId: z.string().uuid().optional(),
  humanInputs: z.record(z.string(), z.string()).optional(),
})

const answerBodySchema = z.object({
  answer: z.string().min(1).max(100_000),
  directoryId: z.string().uuid().optional(),
})

async function loadFlow(flowId: string): Promise<{
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

/** 解析目录 → CLI cwd（缺省/查不到回落网关 cwd，与直跑同语义）。 */
async function resolveCwd(directoryId?: string): Promise<string | undefined> {
  if (!directoryId) return undefined
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

runResumeRoutes.get('/runs/:runId/checkpoint', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) return fail(c, 400, 'invalid run id', { runId })
  const ckpt = await getCheckpoint(runId)
  if (!ckpt) return fail(c, 404, 'no checkpoint for run', { runId })
  const snap = ckpt.snapshot as {
    outputs?: Record<string, unknown>
    failedAt?: { nodeId: string; error: string }
  }
  return ok(c, {
    runId,
    status: ckpt.status,
    completedNodeCount: Object.keys(snap.outputs ?? {}).length,
    failedAt: snap.failedAt ?? null,
    awaiting: ckpt.awaiting,
    updatedAt: ckpt.updated_at,
  })
})

runResumeRoutes.post('/runs/:runId/resume', async (c) => {
  const originalRunId = c.req.param('runId')
  if (!UUID_RE.test(originalRunId)) return fail(c, 400, 'invalid run id', { runId: originalRunId })

  let parsed: z.infer<typeof resumeBodySchema>
  try {
    parsed = resumeBodySchema.parse(await c.req.json().catch(() => ({})))
  } catch (err) {
    return fail(c, 400, 'invalid resume body', { detail: String(err) })
  }

  const ckpt = await getCheckpoint(originalRunId)
  if (!ckpt) return fail(c, 404, 'no checkpoint for run', { runId: originalRunId })
  if (ckpt.status !== 'resumable') {
    return fail(c, 409, `run is not resumable (checkpoint status: ${ckpt.status})`, { runId: originalRunId })
  }

  // 只读校验（flow 存在 / 拓扑未变）前置到认领之前：认领后的任何退出都
  // 必须释放，校验放锁外就没有泄漏面（架构审计 G1）。
  const flow = await loadFlow(ckpt.flow_id)
  if (!flow) return fail(c, 404, 'flow not found', { flowId: ckpt.flow_id })
  // 拓扑护栏（§6.4）：结构变更后续跑拒绝；配置变更允许（新配置跑剩余节点）
  if (computeTopoHash(flow.flowData) !== ckpt.topo_hash) {
    return fail(c, 422, 'flow topology changed since the run — resume refused', { runId: originalRunId })
  }

  if (!claimCheckpointRun(originalRunId)) {
    return fail(c, 409, 'a resume of this run is already in flight', { runId: originalRunId })
  }

  // 认领后唯一可抛的是 buildResumeSeed 的 DB 读；失败显式释放再抛。
  // startWorkflowExecution 一旦接管，释放交由其 execute 的 finally。
  const seed = await buildResumeSeed(originalRunId, flow.flowData).catch((err) => {
    releaseCheckpointRun(originalRunId)
    throw err
  })
  const newRunId = randomUUID()
  const resumeDirectoryId = parsed.directoryId ?? (await originalDirectoryId(originalRunId))
  const cwd = await resolveCwd(resumeDirectoryId ?? undefined)
  startWorkflowExecution({
    flowId: ckpt.flow_id,
    flowData: flow.flowData,
    runId: newRunId,
    chatId: (await originalChatId(originalRunId)) ?? newRunId,
    input: parsed.input ?? '',
    directoryId: resumeDirectoryId ?? undefined,
    humanInputs: parsed.humanInputs ?? {},
    resume: seed
      ? {
          seedOutputs: seed.seedOutputs,
          seedRuntime: seed.seedRuntime,
          ...(seed.iterationProgress ? { iterationProgress: seed.iterationProgress } : {}),
        }
      : undefined,
    checkpointRunId: originalRunId,
    resumedFromRunId: originalRunId,
    cwd,
  })
  log.info('run resumed', { originalRunId, newRunId, flowId: ckpt.flow_id })
  return ok(c, { runId: newRunId, resumedFrom: originalRunId })
})

runResumeRoutes.post('/runs/:runId/answer', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) return fail(c, 400, 'invalid run id', { runId })

  let parsed: z.infer<typeof answerBodySchema>
  try {
    parsed = answerBodySchema.parse(await c.req.json().catch(() => ({})))
  } catch (err) {
    return fail(c, 400, 'invalid answer body', { detail: String(err) })
  }

  const ckpt = await getCheckpoint(runId)
  if (!ckpt) return fail(c, 404, 'no checkpoint for run', { runId })
  if (ckpt.status !== 'awaiting_input' || !ckpt.awaiting) {
    return fail(c, 409, `run is not awaiting input (checkpoint status: ${ckpt.status})`, { runId })
  }
  const deadline = new Date(ckpt.awaiting.deadlineAt).getTime()
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    return fail(c, 409, 'awaiting deadline passed — run must be resumed or rerun', { runId })
  }

  const flow = await loadFlow(ckpt.flow_id)
  if (!flow) return fail(c, 404, 'flow not found', { flowId: ckpt.flow_id })
  if (computeTopoHash(flow.flowData) !== ckpt.topo_hash) {
    return fail(c, 422, 'flow topology changed — answer cannot resume this run', { runId })
  }

  // 认领互斥（架构审计 G6）：此前 answer 不认领，并发的两发应答会各自
  // 起跑同 runId（Set.add 幂等拦不住）—— 现在与 resume 同一互斥面。
  if (!claimCheckpointRun(runId)) {
    return fail(c, 409, 'an answer or resume of this run is already in flight', { runId })
  }

  const seed = await buildResumeSeed(runId, flow.flowData).catch((err) => {
    releaseCheckpointRun(runId)
    throw err
  })
  if (!seed) {
    releaseCheckpointRun(runId)
    return fail(c, 500, 'checkpoint snapshot missing')
  }
  // 应答回填：seedRuntime.humanInputs[prompt] = answer（引擎持久 resolver
  // 命中预供答案即继续）；同 runId 原地续跑（spans 同 run 续写）。
  const seedRuntime = { ...(seed.seedRuntime ?? {}) }
  const humanInputs = (seedRuntime.humanInputs as Record<string, string> | undefined) ?? {}
  humanInputs[ckpt.awaiting.prompt] = parsed.answer
  seedRuntime.humanInputs = humanInputs

  const chatId = (await originalChatId(runId)) ?? runId
  const answerDirectoryId = parsed.directoryId ?? (await originalDirectoryId(runId))
  const cwd = await resolveCwd(answerDirectoryId ?? undefined)
  startWorkflowExecution({
    flowId: ckpt.flow_id,
    flowData: flow.flowData,
    runId,
    chatId,
    input: '',
    directoryId: answerDirectoryId ?? undefined,
    humanInputs,
    resume: {
      seedOutputs: seed.seedOutputs,
      seedRuntime,
      ...(seed.iterationProgress ? { iterationProgress: seed.iterationProgress } : {}),
    },
    checkpointRunId: runId,
    cwd,
  })
  log.info('awaiting run answered — resuming in place', { runId, nodeId: ckpt.awaiting.nodeId })
  return ok(c, { runId, resumed: true })
})

// ── 小工具：从 runs 行回溯源信息 ────────────────────────────────────────────

async function originalChatId(runId: string): Promise<string | null> {
  const { records } = await runQuery<{ chat_id: string | null }>(
    `SELECT chat_id FROM runs WHERE id = $1::uuid`,
    [runId],
  ).catch(() => ({ records: [] as Array<{ chat_id: string | null }> }))
  return records[0]?.chat_id ?? null
}

async function originalDirectoryId(runId: string): Promise<string | null> {
  // 2026-09-19 P0：优先 runs.directory_id 列（数据链修复后的正源）；
  // input.directoryId 是历史假设读取（无写入方），保留兜底不双轨长存。
  const { records } = await runQuery<{ directory_id: string | null; input: unknown }>(
    `SELECT directory_id, input FROM runs WHERE id = $1::uuid`,
    [runId],
  ).catch(() => ({ records: [] as Array<{ directory_id: string | null; input: unknown }> }))
  const row = records[0]
  if (row?.directory_id) return row.directory_id
  const input = row?.input as { directoryId?: string } | undefined
  return input?.directoryId ?? null
}
