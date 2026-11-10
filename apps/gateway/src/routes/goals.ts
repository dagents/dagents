/**
 * `/api/v1/goals/*` — 目标环 CRUD + 推进端点（方向 C，2026-11-10）。
 *
 * `GET /`（列表 + rollup）· `POST /`（创建）· `GET /:id`（详情 + run 谱系）
 * · `PATCH /:id`（编辑/暂停/恢复/auto 开关）· `DELETE /:id`
 * · `POST /:id/advance`（手动推一轮——goal-loop supervisor 的同一代码路径）
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import { ok, fail, UUID_RE } from '../lib/http.js'
import {
  listGoals,
  getGoalById,
  createGoal,
  updateGoal,
  deleteGoal,
  listGoalRuns,
  type GoalRow,
} from '../repositories/goals.repo.js'
import { advanceGoalOnce } from '../goal-loop-service.js'

export const goalRoutes = new Hono()

const log = createLogger({ svc: 'gateway:goals' })

function toDto(g: GoalRow): Record<string, unknown> {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    acceptance: g.acceptance,
    flowId: g.flow_id,
    flowName: g.flow_name,
    directoryId: g.directory_id,
    directoryName: g.directory_name,
    budgetUsd: g.budget_usd == null ? null : Number(g.budget_usd),
    auto: g.auto,
    status: g.status,
    round: g.round,
    maxRounds: g.max_rounds,
    lastRunId: g.last_run_id,
    lastEval: g.last_eval,
    lastEvalPassed: g.last_eval_passed,
    createdAt: g.created_at instanceof Date ? g.created_at.toISOString() : g.created_at,
    updatedAt: g.updated_at instanceof Date ? g.updated_at.toISOString() : g.updated_at,
    // rollup
    runCount: g.run_count,
    totalCost: g.total_cost == null ? 0 : Number(g.total_cost),
    lastRunStatus: g.last_run_status,
    lastRunStartedAt:
      g.last_run_started_at instanceof Date
        ? g.last_run_started_at.toISOString()
        : g.last_run_started_at,
  }
}

/** id 校验 + 取 goal；失败时直接返回错误 Response（调用方原样 return）。 */
async function resolveGoalOr404(c: Context, id: string): Promise<GoalRow | Response> {
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid goal id', { id })
  }
  const goal = await getGoalById(id)
  if (!goal) {
    return fail(c, 404, 'goal not found', { id })
  }
  return goal
}

goalRoutes.get('/', async (c) => {
  try {
    const all = c.req.query('all') === '1'
    const goals = await listGoals(all)
    return ok(c, { goals: goals.map(toDto) })
  } catch (err) {
    log.error('goals list failed', { error: String(err) })
    return fail(c, 500, 'goals list failed')
  }
})

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  acceptance: z.string().max(20_000).optional(),
  flowId: z.string().uuid().optional(),
  directoryId: z.string().uuid().optional(),
  budgetUsd: z.number().positive().max(1_000_000).nullable().optional(),
  auto: z.boolean().optional(),
  maxRounds: z.number().int().positive().max(100).optional(),
})

goalRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  const d = parsed.data
  try {
    const id = await createGoal({
      title: d.title,
      description: d.description,
      acceptance: d.acceptance,
      flowId: d.flowId ?? null,
      directoryId: d.directoryId ?? null,
      budgetUsd: d.budgetUsd ?? null,
      auto: d.auto ?? false,
      maxRounds: d.maxRounds,
    })
    const goal = await getGoalById(id)
    return ok(c, { goal: goal ? toDto(goal) : { id } })
  } catch (err) {
    log.error('goal create failed', { error: String(err) })
    return fail(c, 500, 'goal create failed')
  }
})

goalRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const goal = await resolveGoalOr404(c, id)
  if (goal instanceof Response) return goal
  try {
    const runs = await listGoalRuns(id)
    return ok(c, {
      goal: toDto(goal),
      runs: runs.map((r) => ({
        runId: r.id,
        status: r.status,
        flowName: r.flow_name,
        startedAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        finishedAt:
          r.finished_at instanceof Date ? r.finished_at.toISOString() : r.finished_at,
        durationMs: r.duration_ms,
        cost: r.cost == null ? null : Number(r.cost),
      })),
    })
  } catch (err) {
    log.error('goal detail failed', { id, error: String(err) })
    return fail(c, 500, 'goal detail failed')
  }
})

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
  acceptance: z.string().max(20_000).optional(),
  flowId: z.string().uuid().nullable().optional(),
  directoryId: z.string().uuid().nullable().optional(),
  budgetUsd: z.number().positive().max(1_000_000).nullable().optional(),
  auto: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  maxRounds: z.number().int().positive().max(100).optional(),
})

goalRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const goal = await resolveGoalOr404(c, id)
  if (goal instanceof Response) return goal
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  try {
    // patchSchema 的 camelCase 键与 UpdateGoalPatch 一一对应，直接透传
    await updateGoal(id, parsed.data)
    const updated = await getGoalById(id)
    return ok(c, { goal: updated ? toDto(updated) : null })
  } catch (err) {
    log.error('goal update failed', { id, error: String(err) })
    return fail(c, 500, 'goal update failed')
  }
})

goalRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid goal id', { id })
  try {
    const deleted = await deleteGoal(id)
    if (!deleted) return fail(c, 404, 'goal not found', { id })
    return ok(c, { deleted: true, id })
  } catch (err) {
    log.error('goal delete failed', { id, error: String(err) })
    return fail(c, 500, 'goal delete failed')
  }
})

goalRoutes.post('/:id/advance', async (c) => {
  const id = c.req.param('id')
  const goal = await resolveGoalOr404(c, id)
  if (goal instanceof Response) return goal
  try {
    const runId = await advanceGoalOnce(id)
    return ok(c, { runId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(c, 422, msg)
  }
})
