/**
 * R10 试运行路由级 DB 隔离断言（design-sharp §6.4 路由级——dev-notes 交代
 * 集成批补跑：内核级 12 例在 trial-run.test.ts，此处 app.request() 全链路
 * 打真库 dagents_gw_test，钉住写入口径三面 + journal）。
 *
 *   spans 有行（观测面）/ checkpoint 无行（无 resume 语义）/
 *   usage_events 无行（不入账）/ runs.source='trial'（历史过滤锚点）/
 *   run_node_journal 有行（journal 主路对 deliverables/回放的观测锚点）。
 *
 * e2e 26-canvas-trial-run 的隔离三面在 HTTP 面（history 过滤 + checkpoint
 * 404 + usage-summary 200）——usage_events 的「不入账」在 e2e 只能弱断言，
 * DB 直查在本文件补齐。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { app } from '../app.js'
import { listRunsHistory } from '../repositories/runs.repo.js'

const PG_URL =
  process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

const flowIds: string[] = []
const runIds: string[] = []

describe('试运行写入口径（R10 路由级 DB 隔离）', () => {
  beforeAll(async () => {
    process.env.POSTGRES_URL ??= PG_URL
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    if (runIds.length) {
      await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [runIds])
      await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [runIds])
      await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [runIds])
      await runQuery(`DELETE FROM usage_events WHERE run_id = ANY($1::uuid[])`, [runIds])
      await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [runIds])
    }
    if (flowIds.length) await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [flowIds])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it(
    'trial run：spans/journal 有行、checkpoint/usage_events 零行、source=trial',
    { timeout: 20_000 },
    async () => {
      const flowId = randomUUID()
      await runQuery(
        `INSERT INTO flows (id, name, description, flow_data, status)
       VALUES ($1, 'gw-trial-isolation', '', $2::jsonb, 'draft')`,
        [
          flowId,
          JSON.stringify({
            nodes: [
              {
                id: 'start',
                type: 'customNode',
                position: { x: 0, y: 0 },
                data: { name: 'startAgentflow', label: 'Start' },
              },
              {
                id: 'llm',
                type: 'customNode',
                position: { x: 300, y: 0 },
                data: { name: 'llmAgentflow', label: 'LLM', systemPrompt: 'S', prompt: 'P' },
              },
            ],
            edges: [{ id: 'e1', source: 'start', target: 'llm' }],
          }),
        ],
      )
      flowIds.push(flowId)

      const res = await app.request(`/api/v1/workflows/${flowId}/trial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: '试运行输入',
          scope: { nodeIds: ['llm'] },
          mockScript: { default: { rules: [], fallback: { text: 'TRIAL-OK' } } },
        }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { success: boolean; data?: { runId?: string } }
      expect(json.success).toBe(true)
      const runId = json.data?.runId
      expect(runId).toBeTruthy()
      runIds.push(runId!)

      // 轮询终态（mock fallback 即时完成，保守轮 5s）
      let status = 'running'
      for (let i = 0; i < 25 && status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 200))
        const rows = (await runQuery(`SELECT status FROM runs WHERE id = $1`, [runId]))
          .records as Array<{ status: string }>
        status = rows[0]?.status ?? status
      }
      expect(status).toBe('completed')

      const runRow = (await runQuery(`SELECT source FROM runs WHERE id = $1`, [runId]))
        .records[0] as { source: string | null }
      expect(runRow.source).toBe('trial')

      const spanRows = (
        await runQuery(`SELECT node_id FROM run_node_spans WHERE run_id = $1`, [runId])
      ).records as Array<{ node_id: string }>
      expect(spanRows.map((r) => r.node_id)).toContain('llm')

      const journalRows = (
        await runQuery(`SELECT count(*)::int AS n FROM run_node_journal WHERE run_id = $1`, [runId])
      ).records[0] as { n: number }
      expect(journalRows.n).toBeGreaterThan(0)

      const ckptRows = (
        await runQuery(`SELECT count(*)::int AS n FROM run_checkpoints WHERE run_id = $1`, [runId])
      ).records[0] as { n: number }
      expect(ckptRows.n).toBe(0)

      const usageRows = (
        await runQuery(`SELECT count(*)::int AS n FROM usage_events WHERE run_id = $1`, [runId])
      ).records[0] as { n: number }
      expect(usageRows.n).toBe(0)
    },
  )

  // ── 读面：listRunsHistory 过滤生效（design-sharp §6.4 第 2 条的读面半，
  // 2026-10-08 测试补齐轮）——SQL 直插三行（canvas/chat/trial）钉住三个向：
  // 缺省滤 trial、?source=trial 正向、includeTrial 免滤、正式行不误伤。
  it('listRunsHistory：缺省排除 trial 行；source=trial 正向；includeTrial 免滤；canvas/chat 行不误伤', async () => {
    const flowId = flowIds[0]!
    const ids = {
      canvas: randomUUID(),
      chat: randomUUID(),
      trial: randomUUID(),
      legacy: randomUUID(), // source IS NULL（迁移前旧行——混跑窗口）
    }
    const seed = async (runId: string, source: string | null, chatId: string | null) => {
      await runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms, cost, chat_id, source)
         VALUES ($1::uuid, $2, $3::uuid, 'completed', '{}'::jsonb, NULL, NOW(), NOW(), 10, 0, $4::uuid, $5)`,
        [runId, runId, flowId, chatId, source],
      )
      runIds.push(runId)
    }
    await seed(ids.canvas, 'canvas', null)
    await seed(ids.chat, 'chat', randomUUID())
    await seed(ids.trial, 'trial', null)
    await seed(ids.legacy, null, null)

    // 缺省：正式历史零 trial 混入（AC-R10-3 第一隔离面的读面表达）
    const byDefault = await listRunsHistory({ flowId, limit: 50 })
    const defaultIds = byDefault.map((r) => r.id)
    expect(defaultIds).not.toContain(ids.trial)
    expect(defaultIds).toContain(ids.canvas)
    expect(defaultIds).toContain(ids.chat)
    // source IS NULL 的迁移前旧行 = 正式行，不受过滤误伤（NFR-1 混跑窗口）
    expect(defaultIds).toContain(ids.legacy)

    // 正向：?source=trial 只见试运行行（走 idx_runs_source_trial 部分索引）
    const trialOnly = await listRunsHistory({ flowId, source: 'trial', limit: 50 })
    const trialIds = trialOnly.map((r) => r.id)
    expect(trialIds).toContain(ids.trial)
    expect(trialIds).not.toContain(ids.canvas)
    expect(trialIds).not.toContain(ids.chat)

    // 免滤：includeTrial（管理/调试视图）全量可见
    const all = await listRunsHistory({ flowId, includeTrial: true, limit: 50 })
    const allIds = all.map((r) => r.id)
    for (const id of Object.values(ids)) expect(allIds).toContain(id)

    // 行形状：source 列随行返回（RunHistoryRow.source，runs.ts COALESCE 的数据源）
    expect(byDefault.find((r) => r.id === ids.canvas)?.source).toBe('canvas')
    expect(trialOnly.find((r) => r.id === ids.trial)?.source).toBe('trial')
  })
})
