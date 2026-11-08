/**
 * run-tokens —— run 级 token 双口径纯函数（PRD R2.3 定稿，design-recover
 * §3.7(c)/§4.2，2026-10-08 修复）：「lineage 继承累计 + 本次新增」。
 *  - 继承侧：gateway node-spans 端点的 lineageTokens（谱系链前驱
 *    usage_events SUM——usage_events 只记真实调用，cached 节点天然不入账，
 *    AC-R2-3 无重复记账）+ 本 run 内 cached span 携带的继承值（种子组装的
 *    seedTokens，journal decision 的 payload.tokens）；
 *  - 新增侧：本 run 真实执行节点（非 cached span）的 tokens 合计。
 *
 * 纯函数（本模块）供结果面板/执行卡的展示派生与单测；账单页口径 =
 * usage_events（只计新增侧）——两侧经同一「cached 不入账」规则一致。
 */
import type { RunNodeSpan } from '@/lib/node-spans'

/** 双口径结果（token 数；0 = 该侧无数据）。 */
export interface RunTokensBySource {
  /** 本次新增：非 cached 节点的 tokens 合计（= usage_events 记账面）。 */
  fresh: number
  /** 谱系继承：本 run 内 cached span 的继承 tokens 合计（前驱在本 run 的
   *  复用面；谱系更早的前驱累计由端点 lineageTokens 另计）。 */
  cached: number
}

function spanTotalTokens(sp: RunNodeSpan): number {
  const u = sp.tokens as
    | { inputTokens?: number; outputTokens?: number; prompt_tokens?: number; completion_tokens?: number }
    | null
    | undefined
  if (!u || typeof u !== 'object') return 0
  const input = u.inputTokens ?? u.prompt_tokens ?? 0
  const output = u.outputTokens ?? u.completion_tokens ?? 0
  return (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0)
}

/** 按 span 来源分桶（cached = 种子命中继承，其余 = 真实执行）。 */
export function splitTokensBySource(spans: ReadonlyArray<RunNodeSpan>): RunTokensBySource {
  let fresh = 0
  let cached = 0
  for (const sp of spans) {
    if (sp.status === 'cached') cached += spanTotalTokens(sp)
    else fresh += spanTotalTokens(sp)
  }
  return { fresh, cached }
}

/**
 * 双口径展示文案的数值对（AC-R2-3 第一分句「总 token = 前驱累计 + 本次
 * 新增」）：lineageTokens 为端点透出的谱系前驱累计（null = 根运行，无
 * 双口径）；本 run 的 cached 继承值叠加到继承侧（谱系 SUM 不含本 run 的
 * cached 展示值——它属于「本 run 复用了多少前驱产出」的同族口径）。
 */
export function dualBasisTokens(
  spans: ReadonlyArray<RunNodeSpan>,
  lineageTokens: number | null,
): { inherited: number; fresh: number; total: number } | null {
  if (lineageTokens == null) return null
  const { fresh, cached } = splitTokensBySource(spans)
  const inherited = lineageTokens + cached
  // 两侧皆零 = 零数据（如纯本地节点 run）——null 让面板不渲染空行。
  if (inherited === 0 && fresh === 0) return null
  return { inherited, fresh, total: inherited + fresh }
}
