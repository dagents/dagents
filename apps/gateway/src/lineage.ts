/**
 * lineage —— run 谱系链共享 helper（design-recover §3.7(b)1，评审修订：
 * 与 R6 的递归遍历是同一条链，抽单源）。
 *
 * 沿 `runs.resumed_from_run_id` 溯源至根：resume / 暖缓存重跑（R2.1 定稿
 * 后谱系列是暖缓存第一等公民）都写谱系，链上任何前驱的 journal decision
 * 都是暖缓存候选。深度上限统一 16（防环护栏内建——谱系环在理论上不可
 * 构造，上限是纵深防御）；断链语义：链上任一 run 被 retention 清掉 →
 * 该跳之后查不到 → 该前驱不进候选（诚实 miss，不报错，R2.6）。
 *
 * 返回序：**自根向后代**（含 runId 自身在末位）——链上「最近」= 数组末尾
 * 往前，暖缓存取最近命中（PRD R2.1）直接倒序遍历。
 */
import { runQuery } from '@dagents/db'

/** 谱系链深度上限（R6 原案 10 / 本方向原案 32，评审定稿统一 16）。 */
export const LINEAGE_MAX_DEPTH = 16

export async function runLineageChain(runId: string): Promise<string[]> {
  const chain: string[] = []
  let current: string | null = runId
  const seen = new Set<string>()
  while (current && chain.length < LINEAGE_MAX_DEPTH) {
    if (seen.has(current)) break // 环护栏（纵深防御）
    seen.add(current)
    const query = runQuery<{ resumed_from_run_id: string | null }>(
      `SELECT resumed_from_run_id FROM runs WHERE id = $1::uuid`,
      [current],
    )
    const records: Array<{ resumed_from_run_id: string | null }> = (
      await query.catch(() => ({ records: [] as Array<{ resumed_from_run_id: string | null }> }))
    ).records
    const row = records[0]
    // 断链语义（R2.6 诚实 miss）：行不存在（retention 清掉 / 从未有）=
    // 该 run 不进候选——链停在最后一个**真实存在**的 run；行存在但谱系为
    // null（根运行）同样终止。空链 = 整链 miss（调用方按零候选全量重跑）。
    if (!row) break
    chain.push(current)
    current = row.resumed_from_run_id ?? null
  }
  // 自根向后代：查询是从 runId 向根溯源的，反转即根在前。
  chain.reverse()
  return chain
}

/**
 * 谱系链的累计 token（R3.4 budget resume 黄警 / R2 双口径对账）：
 * `usage_events` 按 runId 记账（AD-3 唯一真相源），SUM 链上全部 run 的
 * inputTokens+outputTokens。失败返回 0（对账披露是增益不是依赖）。
 */
export async function lineageTokensSpent(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0
  try {
    const { records } = await runQuery<{ total: string | null }>(
      `SELECT SUM(COALESCE((usage->>'inputTokens')::bigint, 0)
                   + COALESCE((usage->>'outputTokens')::bigint, 0)) AS total
         FROM usage_events
        WHERE run_id = ANY($1::uuid[])`,
      [runIds],
    )
    return Number(records[0]?.total ?? 0)
  } catch {
    return 0
  }
}
