/**
 * usage-summary.ts — 账单页数据层（方案 D / AD-3，Settings → 用量与成本）。
 *
 * 与 gateway `GET /api/v1/usage/summary` 对齐的 typed domain model +
 * thin fetch wrapper（throw on non-2xx，镜像 agents-catalog.ts 的模式）+
 * **纯** 展示变换（`formatUsd` / `formatTokens` / `dayBars`）—— 纯函数
 * 不碰网络 / React，vitest node 环境直接单测（matching
 * agents-catalog.test.ts）。数字一律来自 gateway 聚合，前端不再折算。
 */

/** 汇总口径下的总量（美元 / token / 未计价 token / 事件数）。 */
export interface UsageTotals {
  cost: number
  tokens: number
  /** 单价未知（priced=false）的 token —— 价格表补齐后可回算。 */
  unpricedTokens: number
  events: number
}

/** 按天一行（YYYY-MM-DD，会话时区）。 */
export interface UsageByDay {
  date: string
  cost: number
  tokens: number
}

/** 按 Agent 一行（agentName 为 null = agent 已删除）。 */
export interface UsageByAgent {
  agentId?: string
  agentName?: string | null
  cost: number
  tokens: number
  /** 该组内全部事件是否都已计价（false = 含未计价 token）。 */
  priced: boolean
}

/** 按 Flow 一行（flowName 为 null = flow 已删除）。 */
export interface UsageByFlow {
  flowId?: string
  flowName?: string | null
  cost: number
  tokens: number
}

/** `GET /api/v1/usage/summary` 的 data 形状。 */
export interface UsageSummary {
  totals: UsageTotals
  byDay: UsageByDay[]
  byAgent: UsageByAgent[]
  byFlow: UsageByFlow[]
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** Fetch the billing summary. Throws on non-2xx / non-success envelope. */
export async function fetchUsageSummary(days: number): Promise<UsageSummary> {
  const res = await fetch(`/api/usage/summary?days=${days}`, { cache: 'no-store' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`usage summary failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<UsageSummary>
  if (!body.success || body.data === undefined) {
    throw new Error(`usage summary failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

// ─── 纯展示变换（unit-tested） ──────────────────────────────────────────

/**
 * Format a USD amount. `< $0.01` shows `$0.01`（账单页不显示 $0.00 的
 * 真实花费）；null/undefined/NaN → '—'.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}

/**
 * Format a token count with k/M suffixes（12,340 → 「12.3k」）。0 → 「0」；
 * null/undefined → '—'.
 */
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** One bar in the byDay chart（宽度按最大日成本归一）。 */
export interface DayBar {
  date: string
  /** Formatted USD cost of the day. */
  costLabel: string
  /** Bar width as a percentage of the window's max daily cost (0–100). */
  pct: number
}

/**
 * Turn byDay rows into bar-chart rows: width normalized to the max daily
 * cost in the window (max → 100%). Days with zero cost keep a hairline 0 so
 * the chart shows gaps honestly rather than fabricating data.
 */
export function dayBars(byDay: UsageByDay[]): DayBar[] {
  const max = byDay.reduce((m, d) => Math.max(m, d.cost), 0)
  return byDay.map((d) => ({
    date: d.date,
    costLabel: formatUsd(d.cost),
    pct: max > 0 ? Math.max(d.cost > 0 ? 1 : 0, Math.round((d.cost / max) * 100)) : 0,
  }))
}
