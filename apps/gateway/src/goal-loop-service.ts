/**
 * goal-loop-service.ts — 目标环 supervisor（方向 C，2026-11-10）。
 *
 * 「为同一目标不断前进」的推进器：一个 tick 驱动的状态机（30s 一次，
 * `GOAL_LOOP_INTERVAL_MS` 可调，0 = 关闭）——
 *
 *   advance：auto 且 active、无在跑 run、轮次/预算未尽的 goal
 *            → 组装本轮输入（目标 + 验收标准 + 上轮评估结论 + 黑板摘要）
 *            → 自 POST 网关 run 端点（?async=1，复用全部既有护栏：
 *              run 并发闸/CLI 闸/取消注册表/usage 落账）+ goalId 谱系
 *            → round+1 / last_run_id 落账
 *
 *   evaluate：last_run_id 已终态且未评估过（last_eval_run_id 去重，重启安全）
 *            → LLM judge（CLI-first client）对照验收标准判 {passed, notes}
 *            → passed ⇒ achieved；否则留在 active 等下一轮；
 *              预算/轮次耗尽 ⇒ paused（诚实停机，不无限跑）
 *
 * 设计取舍：tick 驱动而非回调驱动——run 结束没有钩子可用（自 POST 的
 * 异步路径不回传 promise），轮询 runs 行的状态是重启安全且零侵入的做法。
 * 评估用 LLM 判卷可能放水：验收标准固定在 goal 行（每轮不可自拟），
 * 且「人批准下一轮」随时可用（auto=false 即手动推进）。
 */
import { createLogger } from '@dagents/shared'
import { runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import {
  listAutoAdvanceCandidates,
  markGoalRoundStarted,
  markGoalEvaluated,
  updateGoal,
  getGoalById,
  type GoalRow,
} from './repositories/goals.repo.js'
import { createDefaultLlmClient } from './routes/workflow-clients.js'
import { readBlackboardSnapshot, buildBlackboardContext } from './lib/blackboard.js'
import { getDirectoryById } from './repositories/directories.repo.js'

const log = createLogger({ svc: 'gateway:goal-loop' })

/** tick 间隔（默认 30s；0 关闭）。 */
function LOOP_INTERVAL_MS(): number {
  const raw = Number(process.env.GOAL_LOOP_INTERVAL_MS)
  return Number.isFinite(raw) ? raw : 30_000
}

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

/** 一轮的输入模板（纯函数，单测钉格式）。 */
export function buildGoalRoundInput(
  goal: Pick<GoalRow, 'title' | 'description' | 'acceptance' | 'round' | 'last_eval'>,
  boardContext: string | null,
): string {
  const parts = [
    `# 目标：${goal.title}`,
    goal.description.trim() ? `## 背景与要求\n${goal.description.trim()}` : '',
    `## 本轮任务（第 ${goal.round + 1} 轮）`,
    goal.acceptance.trim()
      ? `验收标准（全部满足才算达成，不要自行放宽）：\n${goal.acceptance.trim()}`
      : '没有显式验收标准——认真推进目标并如实汇报进展。',
    goal.last_eval?.trim()
      ? `## 上一轮评估结论（针对差距干活）\n${goal.last_eval.trim()}`
      : '',
    boardContext ?? '',
    '完成后：把关键结论与产出沉淀进项目 `.agents/knowledge/`，并在 `.agents/BOARD.md` 更新你的任务行状态（完成 ✅ / 进行中 ◐ / 待办 ○）。',
  ]
  return parts.filter(Boolean).join('\n\n')
}

/** 预算余额检查（纯比较，便于单测）。 */
export function budgetExhausted(
  budgetUsd: string | number | null,
  totalCost: string | number | null,
): boolean {
  if (budgetUsd == null) return false
  const budget = Number(budgetUsd)
  const spent = Number(totalCost ?? 0)
  return Number.isFinite(budget) && budget > 0 && spent >= budget
}

/** 自 POST 网关自身的 run 端点：完整复用 run 并发闸/注册表/落账链路。 */
async function triggerGoalRun(
  goalId: string,
  flowId: string,
  input: string,
  directoryId: string | null,
): Promise<string> {
  const port = Number(process.env.GATEWAY_PORT ?? 8080)
  const runId = randomUUID()
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/workflows/${flowId}/run?async=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-run-id': runId },
    body: JSON.stringify({
      input,
      ...(directoryId ? { directoryId } : {}),
      goalId,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`goal run trigger failed (${res.status}): ${body.slice(0, 300)}`)
  }
  return runId
}

/** 推进一个 goal 一轮（手动 advance 与 auto tick 共用）。 */
export async function advanceGoalOnce(goalId: string): Promise<string> {
  const goal = await getGoalById(goalId)
  if (!goal) throw new Error('goal not found')
  if (!goal.flow_id) throw new Error('goal 未绑定流程（flow）——绑定后才能推进')
  if (goal.status === 'achieved' || goal.status === 'archived') {
    throw new Error(`goal 已${goal.status === 'achieved' ? '达成' : '归档'}，不能推进`)
  }
  if (budgetExhausted(goal.budget_usd, goal.total_cost)) {
    await updateGoal(goalId, { status: 'paused' })
    throw new Error('goal 预算已耗尽——自动暂停（可调预算后恢复）')
  }
  if (goal.round >= goal.max_rounds) {
    await updateGoal(goalId, { status: 'paused' })
    throw new Error(`已达轮次上限（${goal.max_rounds}）——自动暂停`)
  }

  // 黑板上下文（有目录才有）：本轮输入带上团队共享知识
  let boardContext: string | null = null
  if (goal.directory_id) {
    const dir = await getDirectoryById(goal.directory_id).catch(() => null)
    if (dir) boardContext = buildBlackboardContext(readBlackboardSnapshot(dir.path))
  }

  const input = buildGoalRoundInput(goal, boardContext)
  const runId = await triggerGoalRun(goalId, goal.flow_id, input, goal.directory_id)
  await markGoalRoundStarted(goalId, runId)
  log.info('goal round started', { goalId, runId, round: goal.round + 1 })
  return runId
}

/** 待评估 goal：last_run_id 终态且未评估过。 */
async function listPendingEvaluations(): Promise<
  Array<{ id: string; last_run_id: string }>
> {
  const { records } = await runQuery<{ id: string; last_run_id: string }>(
    `SELECT g.id, g.last_run_id
       FROM goals g
       JOIN runs r ON r.id = g.last_run_id
      WHERE g.auto = true AND g.status = 'active'
        AND g.last_run_id IS NOT NULL
        AND g.last_eval_run_id IS DISTINCT FROM g.last_run_id
        AND r.status IN ('completed', 'failed', 'cancelled', 'partial_success', 'budget_exceeded')`,
  )
  return records
}

/** LLM judge：对照验收标准评估一轮产出。宽容解析（剥围栏/找 JSON 对象；
 *  无 JSON 时按关键词判卷——judge 偶尔输出散文结论（冒烟实测），宁可
 *  诚实判定也不无限重试烧 token）。 */
export function parseEvalVerdict(raw: string): { passed: boolean; notes: string } | null {
  const fenced = raw.replace(/```(?:json)?/g, '')
  const m = fenced.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { passed?: unknown; notes?: unknown }
      if (typeof obj.passed === 'boolean') {
        return { passed: obj.passed, notes: typeof obj.notes === 'string' ? obj.notes : '' }
      }
    } catch {
      // 落到关键词判卷
    }
  }
  const text = fenced.trim()
  if (!text) return null
  // 关键词判卷（中英）：显式失败词优先（「不通过」含「通过」，必须先判否）
  if (/(不通过|未通过|没有通过|未达标|FAIL|failed)/i.test(text)) {
    return { passed: false, notes: text.slice(0, 2_000) }
  }
  if (/(通过|达标|PASS(ED)?|achieved)/i.test(text)) {
    return { passed: true, notes: text.slice(0, 2_000) }
  }
  return null
}

/** 一轮的评估材料：run.output 优先，空则回退节点 span 的产出（directReply
 *  等节点 run 级 finalOutput 可能为 null——冒烟实测；spans 是保真数据源）。 */
async function loadRoundOutput(runId: string): Promise<string> {
  const { records } = await runQuery<{ output: unknown }>(
    `SELECT output FROM runs WHERE id = $1::uuid`,
    [runId],
  )
  const runOut = records[0]?.output as { content?: unknown; output?: unknown } | null
  const fromRun =
    typeof runOut?.content === 'string'
      ? runOut.content
      : typeof runOut?.output === 'string'
        ? runOut.output
        : runOut && typeof runOut === 'object' && Object.keys(runOut).length > 0
          ? JSON.stringify(runOut)
          : null
  if (fromRun) return fromRun.slice(0, 12_000)

  const { records: spans } = await runQuery<{ output: unknown; node_label: string | null }>(
    `SELECT output, node_label FROM run_node_spans
      WHERE run_id = $1::uuid AND output IS NOT NULL AND status IN ('done', 'FINISHED', 'completed')
      ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 3`,
    [runId],
  )
  const parts = spans
    .map((s) => {
      const o = s.output as { content?: unknown; text?: unknown } | null
      const text =
        typeof o?.content === 'string' ? o.content : typeof o?.text === 'string' ? o.text : null
      return text ? `【${s.node_label ?? '节点'}】${text}` : null
    })
    .filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n').slice(0, 12_000) : '(无产出)'
}

async function evaluateGoal(goalId: string, runId: string): Promise<void> {
  const goal = await getGoalById(goalId)
  if (!goal) return
  const { records } = await runQuery<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1::uuid`,
    [runId],
  )
  const run = records[0]
  if (!run) return

  const client = createDefaultLlmClient('claude', {})
  const outputText = await loadRoundOutput(runId)

  try {
    const out = await client.chat({
      model: '',
      messages: [
        {
          role: 'system',
          content:
            '你是严格的验收评估员。对照给定的验收标准评估一轮工作产出。你的回复必须是且仅是一个 JSON 对象（第一个字符就是 {，最后一个字符是 }，前后不许有任何其他文字）：{"passed": boolean, "notes": string}。notes 用中文说明：通过了什么/还差什么（差距要具体可执行，供下一轮直接使用）。不要放宽标准，也不要因格式问题否定实质完成的工作。',
        },
        {
          role: 'user',
          content: [
            `# 目标\n${goal.title}\n\n# 验收标准\n${goal.acceptance.trim() || '（未显式声明——按目标描述判断实质进展）'}\n\n# 本轮 run 状态\n${run.status}\n\n# 本轮产出\n${outputText}`,
          ].join('\n'),
        },
      ],
    })
    const verdict = parseEvalVerdict(out.text)
    if (!verdict) {
      log.warn('goal eval unparseable — keep active, retry next tick', { goalId, head: out.text.slice(0, 120) })
      return
    }
    await markGoalEvaluated(goalId, runId, verdict.passed, verdict.notes)
    if (verdict.passed) {
      log.info('goal achieved', { goalId, round: goal.round })
    } else {
      log.info('goal eval: gaps remain', { goalId, round: goal.round })
    }
  } catch (err) {
    // 评估失败不推进状态机（下个 tick 重试）；LLM 持续失败时 goal 停在 active
    log.warn('goal eval call failed — will retry next tick', { goalId, error: String(err) })
  }
}

/** 一次 tick：先评估、后推进（评估上轮终态产出 → 决定是否还需要下一轮；
 *  顺序反了会让 last_run_id 被新一轮抢先更新，评估永远追不上终态 run ——
 *  冒烟实测逮出）。两段互不阻塞，各自容错。 */
export async function goalLoopTick(): Promise<void> {
  // evaluate：终态且未评估的 last_run（passed ⇒ achieved ⇒ 下面的 advance 不再选它）
  try {
    const pending = await listPendingEvaluations()
    for (const p of pending) {
      await evaluateGoal(p.id, p.last_run_id)
    }
  } catch (err) {
    log.warn('goal eval sweep failed', { error: String(err) })
  }
  // advance：候选 goal 逐个触发（失败只记日志，不影响其他 goal）
  try {
    const candidates = await listAutoAdvanceCandidates()
    for (const g of candidates) {
      try {
        // 预算/轮次终检（SQL 候选只粗筛轮次，预算在 advance 内精查并自动 paused）
        await advanceGoalOnce(g.id)
      } catch (err) {
        log.warn('goal advance failed', { goalId: g.id, error: String(err) })
      }
    }
  } catch (err) {
    log.warn('goal advance sweep failed', { error: String(err) })
  }
}

/** boot 启动（index.ts 调用；DB ready 之后）。 */
export function startGoalLoop(): void {
  const interval = LOOP_INTERVAL_MS()
  if (interval <= 0 || timer) return
  timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void goalLoopTick()
      .catch(() => {})
      .finally(() => {
        ticking = false
      })
  }, interval)
  log.info('goal loop started', { intervalMs: interval })
}

/** 优雅停机（shutdown 链调用）。 */
export function stopGoalLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('goal loop stopped')
  }
}
