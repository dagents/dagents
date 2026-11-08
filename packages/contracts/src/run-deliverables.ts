/**
 * run-deliverables.ts —— R6 渐进产物：run 产出清单（deliverables）契约。
 *
 * 单文件承载类型 + 词表 + 正文提取纯函数（design-artifacts.md §②）：
 *  - `DeliverableItem`：清单条目的跨端单一形状（gateway 投影 ↔ console
 *    聚合区）。`output` 原样引用——服务端不提取不截断（决策 D），单行
 *    预览由消费端用 `extractDeliverableText` 同一函数派生，杜绝第二套口径。
 *  - `DELIVERABLE_STATUSES`：「已完成节点」的词表单源，横跨 journal
 *    decision `payload.status` 与 spans 兜底 `status` 两路过滤。'cached'
 *    的前置已落地（spans CHECK 放宽迁移 1720000106200 + 引擎 cached 钩子
 *    回放，2026-10-07 可恢复性地基批次）。failed/paused/unknown/running
 *    不入清单；过滤按节点产出态、不按 run 终态（cancelled/stopped run
 *    照常交付已完成部分）。
 *  - `extractDeliverableText`：正文提取单源（text/content 直出 +
 *    DirectReply 字符串化 JSON 二次解包），实现自 console
 *    `run-terminal-format.ts` 的 `extractOutputText` 原样上移（R6 需求 4
 *    「同一提取单源」的物理载体）——console 侧改为 re-export，语义逐字
 *    不变（搬家回归钉子在 contracts / console 两侧单测）。
 */

/** 产出清单条目（gateway 投影与 console 聚合区共用形状）。 */
export interface DeliverableItem {
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  /** R1 实例键序号（AD-R4）：非迭代节点恒 0；迭代 body 第 n 次执行 = n。 */
  ordinal: number
  /** 节点产出态，词表 = DELIVERABLE_STATUSES（'done' | 'cached'）。 */
  status: string
  /** 原样引用（Record/string/null）——徽章与预览由消费端派生。 */
  tokens: unknown
  /** 产出原样引用，服务端不提取不截断（决策 D）。 */
  output: Record<string, unknown> | string | null
  /**
   * 继承标注唯一来源：journal decision `payload.lineage.inheritedFromRunId`
   * 的透传（R1 cached 钩子回放写入、R2 暖缓存命中同字段）；非继承产出
   * 为 null——消费端只透传展示，不自行沿谱系链推导。
   */
  inheritedFromRunId: string | null
  /** 服务端判定的子流程归属名（journal/spans 的 flow_id ≠ runs.pipeline_id
   *  时 join flows.name）；根图节点为 null——客户端零归属判定逻辑。 */
  subflowName: string | null
}

/** 「已完成节点」词表单源（journal 主路 + spans 兜底两路共用）。 */
export const DELIVERABLE_STATUSES: readonly string[] = ['done', 'cached']

/**
 * 正文提取：text/content 直出；DirectReply 的字符串化 JSON 二次解包。
 * 语义与 console 旧 `extractOutputText` 逐字一致（上移搬家，不改行为）。
 */
export function extractDeliverableText(
  payload: Record<string, unknown> | string | null | undefined,
): string | null {
  if (payload == null) return null
  if (typeof payload === 'string') return payload || null
  const obj = payload as Record<string, unknown>
  let textField =
    typeof obj.text === 'string' && obj.text
      ? obj.text
      : typeof obj.content === 'string' && obj.content
        ? obj.content
        : null
  if (textField && textField.trimStart().startsWith('{')) {
    try {
      const inner = JSON.parse(textField) as Record<string, unknown>
      if (typeof inner.text === 'string' && inner.text) textField = inner.text
      else if (typeof inner.content === 'string' && inner.content) textField = inner.content
    } catch {
      /* 保持原样 */
    }
  }
  return textField || null
}
