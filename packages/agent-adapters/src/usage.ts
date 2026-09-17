import type { TokenUsage } from '@dagents/contracts'

/**
 * per-model usage 累积单源（2026-09-17 评审收敛）。
 *
 * 此前 anthropic 系事件流（claude / qwen / codex）各自维护一份几乎相同的
 * 累积逻辑，且策略分叉无注释：claude/qwen 的 usage 帧是**逐消息增量**
 * （求和），codex 的 turn.completed 帧是**会话累计值**（取 max，重复帧
 * 不重复计入）。错配会把 usage 翻倍或清零 —— 语义在这里一次性写清。
 *
 * 结构性例外（不强行并入）：codebuddy 是「整张 usage 快照直接替换」、
 * copilot 是「单字段 outputTokens 增量」——语义不同，留在各自适配器。
 */

/** Anthropic 系 CLI 事件里的原始 usage 形状（snake_case）。 */
export interface RawTokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** codex 变体字段：cached_input_tokens。 */
  cached_input_tokens?: number
}

export type UsageStrategy = 'sum' | 'max'

/**
 * 把一帧原始 usage 累积进 per-model 表。
 * - `sum`：帧是逐消息增量（claude assistant 消息、qwen message 帧）
 * - `max`：帧是会话累计快照（codex turn.completed 可能重发，取 max 防重复计数）
 * cache 类字段恒为求和（快照帧对 cache 的口径在各 CLI 间是增量）。
 */
export function accumulateUsage(
  usage: Record<string, TokenUsage>,
  model: string | undefined,
  raw: RawTokenUsage | undefined,
  strategy: UsageStrategy = 'sum',
): void {
  if (!raw || !model) return
  const existing = usage[model] ?? { inputTokens: 0, outputTokens: 0 }
  if (strategy === 'max') {
    existing.inputTokens = Math.max(existing.inputTokens, raw.input_tokens ?? 0)
    existing.outputTokens = Math.max(existing.outputTokens, raw.output_tokens ?? 0)
  } else {
    existing.inputTokens += raw.input_tokens ?? 0
    existing.outputTokens += raw.output_tokens ?? 0
  }
  existing.cacheReadTokens =
    (existing.cacheReadTokens ?? 0) +
    (raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? 0)
  // 与旧 claude 实现的形状契约一致：字段恒定存在，缺省 0（消费方
  // toEqual 钉住了这个形状，见 claude.usage.test.ts）。
  existing.cacheWriteTokens =
    (existing.cacheWriteTokens ?? 0) + (raw.cache_creation_input_tokens ?? 0)
  usage[model] = existing
}
