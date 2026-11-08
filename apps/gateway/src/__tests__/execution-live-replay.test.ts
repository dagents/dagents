/**
 * GET /runs/:runId/live 的 journal 回放阶梯（design-recover §3.4(c)，
 * AC-R7-5 单测面）：live 条目 404（网关重启/保留期过）→ run_node_journal
 * event 行按 seq 重建 hello.replay——帧形状契约不变（console 双 builder 零
 * 改动）；ended/finalStatus 由 runs 行终态判定；超回放上限头部截断标记
 * 如实呈现；「无 live 条目且无 journal 行」才 404。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { app } from '../app.js'
import { resetRunLiveForTest } from '../run-live-registry.js'

const FLOW_ID = '00000000-0000-4000-8000-00000000f001'
const RUN_REPLAY = '00000000-0000-4000-8000-00000000f101'
const RUN_CAP = '00000000-0000-4000-8000-00000000f102'
const RUN_NO_JOURNAL = '00000000-0000-4000-8000-00000000f103'
const ALL_RUNS = [RUN_REPLAY, RUN_CAP, RUN_NO_JOURNAL]

/** SSE 行读取器（run-live.test.ts 同款语义的最小实现）。 */
class EventReader {
  private lines: string[] = []
  private pos = 0
  constructor(private readonly stream: ReadableStream<Uint8Array>) {}
  async next(): Promise<{ event: string; data: unknown } | null> {
    const decoder = new TextDecoder()
    for (;;) {
      while (this.pos < this.lines.length) {
        const block = this.lines[this.pos++]!
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (data) return { event, data: JSON.parse(data) }
      }
      const { done, value } = await this.stream.getReader().read()
      if (done) return null
      this.lines = [
        ...this.lines,
        ...decoder
          .decode(value, { stream: true })
          .split('\n\n')
          .filter((b) => b.trim().length > 0 && !b.startsWith(':')),
      ]
    }
  }
}

async function insertEvent(
  runId: string,
  seq: number,
  eventType: string,
  nodeId: string,
  payload: Record<string, unknown>,
  flowId: string = FLOW_ID,
): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, event_type, payload)
     VALUES ($1::uuid, $2::text, $3, 0, 'event', $4, $5, $6::jsonb)`,
    [runId, flowId, nodeId, seq, eventType, JSON.stringify(payload)],
  )
}

async function insertRunRow(runId: string, status: string): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at)
     VALUES ($1::uuid, $1, $2::uuid, $3, '{}', NOW())`,
    [runId, '00000000-0000-4000-8000-00000000f002', status],
  )
}

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
  resetRunLiveForTest()

  // ── 回放场景：journal 行故意乱序插入（seq 才是交付序）──
  await insertRunRow(RUN_REPLAY, 'stopped')
  await insertEvent(RUN_REPLAY, 3, 'nodeEnd', 'n1', {
    type: 'nodeEnd',
    nodeId: 'n1',
    nodeName: 'LLM 1',
    status: 'done',
    at: '2026-10-07T02:00:02.000Z',
    seq: 3,
  })
  await insertEvent(RUN_REPLAY, 1, 'nodeStart', 'n1', {
    type: 'nodeStart',
    nodeId: 'n1',
    nodeName: 'LLM 1',
    nodeType: 'llmAgentflow',
    at: '2026-10-07T02:00:00.000Z',
    seq: 1,
  })
  await insertEvent(RUN_REPLAY, 2, 'delta', 'n1', {
    type: 'delta',
    nodeId: 'n1',
    nodeName: 'LLM 1',
    delta: { type: 'text', text: 'hi' },
    at: '2026-10-07T02:00:01.000Z',
    seq: 2,
  })
  await insertEvent(RUN_REPLAY, 4, 'runEnd', '__run__', {
    type: 'runEnd',
    status: 'stopped',
    stopReason: 'interrupted',
    at: '2026-10-07T02:00:03.000Z',
    seq: 4,
  })

  // ── 截断场景：3 行 + 上限 2 ──
  await insertRunRow(RUN_CAP, 'failed')
  for (let i = 1; i <= 3; i++) {
    await insertEvent(RUN_CAP, i, 'delta', 'n1', {
      type: 'delta',
      nodeId: 'n1',
      nodeName: 'N',
      delta: { type: 'text', text: `c${i}` },
      at: '2026-10-07T03:00:00.000Z',
      seq: i,
    })
  }

  // ── 有 runs 行但无 journal 行（迁移前老 run）──
  await insertRunRow(RUN_NO_JOURNAL, 'completed')
})

afterAll(async () => {
  resetRunLiveForTest()
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [ALL_RUNS]).catch(() => {})
})

describe('GET /runs/:runId/live — journal 回放阶梯（§3.4(c)，AC-R7-5）', () => {
  it('live 条目 404 → journal 前缀重建 hello.replay：帧按 seq 序、payload 原样（at 保真不重打）', async () => {
    const res = await app.request(`/api/v1/workflows/runs/${RUN_REPLAY}/live`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = new EventReader(res.body!)
    const hello = (await reader.next()) as { event: string; data: Record<string, unknown> }
    expect(hello.event).toBe('hello')
    const payload = hello.data as unknown as {
      replay: Array<Record<string, unknown>>
      ended: boolean
      finalStatus?: string
      flowId: string
    }
    // 交付序 = seq 序（插入序被纠正）
    expect(payload.replay.map((f) => f.type)).toEqual([
      'nodeStart',
      'delta',
      'nodeEnd',
      'runEnd',
    ])
    // at 原值（journal 帧不打新时间戳——跨源一致性的前提）
    expect((payload.replay[0] as { at?: string }).at).toBe('2026-10-07T02:00:00.000Z')
    expect((payload.replay[3] as { stopReason?: string }).stopReason).toBe('interrupted')
    // ended/finalStatus 由 runs 行终态判定（journal 的 runEnd 只是阶段边界证据）
    expect(payload.ended).toBe(true)
    expect(payload.finalStatus).toBe('stopped')
    expect(payload.flowId).toBe(FLOW_ID)
  })

  it('超回放上限：头部聚合截断标记（truncatedHead 如实呈现，不静默缺行）', async () => {
    process.env.DAGENTS_JOURNAL_REPLAY_MAX = '2'
    try {
      const res = await app.request(`/api/v1/workflows/runs/${RUN_CAP}/live`)
      expect(res.status).toBe(200)
      const reader = new EventReader(res.body!)
      const hello = (await reader.next()) as { event: string; data: unknown }
      const payload = hello.data as unknown as { replay: Array<Record<string, unknown>> }
      // 最新 2 条交付；头部 truncated 标记带 dropped=1（丢弃的是最老 1 条）
      expect(payload.replay).toHaveLength(3)
      expect(payload.replay[0]!.type).toBe('truncated')
      expect((payload.replay[0] as { dropped: number }).dropped).toBe(1)
      expect(payload.replay.slice(1).map((f) => (f.delta as { text: string }).text)).toEqual([
        'c2',
        'c3',
      ])
    } finally {
      delete process.env.DAGENTS_JOURNAL_REPLAY_MAX
    }
  })

  it('有 runs 行但无 journal 行 → 仍 404（诚实阶梯终点：真正的未知/旧 run）', async () => {
    const res = await app.request(`/api/v1/workflows/runs/${RUN_NO_JOURNAL}/live`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
