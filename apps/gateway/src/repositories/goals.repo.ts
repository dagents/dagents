/**
 * goals.repo.ts — 目标环（Goal Loop）数据层（方向 C，2026-11-10）。
 *
 * goals 行 + 每目标 runs 谱系 rollup（轮数/累计成本·token/最近一轮）一次
 * 取齐——目标看板整页数据源。推进（advance）与评估状态机在
 * goal-loop-service.ts；本层只管表访问。
 */
import { runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

export type GoalStatus = 'active' | 'awaiting_eval' | 'achieved' | 'paused' | 'archived'

export interface GoalRow {
  id: string
  title: string
  description: string
  acceptance: string
  flow_id: string | null
  flow_name: string | null
  directory_id: string | null
  directory_name: string | null
  budget_usd: string | null
  auto: boolean
  status: GoalStatus | string
  round: number
  max_rounds: number
  last_run_id: string | null
  last_eval: string | null
  last_eval_passed: boolean | null
  created_at: Date
  updated_at: Date
  /** rollup：名下 run 谱系聚合（无 run 时零值）。 */
  run_count: number
  total_cost: string | number | null
  total_tokens: number | null
  last_run_status: string | null
  last_run_started_at: Date | null
}

const GOAL_COLUMNS = `g.id, g.title, g.description, g.acceptance, g.flow_id, g.directory_id,
  g.budget_usd, g.auto, g.status, g.round, g.max_rounds,
  g.last_run_id, g.last_eval, g.last_eval_passed, g.created_at, g.updated_at,
  f.name AS flow_name, d.name AS directory_name`

const ROLLUP_JOIN = `LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS run_count,
           COALESCE(SUM(r.cost), 0) AS total_cost,
           NULL::int AS total_tokens
      FROM runs r WHERE r.goal_id = g.id
  ) rollup ON true
LEFT JOIN LATERAL (
    SELECT status AS last_run_status, started_at_created AS last_run_started_at FROM (
      SELECT r.status, r.created_at AS started_at_created
        FROM runs r WHERE r.goal_id = g.id
       ORDER BY r.created_at DESC LIMIT 1
    ) t
  ) last_run ON true`

/** goal 列表（含 rollup + flow/目录名）。archived 默认收起（?all=1 带）。 */
export async function listGoals(includeArchived: boolean): Promise<GoalRow[]> {
  const { records } = await runQuery<GoalRow>(
    `SELECT ${GOAL_COLUMNS}, rollup.run_count, rollup.total_cost, rollup.total_tokens,
            last_run.last_run_status, last_run.last_run_started_at
       FROM goals g
       ${ROLLUP_JOIN}
       LEFT JOIN flows f ON f.id = g.flow_id
       LEFT JOIN directories d ON d.id = g.directory_id
      ${includeArchived ? '' : `WHERE g.status != 'archived'`}
      ORDER BY (g.status = 'achieved'), g.updated_at DESC
      LIMIT 200`,
  )
  return records
}

export async function getGoalById(id: string): Promise<GoalRow | null> {
  const { records } = await runQuery<GoalRow>(
    `SELECT ${GOAL_COLUMNS}, rollup.run_count, rollup.total_cost, rollup.total_tokens,
            last_run.last_run_status, last_run.last_run_started_at
       FROM goals g
       ${ROLLUP_JOIN}
       LEFT JOIN flows f ON f.id = g.flow_id
       LEFT JOIN directories d ON d.id = g.directory_id
      WHERE g.id = $1::uuid`,
    [id],
  )
  return records[0] ?? null
}

export interface CreateGoalInput {
  title: string
  description?: string
  acceptance?: string
  flowId?: string | null
  directoryId?: string | null
  budgetUsd?: number | null
  auto?: boolean
  maxRounds?: number
}

export async function createGoal(input: CreateGoalInput): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO goals (id, title, description, acceptance, flow_id, directory_id, budget_usd, auto, max_rounds)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::numeric, $8, $9)`,
    [
      id,
      input.title,
      input.description ?? '',
      input.acceptance ?? '',
      input.flowId ?? null,
      input.directoryId ?? null,
      input.budgetUsd ?? null,
      input.auto ?? false,
      input.maxRounds ?? 10,
    ],
  )
  return id
}

export interface UpdateGoalPatch {
  title?: string
  description?: string
  acceptance?: string
  flowId?: string | null
  directoryId?: string | null
  budgetUsd?: number | null
  auto?: boolean
  status?: GoalStatus
  maxRounds?: number
}

/** 局部更新（动态 SET；updated_at 恒 touch）。 */
export async function updateGoal(id: string, patch: UpdateGoalPatch): Promise<void> {
  const sets: string[] = ['updated_at = NOW()']
  const params: unknown[] = [id]
  const add = (col: string, v: unknown) => {
    params.push(v)
    sets.push(`${col} = $${params.length}`)
  }
  if (patch.title !== undefined) add('title', patch.title)
  if (patch.description !== undefined) add('description', patch.description)
  if (patch.acceptance !== undefined) add('acceptance', patch.acceptance)
  if (patch.flowId !== undefined) add('flow_id', patch.flowId)
  if (patch.directoryId !== undefined) add('directory_id', patch.directoryId)
  if (patch.budgetUsd !== undefined) add('budget_usd', patch.budgetUsd)
  if (patch.auto !== undefined) add('auto', patch.auto)
  if (patch.status !== undefined) add('status', patch.status)
  if (patch.maxRounds !== undefined) add('max_rounds', patch.maxRounds)
  await runQuery(`UPDATE goals SET ${sets.join(', ')} WHERE id = $1::uuid`, params)
}

/** 轮次推进落账（round+1 / last_run_id / 状态 → active）。 */
export async function markGoalRoundStarted(
  id: string,
  runId: string,
): Promise<void> {
  await runQuery(
    `UPDATE goals
        SET round = round + 1, last_run_id = $2::uuid, status = 'active', updated_at = NOW()
      WHERE id = $1::uuid`,
    [id, runId],
  )
}

/** 评估结论落账（含评估去重游标 last_eval_run_id；passed ⇒ achieved）。 */
export async function markGoalEvaluated(
  id: string,
  runId: string,
  passed: boolean,
  evalText: string,
): Promise<void> {
  await runQuery(
    `UPDATE goals
        SET last_eval = $3, last_eval_passed = $4, last_eval_run_id = $2::uuid,
            status = CASE WHEN $4 THEN 'achieved' ELSE 'active' END,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [id, runId, evalText, passed],
  )
}

export async function deleteGoal(id: string): Promise<boolean> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM goals WHERE id = $1::uuid RETURNING id`,
    [id],
  )
  return records.length > 0
}

/** 一个 goal 名下的 run 谱系（目标详情时间线）。 */
export async function listGoalRuns(goalId: string): Promise<
  Array<{
    id: string
    status: string
    created_at: Date
    finished_at: Date | null
    duration_ms: number | null
    cost: string | number | null
    flow_name: string | null
  }>
> {
  const { records } = await runQuery<{
    id: string
    status: string
    created_at: Date
    finished_at: Date | null
    duration_ms: number | null
    cost: string | number | null
    flow_name: string | null
  }>(
    `SELECT r.id, r.status, r.created_at, r.finished_at, r.duration_ms, r.cost, f.name AS flow_name
       FROM runs r LEFT JOIN flows f ON f.id::text = r.pipeline_id::text
      WHERE r.goal_id = $1::uuid
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [goalId],
  )
  return records
}

/** 自动推进候选：auto 且 active、无运行中 run、未到轮次/预算上限。 */
export async function listAutoAdvanceCandidates(): Promise<
  Array<{
    id: string
    flow_id: string | null
    directory_id: string | null
    budget_usd: string | null
    round: number
    max_rounds: number
    title: string
    acceptance: string
    description: string
  }>
> {
  const { records } = await runQuery<{
    id: string
    flow_id: string | null
    directory_id: string | null
    budget_usd: string | null
    round: number
    max_rounds: number
    title: string
    acceptance: string
    description: string
  }>(
    `SELECT g.id, g.flow_id, g.directory_id, g.budget_usd, g.round, g.max_rounds,
            g.title, g.acceptance, g.description
       FROM goals g
      WHERE g.auto AND g.status = 'active' AND g.flow_id IS NOT NULL
        AND g.round < g.max_rounds
        AND NOT EXISTS (
          SELECT 1 FROM runs r
           WHERE r.goal_id = g.id AND r.status IN ('running', 'awaiting_input')
        )
      ORDER BY g.updated_at ASC
      LIMIT 10`,
  )
  return records
}
