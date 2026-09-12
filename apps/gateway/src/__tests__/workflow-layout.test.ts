import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * 布局自动保存端点（2026-09-06 画布优化）：PUT /workflows/:id/layout
 * 服务端 merge —— 只更新已存在节点的 position 与顶层 viewport，节点
 * 配置一字不动（尊重草稿自由：配置编辑仍走显式保存管线）。
 */

let seededFlowIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await cleanup()
})
afterEach(async () => {
  await cleanup()
})

async function cleanup(): Promise<void> {
  if (seededFlowIds.length) {
    await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [seededFlowIds])
    seededFlowIds = []
  }
}

/** 建一条带两个节点 + 连边的测试 flow（返回 id）。 */
async function seedFlow(): Promise<string> {
  const id = randomUUID()
  const flowData = {
    nodes: [
      { id: 'n1', type: 'custom', position: { x: 0, y: 0 }, data: { name: 'startAgentflow', label: '开始' } },
      { id: 'n2', type: 'custom', position: { x: 240, y: 0 }, data: { name: 'llmAgentflow', label: 'LLM', model: 'm1' } },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    viewport: { x: 10, y: 20, zoom: 0.9 },
  }
  const res = await app.request('/api/v1/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `layout-test-${id.slice(0, 8)}`, flowData }),
  })
  const json = (await res.json()) as { data?: { flow?: { id?: string } } }
  const flowId = json.data?.flow?.id
  if (!flowId) throw new Error('seed flow failed')
  seededFlowIds.push(flowId)
  return flowId
}

async function readFlow(flowId: string): Promise<{ nodes: Array<{ id: string; position: { x: number; y: number }; data?: Record<string, unknown> }>; viewport?: { x: number; y: number; zoom: number } }> {
  const res = await app.request(`/api/v1/workflows/${flowId}`)
  const json = (await res.json()) as { data?: { flow?: { flowData?: unknown } } }
  return ((json.data?.flow?.flowData ?? {}) as never)
}

describe('PUT /api/v1/workflows/:id/layout（布局自动保存）', () => {
  it('merge 已存在节点的坐标与顶层 viewport，节点配置不动', async () => {
    const flowId = await seedFlow()
    const res = await app.request(`/api/v1/workflows/${flowId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        positions: { n1: { x: 123.6, y: -8.2 }, n2: { x: 400, y: 120 } },
        viewport: { x: 100, y: 50, zoom: 1.25 },
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data?: { appliedPositions?: number } }
    expect(json.data?.appliedPositions).toBe(2)

    const doc = await readFlow(flowId)
    expect(doc.nodes[0]!.position).toEqual({ x: 124, y: -8 }) // 取整
    expect(doc.nodes[1]!.position).toEqual({ x: 400, y: 120 })
    expect(doc.viewport).toEqual({ x: 100, y: 50, zoom: 1.25 })
    // 配置原样（layout 端点不得动 data）
    expect(doc.nodes[1]!.data).toMatchObject({ name: 'llmAgentflow', model: 'm1' })
  })

  it('未知节点 id 静默忽略（客户端可能拿着删除前的快照）', async () => {
    const flowId = await seedFlow()
    const res = await app.request(`/api/v1/workflows/${flowId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { 'ghost-id': { x: 1, y: 2 } } }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data?: { appliedPositions?: number } }
    expect(json.data?.appliedPositions).toBe(0)
    const doc = await readFlow(flowId)
    expect(doc.nodes[0]!.position).toEqual({ x: 0, y: 0 }) // 原坐标未动
  })

  it('空载荷 / 坏 body 400，未知 flow 404', async () => {
    const flowId = await seedFlow()
    const empty = await app.request(`/api/v1/workflows/${flowId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(empty.status).toBe(400)
    const bad = await app.request(`/api/v1/workflows/${flowId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { n1: 'not-an-object' } }),
    })
    expect(bad.status).toBe(400)
    const missing = await app.request(`/api/v1/workflows/${randomUUID()}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewport: { x: 0, y: 0, zoom: 1 } }),
    })
    expect(missing.status).toBe(404)
  })
})
