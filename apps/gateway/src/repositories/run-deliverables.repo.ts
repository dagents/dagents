/**
 * run-deliverables.repo.ts —— R6 渐进产物：run 产出清单的读侧单点。
 *
 * 读源裁决（design-artifacts.md §①-2）：**journal 主、spans 兜底**——
 *  - 主路：`run_node_journal` 的 `kind='decision'` 行（R1 真相源，迁移
 *    1720000110000；payload 自带 output 全文与 tokens，无需回查）。种子
 *    节点在新 run 由引擎 cached 钩子回放自产 cached decision 行（带
 *    lineage.inheritedFromRunId），**新 run 的 journal 自足**——本 repo
 *    不做任何跨 run 谱系遍历（v1.1 修订撤回，沿链查找只属 R2 一处）。
 *  - 兜底路：该 runId 无任何 decision 行（journal 落地前的存量 run /
 *    journal-writer 未接线的窗口期）→ 回退 `run_node_spans` 投影
 *    （status/output/tokens 既有列直读；迭代体只有末次——spans 是
 *    (run_id, node_id) 覆盖语义的观测投影，诚实降级不伪装完整）；
 *    spans 无 lineage 载荷，`inheritedFromRunId` 恒 null。
 *
 * 两路都 join `flows` 判子流程归属名（flow_id ≠ runs.pipeline_id 时取
 * flows.name；join 用 `f.id::text = <flow_id>` 显式 cast，先例
 * runs.repo.ts:118）。排序契约：服务端按实例键序返回（node_id, ordinal），
 * **拓扑序由 console 侧重排**（服务端此端点不持有 flow_data）。
 *
 * 同文件导出 `buildRunDeliverables`（终态响应体路径，引擎视角，§③-4）：
 * 过滤引擎词表 `status === 'success'`（区别于投影词表
 * DELIVERABLE_STATUSES）；executeFlow 子节点在引擎 executedNodes 无 flow
 * 语境，subflowName 恒 null——归属标注以读面为准（§⑤-6 诚实呈现差异）。
 */
import { runQuery } from '@dagents/db'
import { DELIVERABLE_STATUSES, type DeliverableItem } from '@dagents/contracts'
import { declareCounter } from '../lib/metrics.js'

/**
 * NFR-6 可观测：三路产出条目数（journal 主路 / spans 兜底降级 / 终态
 * 响应体）——spans 兜底的发生量即「journal 未覆盖窗口期」的留痕。
 * declareCounter 先例 workflow-engine-service.ts:36-50（业务模块在自己
 * 作用域声明，metrics.ts 只持注册表——metrics.ts:9 反向依赖纪律）。
 */
export const deliverablesCounter = declareCounter(
  'dagents_run_deliverables_items_total',
  'Deliverable items served per source (journal projection / spans fallback / terminal response body)',
  ['source'],
)

/** 读源标记（metrics label 与调用方语义判别共用）。 */
export type DeliverablesSource = 'journal' | 'spans'

/** 投影输入行：journal decision 行与 spans 兜底行的宽松并集形状。 */
export interface DeliverableSourceRow {
  node_id: string
  node_label?: string | null
  node_type?: string | null
  ordinal?: number | null
  /** spans 兜底路的产出态列；journal 路缺席（从 payload 读）。 */
  status?: string | null
  tokens?: unknown
  output?: unknown
  /** journal decision 载荷（在场时 status/output/tokens/lineage 从中读）。 */
  payload?: unknown
  subflow_name?: string | null
  is_subflow?: boolean | null
}

/**
 * 纯投影：journal 行与 spans 兜底行归一到 DeliverableItem。
 *  - 迭代多 ordinal 保留独立条目（机器面条目粒度 = 实例键）；
 *  - journal 行透传 payload.lineage.inheritedFromRunId（继承标注唯一来源）；
 *  - 词表外状态行（防御：SQL 已过滤，此处再守一道）静默剔除。
 */
export function projectDeliverableRows(rows: DeliverableSourceRow[]): DeliverableItem[] {
  const items: DeliverableItem[] = []
  for (const row of rows) {
    const payload =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : null
    const status = String(payload ? (payload.status ?? '') : (row.status ?? ''))
    if (!DELIVERABLE_STATUSES.includes(status)) continue
    const lineage =
      payload?.lineage && typeof payload.lineage === 'object'
        ? (payload.lineage as { inheritedFromRunId?: unknown })
        : null
    const inheritedFromRunId =
      lineage && typeof lineage.inheritedFromRunId === 'string' && lineage.inheritedFromRunId
        ? lineage.inheritedFromRunId
        : null
    const rawOutput = payload ? (payload.output ?? null) : (row.output ?? null)
    const output: DeliverableItem['output'] =
      rawOutput == null || typeof rawOutput === 'string' || typeof rawOutput === 'object'
        ? (rawOutput as DeliverableItem['output'])
        : null
    items.push({
      nodeId: row.node_id,
      nodeLabel: row.node_label ?? null,
      nodeType: row.node_type ?? null,
      ordinal: typeof row.ordinal === 'number' ? row.ordinal : 0,
      status,
      tokens: payload ? (payload.tokens ?? null) : (row.tokens ?? null),
      output,
      inheritedFromRunId,
      subflowName:
        row.is_subflow === true && typeof row.subflow_name === 'string' ? row.subflow_name : null,
    })
  }
  return items
}

/** buildRunDeliverables 的引擎节点入参（IExecutedNode 的最小结构投影）。 */
export interface ExecutedNodeLike {
  nodeId: string
  /** 引擎注册名（IExecutedNode.nodeName = flowNode.data.name，类型名非 label）。 */
  nodeName: string
  status: string
  ordinal: number
  output: Record<string, unknown>
  tokens?: unknown
}

/**
 * 终态响应体的清单投影（§③-4）：过滤引擎词表 `status === 'success'`，
 * output/tokens 原样引用；同 run 直跑无继承（inheritedFromRunId 恒 null）、
 * 无 flow 语境（subflowName 恒 null，归属标注以读面为准）。
 */
export function buildRunDeliverables(
  executedNodes: ReadonlyArray<ExecutedNodeLike>,
  nodeLabelById?: ReadonlyMap<string, string | null>,
  nodeTypeById?: ReadonlyMap<string, string | null>,
): DeliverableItem[] {
  const items: DeliverableItem[] = []
  for (const en of executedNodes) {
    if (en.status !== 'success') continue
    items.push({
      nodeId: en.nodeId,
      nodeLabel: nodeLabelById?.get(en.nodeId) ?? null,
      nodeType: nodeTypeById?.get(en.nodeId) ?? en.nodeName ?? null,
      ordinal: typeof en.ordinal === 'number' ? en.ordinal : 0,
      status: 'done',
      tokens: en.tokens ?? null,
      output: en.output ?? null,
      inheritedFromRunId: null,
      subflowName: null,
    })
  }
  return items
}

/**
 * 一个 run 的产出清单（journal 主路 + spans 兜底路，§③-2）。
 *
 * 返回 `{ items, source }`——source 供 metrics label（NFR-6「降级留痕」）
 * 与调用方判别。journal 主路启用条件：该 runId 存在**任意** decision 行
 * （不止是词表内的）——有 decision 行即 journal 对该 run 权威（全 failed
 * 的 run 清单为空是诚实事实，不回退 spans 造数）。
 */
export async function getRunDeliverables(
  runId: string,
): Promise<{ items: DeliverableItem[]; source: DeliverablesSource }> {
  // ── 主路：journal decision 行（payload.status 词表过滤在 SQL；label/type
  // journal 无列，LEFT JOIN spans 借观测投影的元数据——span-writer 对所有
  // 执行过的节点都有行，缺行（理论边角）时 label/type 诚实为 null）。
  const { records: journalRows } = await runQuery<DeliverableSourceRow>(
    `SELECT j.node_id,
            j.ordinal,
            j.payload,
            s.node_label,
            s.node_type,
            (j.flow_id <> r.pipeline_id) AS is_subflow,
            f.name AS subflow_name
       FROM run_node_journal j
       LEFT JOIN runs r ON r.id = j.run_id
       LEFT JOIN run_node_spans s ON s.run_id = j.run_id AND s.node_id = j.node_id
       LEFT JOIN flows f ON f.id::text = j.flow_id
      WHERE j.run_id = $1::uuid
        AND j.kind = 'decision'
        AND j.payload->>'status' = ANY($2::text[])
      ORDER BY j.node_id ASC, j.ordinal ASC`,
    [runId, [...DELIVERABLE_STATUSES]],
  )
  if (journalRows.length > 0) {
    return { items: projectDeliverableRows(journalRows), source: 'journal' }
  }
  // 零命中区分「journal 权威但全不在词表」与「journal 未覆盖」：
  // 有任意 decision 行 → journal 权威，清单为空（不回退）。
  const { records: probe } = await runQuery<{ one: number }>(
    `SELECT 1 AS one FROM run_node_journal
      WHERE run_id = $1::uuid AND kind = 'decision' LIMIT 1`,
    [runId],
  )
  if (probe.length > 0) return { items: [], source: 'journal' }

  // ── 兜底路：spans 投影（存量 run / journal 写侧未接线的窗口期）。
  // ordinal 只作标注列（AD-R1：不进键，迭代体末次覆盖——诚实降级）。
  const { records: spanRows } = await runQuery<DeliverableSourceRow>(
    `SELECT s.node_id,
            s.node_label,
            s.node_type,
            s.ordinal,
            s.status,
            s.tokens,
            s.output,
            (s.flow_id <> r.pipeline_id) AS is_subflow,
            f.name AS subflow_name
       FROM run_node_spans s
       LEFT JOIN runs r ON r.id = s.run_id
       LEFT JOIN flows f ON f.id::text = s.flow_id
      WHERE s.run_id = $1::uuid
        AND s.status = ANY($2::text[])
      ORDER BY s.node_id ASC, s.ordinal ASC`,
    [runId, [...DELIVERABLE_STATUSES]],
  )
  return { items: projectDeliverableRows(spanRows), source: 'spans' }
}
