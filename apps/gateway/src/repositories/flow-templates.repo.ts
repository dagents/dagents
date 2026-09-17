/**
 * flow-templates.repo.ts — `flow_templates` 表的数据访问层。
 *
 * flow_templates：「我的模板」（画布「另存为模板」抽取入库的用户模板；
 * 内置模板随仓库分发不走库）。列含抽取后的 flow_data、agent_refs（人格
 * 重绑锚点）、params（模板参数化）与 source_flow_id 溯源。
 */
import { runQuery } from '@dagents/db'
import type { AgentRef, FlowTemplateSpec, TemplateCategory } from '../flow-template-pipeline.js'

export interface UserTemplateRow {
  id: string
  name: string
  description: string | null
  icon: string
  category: string
  flow_data: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  agent_refs: AgentRef[] | null
  params: { name: string; defaultValue?: string }[] | null
  source_flow_id: string | null
  created_at: string | Date
}

export function rowToSpec(row: UserTemplateRow): FlowTemplateSpec {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon,
    category: (row.category === 'dev' || row.category === 'research' || row.category === 'content' || row.category === 'ops'
      ? row.category
      : 'custom') as TemplateCategory,
    source: 'user',
    flowData: row.flow_data,
    agentRefs: row.agent_refs ?? [],
    params: row.params ?? [],
  }
}

export async function listUserTemplates(): Promise<UserTemplateRow[]> {
  const { records } = await runQuery<UserTemplateRow>(
    `SELECT id, name, description, icon, category, flow_data, agent_refs, params, source_flow_id, created_at
       FROM flow_templates ORDER BY created_at DESC`,
  )
  return records
}

/** 单模板寻址（用户模板 uuid）；查库失败由调用方决定降级。 */
export async function getUserTemplateRow(id: string): Promise<UserTemplateRow | null> {
  const { records } = await runQuery<UserTemplateRow>(
    `SELECT id, name, description, icon, category, flow_data, agent_refs, params, source_flow_id, created_at
       FROM flow_templates WHERE id = $1::uuid`,
    [id],
  )
  return records[0] ?? null
}

export async function insertUserTemplate(input: {
  name: string
  description: string
  icon: string
  category: string
  flowDataJson: string
  agentRefsJson: string
  paramsJson: string
  sourceFlowId: string
}): Promise<string> {
  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO flow_templates (name, description, icon, category, flow_data, agent_refs, params, source_flow_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::uuid)
     RETURNING id`,
    [
      input.name,
      input.description,
      input.icon,
      input.category,
      input.flowDataJson,
      input.agentRefsJson,
      input.paramsJson,
      input.sourceFlowId,
    ],
  )
  return records[0].id
}

/** 删除用户模板；返回被删 id（null = 不存在）。 */
export async function deleteUserTemplate(id: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM flow_templates WHERE id = $1::uuid RETURNING id`,
    [id],
  )
  return records[0]?.id ?? null
}
