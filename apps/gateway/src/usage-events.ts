/**
 * usage-events.ts — `usage_events` 追加式账单写入器（AD-3 / 方案 D）。
 *
 * docs/product-architecture.md AD-3：usage_events 是成本账单的**唯一真相源**
 * —— chat / workflow run / dispatch task 三条执行路径在终态各写一条，
 * 账单页只读此表。设计要点：
 *
 *   - **不造假**：单价未知时 `cost=NULL` + `priced=false`（token 照记），
 *     价格表更新后可离线回算；绝不拿别家价格折算。
 *   - **埋点不反噬主流程**：`recordUsageEvent` 的任何失败只 log.warn，
 *     永不向上抛 —— 执行本身的结果不受记账影响。
 *   - **usage 全空跳过**：没有任何 token 的终态（纯本地节点 / 未起 LLM）
 *     不产生账单事件，避免虚增事件数。
 *   - 无外键（仓库现状：运行时 raw SQL + 跨域松散引用），引用列可空；
 *     非 UUID 的 run_id（x-run-id 自定义头）会被置 NULL 而非报错。
 */
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { computeCost } from './pricing.js'

const log = createLogger({ svc: 'gateway:usage-events' })

/** usage_events.source 的三种来源（与表 CHECK 约束一致）。 */
export type UsageEventSource = 'chat' | 'workflow_run' | 'dispatch_task'

/** `recordUsageEvent` 参数。`usage` 为 token 用量结构（flat TokenUsage）。 */
export interface UsageEventParams {
  source: UsageEventSource
  chatId?: string | null
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  flowId?: string | null
  model?: string | null
  usage: object
  /** 实测/估算成本（USD）；null 或缺省 = 单价未知（priced=false）。 */
  cost?: number | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pass through valid UUIDs; anything else (incl. non-uuid x-run-id) → null. */
function uuidOrNull(id: string | null | undefined): string | null {
  return id && UUID_RE.test(id) ? id : null
}

/** Read a finite non-negative number off a usage blob, tolerating both the
 *  contracts shape (`inputTokens`) and the OpenAI shape (`prompt_tokens`). */
function tok(usage: Record<string, unknown>, keys: [string, string]): number {
  let total = 0
  for (const key of keys) {
    const v = usage[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) total += v
  }
  return total
}

/**
 * True when the usage blob carries at least one non-zero token counter.
 * Used by {@link recordUsageEvent} to skip token-less terminal states.
 */
export function hasTokens(usage: object | null | undefined): boolean {
  if (!usage || typeof usage !== 'object') return false
  const u = usage as Record<string, unknown>
  return (
    tok(u, ['inputTokens', 'prompt_tokens']) > 0 ||
    tok(u, ['outputTokens', 'completion_tokens']) > 0
  )
}

/**
 * Append one `usage_events` row (AD-3). Best-effort telemetry: DB failures are
 * logged at warn and swallowed — never let billing break an execution path.
 */
export async function recordUsageEvent(params: UsageEventParams): Promise<void> {
  if (!hasTokens(params.usage)) {
    log.debug('usage_event skipped: no tokens', { source: params.source })
    return
  }
  const priced = params.cost != null && Number.isFinite(params.cost) && params.cost >= 0
  try {
    await runQuery(
      `INSERT INTO usage_events
         (id, source, chat_id, run_id, task_id, agent_id, flow_id, model, usage, cost, priced)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        params.source,
        uuidOrNull(params.chatId),
        uuidOrNull(params.runId),
        uuidOrNull(params.taskId),
        uuidOrNull(params.agentId),
        params.flowId ?? null,
        params.model ?? null,
        JSON.stringify(params.usage),
        priced ? params.cost : null,
        priced,
      ],
    )
  } catch (err) {
    log.warn('record usage_event failed (non-fatal)', {
      source: params.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── 纯聚合（exported for unit tests, no DB) ─────────────────────────────

/** Flat summed token usage (contracts `TokenUsage` shape). */
export interface FlatUsage {
  inputTokens: number
  outputTokens: number
}

/** Rollup of one workflow run's executed nodes (usage + honest cost). */
export interface RunUsageRollup {
  usage: FlatUsage
  /** Sum of node-reported costs; null when any LLM node had no price. */
  cost: number | null
  /** True iff every token-bearing node reported a cost. */
  priced: boolean
}

/**
 * Aggregate a workflow run's `executedNodes` into one billing usage blob
 * (方案 D b 路径)。Node `tokens` may use either shape（workflow 的
 * ITokenUsage 是 prompt_tokens/completion_tokens，适配器上报是
 * inputTokens/outputTokens —— 两种都认）。Cost: sum node costs when every
 * token-bearing node has one; a token-bearing node without cost → 整单
 * priced=false + cost=null（部分价格不冒充全价）。引擎目前 cost 恒 null，
 * 即工作流 run 先以「未计价 token」入账，账单页单独列示。
 */
export function aggregateExecutedNodesUsage(
  nodes: ReadonlyArray<{ tokens?: Record<string, unknown> | null; cost?: number | null }>,
): RunUsageRollup {
  const usage: FlatUsage = { inputTokens: 0, outputTokens: 0 }
  let cost = 0
  let priced = true
  let sawTokens = false
  for (const n of nodes) {
    const t = n.tokens
    if (t && typeof t === 'object') {
      const input = tok(t, ['inputTokens', 'prompt_tokens'])
      const output = tok(t, ['outputTokens', 'completion_tokens'])
      if (input > 0 || output > 0) {
        sawTokens = true
        usage.inputTokens += input
        usage.outputTokens += output
      }
    }
    if (typeof n.cost === 'number' && Number.isFinite(n.cost)) {
      cost += n.cost
    } else if (t && typeof t === 'object' && hasTokens(t)) {
      // A token-bearing node with no cost → cannot price the run honestly.
      priced = false
    }
  }
  if (!sawTokens) return { usage, cost: null, priced: false }
  return { usage, cost: priced ? cost : null, priced }
}

/** Rollup of a dispatch task's per-model usage (`Record<model, TokenUsage>`). */
export interface DispatchUsageRollup {
  usage: FlatUsage
  /** Sum of per-model computed costs; null when any model is unpriced. */
  cost: number | null
}

/**
 * Aggregate a daemon-reported per-model usage map into one billing blob
 * (方案 D c 路径)。Per-model cost comes from `pricing.ts`（覆写优先）；
 * 任一模型无价 → cost=null（priced=false）。Per-model 明细仍留在
 * `dispatch_tasks.usage`（task_id 可回查），无需在事件里冗余。
 */
export function aggregateModelUsage(
  usage: Record<string, unknown> | undefined | null,
): DispatchUsageRollup {
  const flat: FlatUsage = { inputTokens: 0, outputTokens: 0 }
  if (!usage || typeof usage !== 'object') return { usage: flat, cost: null }
  let cost: number | null = 0
  for (const [model, raw] of Object.entries(usage)) {
    if (!raw || typeof raw !== 'object') continue
    const u = raw as { inputTokens?: unknown; outputTokens?: unknown }
    const input = typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens) ? u.inputTokens : 0
    const output = typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens) ? u.outputTokens : 0
    flat.inputTokens += input
    flat.outputTokens += output
    const modelCost = computeCost({ inputTokens: input, outputTokens: output }, model)
    if (modelCost == null) {
      // Any unpriced model poisons the sum — report tokens only.
      cost = null
    } else if (cost != null) {
      cost += modelCost
    }
  }
  return { usage: flat, cost }
}
