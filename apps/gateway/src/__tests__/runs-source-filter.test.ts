/**
 * R10 runs.source 读面过滤（design-sharp §1.1 / AC-R10-3 第一隔离面的
 * repo 半）：listRunsHistory 缺省排除 trial 行、?source=trial 正向过滤、
 * includeTrial 全量；persistWorkflowRunRow 的 source COALESCE 保已存值。
 *
 * 打真库 dagents_gw_test（globalSetup 供给），自插自清。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import {
  listRunsHistory,
  persistWorkflowRunRow,
  initAsyncWorkflowRunRow,
} from '../repositories/runs.repo.js'

describe('runs.source 过滤与写侧 COALESCE（R10）', () => {
  const flowId = randomUUID()
  const runIds: string[] = []

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= 'postgresql://dagents:dagents_dev@localhost:15432/dagents'
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    await runQuery(
      `INSERT INTO flows (id, name, description, flow_data, status)
       VALUES ($1, 'gw-runs-source-filter', '', '{"nodes":[],"edges":[]}'::jsonb, 'draft')`,
      [flowId],
    )
  })

  afterAll(async () => {
    if (runIds.length) {
      await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [runIds])
    }
    await runQuery(`DELETE FROM flows WHERE id = $1`, [flowId])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('缺省排除 trial 行；source=trial 正向过滤；includeTrial 全量', async () => {
    const trialRun = randomUUID()
    const canvasRun = randomUUID()
    const legacyRun = randomUUID() // 迁移前旧行（source=NULL）
    runIds.push(trialRun, canvasRun, legacyRun)
    for (const [id, source] of [
      [trialRun, 'trial'],
      [canvasRun, 'canvas'],
      [legacyRun, null],
    ] as const) {
      await runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, duration_ms, cost, source)
         VALUES ($1::uuid, $2, $3, 'completed', '{}'::jsonb, NULL, NOW(), 10, 0, $4)`,
        [id, id, flowId, source],
      )
    }

    const byDefault = await listRunsHistory({ flowId, limit: 50 })
    const defaultIds = byDefault.map((r) => r.id)
    expect(defaultIds).toContain(canvasRun)
    expect(defaultIds).toContain(legacyRun) // NULL 行不误伤（迁移前数据可见）
    expect(defaultIds).not.toContain(trialRun)

    const trialOnly = await listRunsHistory({ flowId, limit: 50, source: 'trial' })
    expect(trialOnly.map((r) => r.id)).toEqual([trialRun])
    expect(trialOnly[0]!.source).toBe('trial')

    const all = await listRunsHistory({ flowId, limit: 50, includeTrial: true })
    const allIds = all.map((r) => r.id)
    expect(allIds).toContain(trialRun)
    expect(allIds).toContain(canvasRun)
  })

  it('persistWorkflowRunRow：source COALESCE 保已存值（终态 upsert 不带 source 时不抹掉 trial 标记）', async () => {
    const runId = randomUUID()
    runIds.push(runId)
    await initAsyncWorkflowRunRow({
      runId,
      flowId,
      inputJson: JSON.stringify({ input: '' }),
      startedAt: new Date(),
      source: 'trial',
    })
    // 终态路径若漏传 source（防御性），COALESCE 应保住先行行的 'trial'
    await persistWorkflowRunRow({
      runId,
      flowId,
      status: 'completed',
      inputJson: JSON.stringify({ input: '' }),
      outputJson: null,
      startedAt: new Date(Date.now() - 1000),
      finishedAt: new Date(),
      durationMs: 1000,
      cost: 0,
    })
    const row = (await runQuery(`SELECT source FROM runs WHERE id = $1`, [runId])).records[0] as {
      source: string | null
    }
    expect(row.source).toBe('trial')
  })

  it('canvas 直跑实写 source=canvas（写侧四路径接通的 repo 半）', async () => {
    const runId = randomUUID()
    runIds.push(runId)
    await persistWorkflowRunRow({
      runId,
      flowId,
      status: 'completed',
      inputJson: JSON.stringify({ input: null }),
      outputJson: null,
      startedAt: new Date(Date.now() - 1000),
      finishedAt: new Date(),
      durationMs: 1000,
      cost: 0,
      source: 'canvas',
    })
    const row = (await runQuery(`SELECT source FROM runs WHERE id = $1`, [runId])).records[0] as {
      source: string | null
    }
    expect(row.source).toBe('canvas')
  })
})
