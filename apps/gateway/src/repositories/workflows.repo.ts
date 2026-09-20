/**
 * workflows.repo.ts — `flows` 表的数据访问层。
 *
 * flows：工作流主档（name / description / flow_data JSONB（节点+边+视口）/
 * status draft|published|archived）。画布 CRUD、运行入口读流、模板实例化
 * 落 draft、@flow 按名解析都走这里。布局自动保存走独立 merge 语义
 * （只动 position/viewport，不触碰节点配置）。
 */
import { runQuery } from '@dagents/db'

export interface FlowRow {
  id: string
  name: string
  description: string | null
  flow_data: unknown
  status: string
  created_at: Date
  updated_at: Date
}

/**
 * 列表投影行：不含 flow_data 全文。完整画布文档（节点+边+布局+视口）单份
 * 可达数十 KB，此前列表查询逐行拖全量 JSONB 进 gateway 仅为数节点数；
 * 现在节点数在 SQL 侧计算（语义：nodes 缺失或非数组一律计 0）。
 */
export interface FlowListItemRow {
  id: string
  name: string
  description: string | null
  status: string
  node_count: number
  created_at: Date
  updated_at: Date
}

export function normalizeFlowListItem(r: FlowListItemRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    nodeCount: r.node_count ?? 0,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

export function normalizeFlowDetail(r: FlowRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    flowData: r.flow_data,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

export async function listFlows(status?: string): Promise<FlowListItemRow[]> {
  let sql = `SELECT id, name, description, status,
               CASE WHEN jsonb_typeof(flow_data->'nodes') = 'array'
                    THEN jsonb_array_length(flow_data->'nodes')
                    ELSE 0
               END AS node_count,
               created_at, updated_at
             FROM flows`
  const params: unknown[] = []
  if (status) {
    params.push(status)
    sql += ` WHERE status = $${params.length}`
  }
  sql += ` ORDER BY updated_at DESC`
  const { records } = await runQuery<FlowListItemRow>(sql, params)
  return records
}

export async function getFlowById(id: string): Promise<FlowRow | null> {
  const { records } = await runQuery<FlowRow>(
    `SELECT id, name, description, flow_data, status, created_at, updated_at
       FROM flows
       WHERE id = $1`,
    [id],
  )
  return records[0] ?? null
}

/** 只取 flow_data（chat 流式 / @flow 执行的轻量读取）。 */
export async function getFlowDataById(flowId: string): Promise<{ flow_data: unknown } | null> {
  const { records } = await runQuery<{ flow_data: unknown }>(
    `SELECT flow_data FROM flows WHERE id = $1::uuid`,
    [flowId],
  )
  return records[0] ?? null
}

export async function createFlow(input: {
  name: string
  description?: string | null
  flowDataJson: string
  status?: string
}): Promise<FlowRow | null> {
  const { records } = await runQuery<FlowRow>(
    `INSERT INTO flows (name, description, flow_data, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, flow_data, status, created_at, updated_at`,
    [
      input.name,
      input.description ?? null,
      input.flowDataJson,
      input.status ?? 'draft',
    ],
  )
  return records[0] ?? null
}

/** 模板 / @workflow / 团队场景共用的 draft 落库（返回新 flow id）。 */
export async function insertDraftFlow(name: string, description: string, flowDataJson: string): Promise<string> {
  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO flows (name, description, flow_data, status)
     VALUES ($1, $2, $3, 'draft')
     RETURNING id`,
    [name, description, flowDataJson],
  )
  return records[0].id
}

/** PATCH 动态更新：只写提供的列（name → description → flowData → status）。 */
export async function updateFlowFields(
  id: string,
  patch: { name?: string; description?: string; flowDataJson?: string; status?: string },
): Promise<FlowRow | null> {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.description !== undefined) {
    params.push(patch.description)
    sets.push(`description = $${params.length}`)
  }
  if (patch.flowDataJson !== undefined) {
    params.push(patch.flowDataJson)
    sets.push(`flow_data = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }

  params.push(id)
  const idParam = `$${params.length}`

  const { records } = await runQuery<FlowRow>(
    `UPDATE flows
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = ${idParam}
     RETURNING id, name, description, flow_data, status, created_at, updated_at`,
    params,
  )
  return records[0] ?? null
}

/** 布局静默保存：merge 后的 flow_data 整体写回（merge 逻辑在路由层）。 */
export async function updateFlowLayout(id: string, flowDataJson: string): Promise<void> {
  await runQuery(`UPDATE flows SET flow_data = $1::jsonb, updated_at = NOW() WHERE id = $2`, [
    flowDataJson,
    id,
  ])
}

export async function deleteFlow(id: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM flows WHERE id = $1 RETURNING id`,
    [id],
  )
  return records[0]?.id ?? null
}

/** @flow 按名解析（archived 不可运行）。 */
export async function findRunnableFlowIdByName(name: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM flows WHERE name = $1 AND status IN ('draft', 'published') LIMIT 1`,
    [name],
  )
  return records[0]?.id ?? null
}

/**
 * Agent 删除的引用预筛：flow_data 里出现该 id 字面量的 flow（LIKE 预筛，
 * 精确判定由应用层 findAgentReferences 做 —— 兼容两种存储形态）。
 */
export async function listFlowsContainingText(id: string): Promise<Array<{ id: string; name: string; flow_data: unknown }>> {
  const { records } = await runQuery<{ id: string; name: string; flow_data: unknown }>(
    `SELECT id, name, flow_data FROM flows WHERE flow_data::text LIKE '%' || $1 || '%'`,
    [id],
  )
  return records
}

/** 模板抽取源：画布「另存为模板」读取的 flow 摘要。 */
export async function getFlowForTemplateExtract(
  flowId: string,
): Promise<{ name: string; description: string | null; flow_data: unknown } | null> {
  const { records } = await runQuery<{ name: string; description: string | null; flow_data: unknown }>(
    `SELECT name, description, flow_data FROM flows WHERE id = $1::uuid`,
    [flowId],
  )
  return records[0] ?? null
}
