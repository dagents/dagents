/**
 * R9 9d 第三来源 + R10 隔离透传（design-sharp §2.4/§3.4）路由级钉子：
 *
 * ① 子流程嵌套超深 → flowExecutor 抛 NodeRejectedError → 所在引擎的
 *   executeFlow 节点 span 落 'rejected'（错误首词「节点被拒绝：」，
 *   AC-R9-5 词首统一）——深度链 a→b→c→d→e 在进入第 4 层时拒绝，
 *   被拒节点在 d 图内（span 并入同一 runId）。
 * ② 试运行的 llmClientOverride 随递归装配透传（2026-10-08 测试补齐轮
 *   实弹修复的回归钉）：子引擎的 LLM 节点输出 = mock fallback 文本而非
 *   真 CLI/provider 产物——嵌套图试运行「真 provider 调用数 0」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { app } from '../app.js'
import { cliSpawnGateStats } from '../lib/cli-spawn-gate.js'

const MOCK_TEXT = 'SUB-MOCK-OK'

function flowJson(next: { efId: string; target: string } | null, llmId: string): string {
  const nodes: Array<Record<string, unknown>> = [
    {
      id: 'start',
      type: 'customNode',
      position: { x: 0, y: 0 },
      data: { name: 'startAgentflow', label: 'Start' },
    },
    {
      id: llmId,
      type: 'customNode',
      position: { x: 300, y: 0 },
      data: { name: 'llmAgentflow', label: llmId, systemPrompt: 'S', prompt: 'P' },
    },
  ]
  const edges: Array<Record<string, unknown>> = [{ id: 'e1', source: 'start', target: llmId }]
  if (next) {
    nodes.push({
      id: next.efId,
      type: 'customNode',
      position: { x: 600, y: 0 },
      data: { name: 'executeFlowAgentflow', label: next.efId, targetFlowId: next.target },
    })
    edges.push({ id: 'e2', source: llmId, target: next.efId })
  }
  return JSON.stringify({ nodes, edges })
}

describe('试运行子流程链（9d 深度拒绝 + R10 override 透传）', () => {
  const flowIds: string[] = []
  let rootRunId = ''
  let rootFlowId = ''

  beforeAll(async () => {
    process.env.POSTGRES_URL ??= 'postgresql://dagents:dagents_dev@localhost:15432/dagents'
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()

    // 链：a → b → c → d → e（e 是叶子）。进入 e 时 depth+1=4 > 3 → 拒绝。
    const [fa, fb, fc, fd, fe] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]
    flowIds.push(fa, fb, fc, fd, fe)
    rootFlowId = fa
    const seeds: Array<[string, string]> = [
      [fa, flowJson({ efId: 'ef-a', target: fb }, 'llm-a')],
      [fb, flowJson({ efId: 'ef-b', target: fc }, 'llm-b')],
      [fc, flowJson({ efId: 'ef-c', target: fd }, 'llm-c')],
      [fd, flowJson({ efId: 'ef-de', target: fe }, 'llm-d')],
      [fe, flowJson(null, 'llm-e')],
    ]
    for (const [id, json] of seeds) {
      await runQuery(
        `INSERT INTO flows (id, name, description, flow_data, status)
         VALUES ($1, 'gw-trial-subflow', '', $2::jsonb, 'draft')`,
        [id, json],
      )
    }
  })

  afterAll(async () => {
    if (rootRunId) {
      await runQuery(`DELETE FROM run_node_journal WHERE run_id = $1`, [rootRunId])
      await runQuery(`DELETE FROM run_node_spans WHERE run_id = $1`, [rootRunId])
      await runQuery(`DELETE FROM run_checkpoints WHERE run_id = $1`, [rootRunId])
      await runQuery(`DELETE FROM usage_events WHERE run_id = $1`, [rootRunId])
      await runQuery(`DELETE FROM runs WHERE id = $1`, [rootRunId])
    }
    if (flowIds.length) await runQuery(`DELETE FROM flows WHERE id = ANY($1::uuid[])`, [flowIds])
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it(
    '4 层链试运行：第 4 层 executeFlow span rejected（词首「节点被拒绝：」）+ 子引擎 LLM 输出为 mock 文本',
    { timeout: 20_000 },
    async () => {
      const res = await app.request(`/api/v1/workflows/${rootFlowId}/trial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: '深度链试运行',
          mockScript: { default: { rules: [], fallback: { text: MOCK_TEXT } } },
        }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { success: boolean; data?: { runId?: string } }
      expect(json.success).toBe(true)
      const runIdFromResponse = json.data?.runId
      expect(runIdFromResponse).toBeTruthy()
      rootRunId = runIdFromResponse as string

      let status = 'running'
      for (let i = 0; i < 60 && (status === 'running' || status === 'pending'); i++) {
        await new Promise((r) => setTimeout(r, 250))
        const rows = (await runQuery(`SELECT status FROM runs WHERE id = $1`, [rootRunId]))
          .records as Array<{ status: string }>
        status = rows[0]?.status ?? status
      }
      // 根图收尾：拒绝发生在 d 图（executeFlow 视 partial_success 子运行为
      // 成功，subflowStatus 透传）——根终态 completed，被拒 span 并入同 runId。
      expect(status).toBe('completed')
      // runs 终态行是 executeTrial 的最后一笔落库（spans 批量在它之前 await），
      // 再给 fire-and-forget 的 journal 微批一点收口余量，避免 afterAll 清库竞态。
      await new Promise((r) => setTimeout(r, 300))

      const spans = (
        await runQuery(
          `SELECT node_id, status, error, output FROM run_node_spans WHERE run_id = $1`,
          [rootRunId],
        )
      ).records as Array<{ node_id: string; status: string; error: string | null; output: unknown }>

      // ① 深度拒绝：d 图的 executeFlow(e) 节点
      const rejected = spans.find((sp) => sp.node_id === 'ef-de')
      expect(rejected).toBeDefined()
      expect(rejected!.status).toBe('rejected')
      expect(rejected!.error).toContain('节点被拒绝')
      expect(rejected!.error).toContain('子流程嵌套超过 3 层')

      // ② override 透传：b/c/d 图的 LLM 节点输出 = mock fallback 文本
      for (const llmId of ['llm-a', 'llm-b', 'llm-c', 'llm-d']) {
        const llm = spans.find((sp) => sp.node_id === llmId)
        expect(llm, `${llmId} span 应存在`).toBeDefined()
        expect(llm!.status).toBe('done')
        const out = llm!.output as { content?: string } | null
        expect(out?.content).toBe(MOCK_TEXT)
      }
      // e 图的 llm-e 未执行（第 4 层入口即被拒）
      expect(spans.find((sp) => sp.node_id === 'llm-e')).toBeUndefined()

      // 「真 provider 调用数 0」半：无在途 CLI spawn（全链 mock，无真调用）
      expect(cliSpawnGateStats().active).toBe(0)
    },
  )
})
