/**
 * run-node-journal.repo —— `run_node_journal` 的读侧单点（design-recover
 * §3.7(b)，AD-R2）。
 *
 * journal 的全部读查询集中在此（列名映射 / payload 形状收敛唯一归属）：
 *  - `findDecisions` / `findDecision`：R1 resume 种子组装（buildResumeSeed）
 *    与引擎迭代断点短路（JournalFacade.lookup）；
 *  - `findLatestDecisionByNodeAndHash`：R2 暖缓存 (nodeId, inputHash) 查找
 *    （buildWarmCacheSeed 沿谱系链逐 run 查询，取链上最近命中）；
 *  - `listEventFrames`：R7 live 404 回放（execution-live 由 journal 前缀
 *    透明重建 hello.replay）。
 *
 * 写侧在 journal-writer.ts（§3.4）；「journal 单点」的准确表述是读侧形状
 * 集中在这一个 repo + 写侧单点 writer，不是「全 gateway 只一处触碰表名」。
 */
import { runQuery, type JournalDecisionPayload } from '@dagents/db'

/** decision 行的规范读形状（payload 已收窄；seq/event_type 对读侧无意义）。 */
export interface JournalDecisionRow {
  runId: string
  nodeId: string
  ordinal: number
  payload: JournalDecisionPayload
}

/**
 * 一个 run 的全部 decision 行（status ∈ done/cached 过滤可选）。
 * R1 resume 种子：`{ statuses: ['done', 'cached'] }` —— failed 行不进种子
 * （「试过且失败」的事实入档，重跑语义由 PRD R1.3 定稿）。
 */
export async function findDecisions(
  runId: string,
  opts: { statuses?: Array<'done' | 'failed' | 'cached'> } = {},
): Promise<JournalDecisionRow[]> {
  const statuses = opts.statuses
  const { records } = await runQuery<{
    run_id: string
    node_id: string
    ordinal: number
    payload: JournalDecisionPayload
  }>(
    `SELECT run_id, node_id, ordinal, payload
       FROM run_node_journal
      WHERE run_id = $1::uuid AND kind = 'decision'
        ${statuses ? `AND payload->>'status' = ANY($2::text[])` : ''}
      ORDER BY seq ASC`,
    statuses ? [runId, statuses] : [runId],
  )
  return records.map((r) => ({
    runId: r.run_id,
    nodeId: r.node_id,
    ordinal: r.ordinal,
    payload: r.payload,
  }))
}

/** 单条 decision（引擎 JournalFacade.lookup 的迭代断点短路寻址）。 */
export async function findDecision(
  runId: string,
  nodeId: string,
  ordinal: number,
): Promise<JournalDecisionRow | null> {
  const { records } = await runQuery<{
    run_id: string
    node_id: string
    ordinal: number
    payload: JournalDecisionPayload
  }>(
    `SELECT run_id, node_id, ordinal, payload
       FROM run_node_journal
      WHERE run_id = $1::uuid AND kind = 'decision' AND node_id = $2 AND ordinal = $3
      LIMIT 1`,
    [runId, nodeId, ordinal],
  )
  const r = records[0]
  return r ? { runId: r.run_id, nodeId: r.node_id, ordinal: r.ordinal, payload: r.payload } : null
}

/**
 * 暖缓存查找（R2，design-recover §3.7(b)2）：沿谱系链的多个 run 里查
 * `nodeId` 的 ordinal=0 decision，返回 inputHash 精确匹配的**链上最近**命中
 * （候选序 = 调用方传入的 runIds 序，链上最近优先——`recentFirst`）。
 * `payload->>'status' IN ('done','cached')`：failed 行不是可复用产出。
 */
export async function findLatestDecisionByNodeAndHash(
  runIds: string[],
  nodeId: string,
  inputHash: string,
  opts: { recentFirst?: boolean } = {},
): Promise<(JournalDecisionRow & { inputHash: string }) | null> {
  if (runIds.length === 0) return null
  // ordinal 化参数占位：$1 = nodeId，$2 = inputHash，$3.. = runIds
  const idPlaceholders = runIds.map((_, i) => `$${i + 3}::uuid`).join(', ')
  const { records } = await runQuery<{
    run_id: string
    node_id: string
    ordinal: number
    input_hash: string
    payload: JournalDecisionPayload
  }>(
    `SELECT run_id, node_id, ordinal, payload->>'inputHash' AS input_hash, payload
       FROM run_node_journal
      WHERE kind = 'decision'
        AND node_id = $1
        AND ordinal = 0
        AND payload->>'status' IN ('done', 'cached')
        AND payload->>'inputHash' = $2
        AND run_id IN (${idPlaceholders})
      ORDER BY ${opts.recentFirst === false ? 'seq ASC' : 'CASE run_id ' + runIds.map((id, i) => `WHEN $${i + 3}::uuid THEN ${i}`).join(' ') + ' ELSE ${runIds.length} END ASC'}
      LIMIT 1`,
    [nodeId, inputHash, ...runIds],
  )
  const r = records[0]
  if (!r) return null
  return {
    runId: r.run_id,
    nodeId: r.node_id,
    ordinal: r.ordinal,
    inputHash: r.input_hash,
    payload: r.payload,
  }
}

/** event 行 payload → RunLiveFrame（形状契约不变，as 收窄）。 */
export type JournalEventFrame = { seq: number; nodeId: string; eventType: string | null; frame: Record<string, unknown> }

/**
 * R7 回放（§3.4(c)）：一个 run 的全部 event 行按 seq 升序。
 * `limit` 超出时返回 `truncatedHead: true`（回放上限的诚实截断标记——
 * 与 live 缓冲截断同语义，回放侧头部缺失如实呈现，不静默）。payload 是
 * RunLiveFrame 原样（含 at/seq 原值，不得重打）。
 */
export async function listEventFrames(
  runId: string,
  opts: { limit?: number } = {},
): Promise<{ frames: JournalEventFrame[]; total: number; truncatedHead: boolean; flowId: string | null }> {
  const limit = opts.limit ?? 20_000
  const { records: countRows } = await runQuery<{ total: string }>(
    `SELECT count(*) AS total FROM run_node_journal WHERE run_id = $1::uuid AND kind = 'event'`,
    [runId],
  )
  const total = Number(countRows[0]?.total ?? 0)
  const { records } = await runQuery<{
    seq: string
    node_id: string
    event_type: string | null
    payload: Record<string, unknown>
    flow_id: string | null
  }>(
    `SELECT seq, node_id, event_type, payload, flow_id
       FROM run_node_journal
      WHERE run_id = $1::uuid AND kind = 'event'
      ORDER BY seq DESC
      LIMIT $2`,
    [runId, limit],
  )
  // DESC + reverse = 取「最新 limit 条」，头部缺失（更早的行）标记截断。
  const frames = records
    .map((r) => ({
      seq: Number(r.seq),
      nodeId: r.node_id,
      eventType: r.event_type,
      frame: r.payload,
    }))
    .reverse()
  const flowId = records.length > 0 ? records[0]!.flow_id : null
  return { frames, total, truncatedHead: total > frames.length, flowId }
}

/** 该 run 是否有 journal 行（resume 端点 hasJournal 位，§3.5(c)）。 */
export async function hasJournalRows(runId: string): Promise<boolean> {
  const { records } = await runQuery<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM run_node_journal WHERE run_id = $1::uuid) AS exists`,
    [runId],
  )
  return records[0]?.exists === true
}
