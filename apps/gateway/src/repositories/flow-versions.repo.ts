/**
 * flow_versions 仓库（2026-10-04 版本化回滚）。
 *
 * 快照语义：保存结构（flow_data 变更）时把**被覆盖前的旧结构**存档——
 * 版本列表 = 「回得去的过去」。保留最近 MAX_VERSIONS 版（旧版裁剪），
 * 回滚 = 用快照覆盖 flows.flow_data 并写一条新快照（回滚本身也可撤销）。
 */

import { randomUUID } from 'node:crypto'
import { runQuery, withTransaction } from '@dagents/db'

const MAX_VERSIONS = 20

export interface FlowVersionRow {
  id: string
  flow_id: string
  name: string
  flow_data: unknown
  created_at: string
}

/** 存一份快照（flow_data 已是 JSON 值），并裁剪超出保留窗的旧版。 */
export async function snapshotFlowVersion(
  flowId: string,
  name: string,
  flowData: unknown,
  contextMd: string | null = null,
): Promise<FlowVersionRow | null> {
  try {
    const { records } = await runQuery<FlowVersionRow>(
      `INSERT INTO flow_versions (id, flow_id, name, flow_data, context_md)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
       RETURNING id, flow_id, name, flow_data, created_at`,
      [randomUUID(), flowId, name, JSON.stringify(flowData ?? {}), contextMd],
    )
    // 裁剪：每 flow 只留最近 MAX_VERSIONS 版
    await runQuery(
      `DELETE FROM flow_versions
        WHERE flow_id = $1::uuid
          AND id NOT IN (
            SELECT id FROM flow_versions WHERE flow_id = $1::uuid
            ORDER BY created_at DESC LIMIT $2
          )`,
      [flowId, MAX_VERSIONS],
    ).catch(() => {
      /* 裁剪失败不阻塞保存 */
    })
    return records[0] ?? null
  } catch {
    // 快照是保险不是依赖：入库失败不阻塞 flow 保存本身
    return null
  }
}

export async function listFlowVersions(
  flowId: string,
): Promise<Array<Pick<FlowVersionRow, 'id' | 'name' | 'created_at'> & { nodeCount: number }>> {
  const { records } = await runQuery<{
    id: string
    name: string
    created_at: string
    node_count: number
  }>(
    `SELECT v.id, v.name, v.created_at,
            jsonb_array_length(COALESCE(v.flow_data->'nodes', '[]'::jsonb)) AS node_count
       FROM flow_versions v
      WHERE v.flow_id = $1::uuid
      ORDER BY v.created_at DESC`,
    [flowId],
  )
  return records.map((r) => ({
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    nodeCount: Number(r.node_count),
  }))
}

export async function getFlowVersionFlowData(versionId: string): Promise<{
  flowId: string
  name: string
  flowData: unknown
  contextMd: string | null
} | null> {
  const { records } = await runQuery<{
    flow_id: string
    name: string
    flow_data: unknown
    context_md: string | null
  }>(`SELECT flow_id, name, flow_data, context_md FROM flow_versions WHERE id = $1::uuid`, [
    versionId,
  ])
  const row = records[0]
  if (!row) return null
  return { flowId: row.flow_id, name: row.name, flowData: row.flow_data, contextMd: row.context_md }
}

/** 回滚：当前结构先存档（撤销回滚的能力），再用快照覆盖。 */
export async function restoreFlowVersion(versionId: string): Promise<{
  flowId: string
  restoredFrom: string
} | null> {
  const version = await getFlowVersionFlowData(versionId)
  if (!version) return null

  await withTransaction(async (tx) => {
    const current = await tx<{ name: string; flow_data: unknown; context_md: string | null }>(
      `SELECT name, flow_data, context_md FROM flows WHERE id = $1::uuid`,
      [version.flowId],
    )
    const cur = current.records[0]
    if (cur) {
      await tx(
        `INSERT INTO flow_versions (id, flow_id, name, flow_data, context_md)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)`,
        [
          randomUUID(),
          version.flowId,
          cur.name,
          JSON.stringify(cur.flow_data ?? {}),
          cur.context_md ?? null,
        ],
      )
    }
    await tx(
      `UPDATE flows SET flow_data = $2::jsonb, context_md = $3, updated_at = NOW() WHERE id = $1::uuid`,
      [version.flowId, JSON.stringify(version.flowData ?? {}), version.contextMd ?? null],
    )
  })
  return { flowId: version.flowId, restoredFrom: versionId }
}
