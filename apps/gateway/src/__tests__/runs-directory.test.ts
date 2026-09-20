import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'

/**
 * 运行 → 项目目录数据链（P0，2026-09-19，docs/design-terminal-anchors.md §3）：
 * 真实 DB（dagents_gw_test 由 globalSetup 迁移）验证 directory_id 列的
 * 写入（异步先行行 + 终态 upsert）与读取（GET /runs 行 + node-spans 响应）。
 * 用 directReply 节点跑完整运行 —— 零外部依赖、确定终态。
 */

const createdFlowIds: string[] = []
const createdDirIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  for (const id of createdFlowIds) {
    await runQuery(`DELETE FROM runs WHERE pipeline_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [id]).catch(() => {})
  }
  for (const id of createdDirIds) {
    await runQuery(`DELETE FROM directories WHERE id = $1::uuid`, [id]).catch(() => {})
  }
})

async function mkFlow(name: string): Promise<string> {
  const res = await app.request('/api/v1/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      flowData: {
        nodes: [
          { id: 's1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
          {
            id: 'd1',
            type: 'customNode',
            position: { x: 300, y: 0 },
            data: { name: 'directReplyAgentflow', label: '直答', text: 'ok' },
          },
        ],
        edges: [{ id: 'e1', source: 's1', target: 'd1' }],
      },
    }),
  })
  const json = (await res.json()) as { data: { flow: { id: string } } }
  const id = json.data.flow.id
  createdFlowIds.push(id)
  return id
}

async function mkDir(path: string): Promise<string> {
  const res = await app.request('/api/v1/directories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const json = (await res.json()) as { data: { directory: { id: string } } }
  const id = json.data.directory.id
  createdDirIds.push(id)
  return id
}

async function waitRunDone(runId: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await app.request(`/api/v1/workflows/runs/${runId}/node-spans`)
    const json = (await res.json()) as { data?: { runStatus?: string | null } }
    const status = json.data?.runStatus
    if (status && status !== 'running' && status !== 'pending') return status
    if (Date.now() > deadline) throw new Error(`run ${runId} not settled: ${status}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe('运行 → 目录数据链（P0）', () => {
  it('带 directoryId 的异步运行：先行行与终态行都落目录锚，两个读点都能读回', async () => {
    const flowId = await mkFlow('p0-datalink-test')
    const dirId = await mkDir('/tmp/p0-datalink-probe')
    const runId = crypto.randomUUID()

    const runRes = await app.request(`/api/v1/workflows/${flowId}/run?async=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': runId },
      body: JSON.stringify({ input: {}, directoryId: dirId }),
    })
    expect(runRes.status).toBe(200)

    // 先行行（running）就带目录锚 —— 运行历史即时可见即即时可锚
    const early = await runQuery<{ directory_id: string | null }>(
      `SELECT directory_id FROM runs WHERE id = $1::uuid`,
      [runId],
    )
    expect(early.records[0]?.directory_id).toBe(dirId)

    const finalStatus = await waitRunDone(runId)
    expect(finalStatus).toBe('completed')

    // 读点 1：GET /runs 行响应（终端入口的数据源）
    const listRes = await app.request(`/api/v1/runs?flowId=${flowId}&limit=10`)
    const listJson = (await listRes.json()) as { data: Array<{ runId: string; directoryId?: string | null }> }
    const row = listJson.data.find((r) => r.runId === runId)
    expect(row?.directoryId).toBe(dirId)

    // 读点 2：node-spans 响应（画布旁观入口的数据源）
    const spansRes = await app.request(`/api/v1/workflows/runs/${runId}/node-spans`)
    const spansJson = (await spansRes.json()) as { data?: { runDirectoryId?: string | null } }
    expect(spansJson.data?.runDirectoryId).toBe(dirId)
  })

  it('不带 directoryId 的运行：目录锚为 null（诚实优先，不制造假锚）', async () => {
    const flowId = await mkFlow('p0-datalink-nodir')
    const runId = crypto.randomUUID()
    const runRes = await app.request(`/api/v1/workflows/${flowId}/run?async=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': runId },
      body: JSON.stringify({ input: {} }),
    })
    expect(runRes.status).toBe(200)
    await waitRunDone(runId)

    const listRes = await app.request(`/api/v1/runs?flowId=${flowId}&limit=10`)
    const listJson = (await listRes.json()) as { data: Array<{ runId: string; directoryId?: string | null }> }
    const row = listJson.data.find((r) => r.runId === runId)
    expect(row?.directoryId ?? null).toBeNull()
  })
})
