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
  if (!claimCheckpointRun(originalRunId)) {
    return fail(c, 409, 'a resume of this run is already in flight', { runId: originalRunId })
  }

  const flow = await loadFlow(ckpt.flow_id)
  if (!flow) return fail(c, 404, 'flow not found', { flowId: ckpt.flow_id })
  // 拓扑护栏（§6.4）：结构变更后续跑拒绝；配置变更允许（新配置跑剩余节点）
  if (computeTopoHash(flow.flowData) !== ckpt.topo_hash) {
    return fail(c, 422, 'flow topology changed since the run — resume refused', { runId: originalRunId })
  }

  const seed = await buildResumeSeed(originalRunId, flow.flowData)
  const newRunId = randomUUID()
  const cwd = await resolveCwd(parsed.directoryId)
  startWorkflowExecution({
    flowId: ckpt.flow_id,
    flowData: flow.flowData,
    runId: newRunId,
    chatId: (await originalChatId(originalRunId)) ?? newRunId,
    input: parsed.input ?? '',
    directoryId: parsed.directoryId,
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

  const seed = await buildResumeSeed(runId, flow.flowData)
  if (!seed) return fail(c, 500, 'checkpoint snapshot missing')
  // 应答回填：seedRuntime.humanInputs[prompt] = answer（引擎持久 resolver
  // 命中预供答案即继续）；同 runId 原地续跑（spans 同 run 续写）。
  const seedRuntime = { ...(seed.seedRuntime ?? {}) }
  const humanInputs = (seedRuntime.humanInputs as Record<string, string> | undefined) ?? {}
  humanInputs[ckpt.awaiting.prompt] = parsed.answer
  seedRuntime.humanInputs = humanInputs

  const chatId = (await originalChatId(runId)) ?? runId
  const cwd = await resolveCwd(parsed.directoryId ?? (await originalDirectoryId(runId)) ?? undefined)
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
  const { records } = await runQuery<{ input: unknown }>(
    `SELECT input FROM runs WHERE id = $1::uuid`,
    [runId],
  ).catch(() => ({ records: [] as Array<{ input: unknown }> }))
  const input = records[0]?.input as { directoryId?: string } | undefined
  return input?.directoryId ?? null
}
