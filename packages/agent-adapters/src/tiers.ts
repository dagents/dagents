/**
 * Adapter maintenance tiers (docs/product-plan.md 方案 E — 适配器诚实分级).
 *
 * Single source of truth for how much a CLI adapter can be trusted. The
 * gateway's /cli-runtimes response and the console's CLI detection cards
 * render from here; README keeps a generated-by-hand copy and must stay in
 * sync (update it in the same PR when changing a tier).
 *
 * Tiers:
 *   core       — 承诺保真维护：真机回归 + 取消/超时路径优先支持。
 *                regression 字段是承诺的对账单：core + docs-only = **回归
 *                欠账**（不要把 core 读成「已验证」——2026-09-17 勘误：
 *                claude 是唯一 verified 的 core；codex/qwen 的真机回归
 *                由 .github/workflows/real-cli.yml 在有 CLI 的 runner 上补）
 *   community  — 正常接受 PR，但明示维护等级与实测状态
 *
 * Regression status:
 *   verified           — 有真机回归（夹具入仓或实测记录）
 *   docs-only          — 按官方文档实现，未在真实 CLI 上回归
 *   community-reported — 仅社区报告可用
 */
import type { AgentType } from '@dagents/contracts'

export type AdapterTier = 'core' | 'community'
export type RegressionStatus = 'verified' | 'docs-only' | 'community-reported'

export interface AdapterTierInfo {
  tier: AdapterTier
  regression: RegressionStatus
  /** Optional caveat surfaced in the UI tooltip / README. */
  note?: string
}

export const ADAPTER_TIERS: Partial<Record<AgentType, AdapterTierInfo>> = {
  claude: { tier: 'core', regression: 'verified' },
  codex: {
    tier: 'core',
    regression: 'docs-only',
    note: '按官方文档实现，待真机回归（real-cli workflow）；claude 侧的后续修复（openTurns/usage）尚未回流验证',
  },
  qwen: {
    tier: 'core',
    regression: 'docs-only',
    note: '按官方文档实现，待真机回归；自初版适配后零迭代维护（真机回归欠账最重的一项）',
  },
  copilot: { tier: 'community', regression: 'docs-only' },
  opencode: { tier: 'community', regression: 'docs-only' },
  openclaw: { tier: 'community', regression: 'verified' },
  codebuddy: { tier: 'community', regression: 'docs-only' },
  cursor: { tier: 'community', regression: 'docs-only' },
  deveco: { tier: 'community', regression: 'docs-only' },
  antigravity: { tier: 'community', regression: 'docs-only' },
  pi: { tier: 'community', regression: 'docs-only' },
  hermes: { tier: 'community', regression: 'docs-only' },
  kimi: { tier: 'community', regression: 'docs-only' },
  kiro: { tier: 'community', regression: 'docs-only' },
  grok: { tier: 'community', regression: 'docs-only' },
  qoder: { tier: 'community', regression: 'docs-only' },
  traecli: { tier: 'community', regression: 'docs-only' },
}

const UNKNOWN_TIER: AdapterTierInfo = { tier: 'community', regression: 'docs-only' }

/** Tier lookup for any kind string — unknown kinds default to community. */
export function getAdapterTier(kind: string): AdapterTierInfo {
  return ADAPTER_TIERS[kind as AgentType] ?? UNKNOWN_TIER
}
