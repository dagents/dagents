/**
 * pricing.ts — 多厂商模型价格基线（USD per 1M tokens）+ 覆写。
 *
 * docs/product-architecture.md AD-3 / 方案 D：「价格 = 代码常量基线 +
 * 覆写，不建独立价格表」。本模块是 gateway 内唯一的计价单源：
 *   1. `MODEL_PRICES` 代码常量基线（Anthropic + OpenAI + DeepSeek +
 *      Moonshot + Qwen 主流模型）；
 *   2. `DAGENTS_PRICE_OVERRIDES` 环境变量 JSON 覆写（启动时解析一次，
 *      优先于基线表 —— v1 刻意不加 llm_providers 列避免 migration）；
 *   3. `computeCost(usage, model, override?)` 显式覆写参数（优先级最高）。
 *
 * 「诚实不造假」原则：未知模型返回 `undefined`（priced=false，token 照记），
 * 绝不拿别家价格折算。参考价与真实账单的偏差由覆写校正 —— 各厂商价格
 * 随时变动，表中数值只作基线锚点。
 */
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:pricing' })

/** Per-model unit price, USD per 1M tokens. */
export interface ModelPrice {
  /** Input (prompt) tokens, USD per 1M. */
  input: number
  /** Output (completion) tokens, USD per 1M. */
  output: number
}

/**
 * Reference price table (USD per 1M tokens), keyed by model name.
 *
 * ⚠️ 参考价，可被 Provider 覆写校正（DAGENTS_PRICE_OVERRIDES / computeCost
 * 的 override 参数）。这些只在执行侧没有真值时兜底 —— cost 永远按「估算」
 * 对待，除非厂商响应自带金额。非表内模型 `computeCost` 返回 undefined，
 * 不静默套用错误价格。
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic（原 inline-executor ANTHROPIC_MODEL_PRICES 迁移至此） ──
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  // Short aliases for CLI --model flag
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  haiku: { input: 0.8, output: 4 },

  // ── OpenAI（参考价，可被覆写校正） ──
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },

  // ── DeepSeek（参考价，可被覆写校正；缓存命中价未计入） ──
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },

  // ── Moonshot（参考价，可被覆写校正） ──
  'kimi-k2-0711-preview': { input: 0.6, output: 2.5 },
  'moonshot-v1-8k': { input: 1.65, output: 1.65 },
  'moonshot-v1-32k': { input: 3.3, output: 3.3 },

  // ── Qwen / 通义千问（参考价，可被覆写校正） ──
  'qwen-max': { input: 1.6, output: 6.4 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  'qwen-turbo': { input: 0.05, output: 0.2 },
}

/**
 * Parse a `DAGENTS_PRICE_OVERRIDES`-style JSON string into a model→price map.
 *
 * Expected shape: `{"model-name":{"input":1,"output":2}}`（USD per 1M tokens）。
 * Bad JSON or malformed entries are logged + ignored（坏 JSON 不崩，只是覆写
 * 不生效，落回基线表）。Exported for unit tests.
 */
export function parsePriceOverrides(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw || raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn('DAGENTS_PRICE_OVERRIDES is not valid JSON — ignoring overrides', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('DAGENTS_PRICE_OVERRIDES is not a JSON object — ignoring overrides')
    return {}
  }
  const overrides: Record<string, ModelPrice> = {}
  for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
    if (!price || typeof price !== 'object') continue
    const { input, output } = price as { input?: unknown; output?: unknown }
    if (
      typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
      typeof output !== 'number' || !Number.isFinite(output) || output < 0
    ) {
      log.warn('DAGENTS_PRICE_OVERRIDES entry has invalid price — skipping', { model })
      continue
    }
    overrides[model] = { input, output }
  }
  return overrides
}

/** Env-level overrides, parsed once at module load（启动时解析一次）. */
const ENV_PRICE_OVERRIDES: Record<string, ModelPrice> = parsePriceOverrides(
  process.env.DAGENTS_PRICE_OVERRIDES,
)

/**
 * Compute USD cost from token usage and model name. Lookup order:
 * caller `override` → env overrides（DAGENTS_PRICE_OVERRIDES）→ `MODEL_PRICES`。
 * Returns `undefined` when usage is missing, all-zero, or the model's pricing
 * is unknown — so we never silently report a wrong cost for unlisted models.
 */
export function computeCost(
  usage: { inputTokens?: number; outputTokens?: number } | undefined | null,
  model?: string,
  override?: Record<string, ModelPrice>,
): number | undefined {
  if (!usage) return undefined
  const price =
    (model && override?.[model]) ||
    (model && ENV_PRICE_OVERRIDES[model]) ||
    (model ? MODEL_PRICES[model] : undefined)
  if (!price) {
    // Unknown model: report token usage but don't fabricate a cost.
    log.debug('computeCost: unknown model, skipping cost', { model })
    return undefined
  }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  if (input === 0 && output === 0) return undefined
  return (input * price.input + output * price.output) / 1_000_000
}
