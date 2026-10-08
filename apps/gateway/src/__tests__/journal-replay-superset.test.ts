/**
 * journal ⊇ live 已收前缀（AC-R7-1/AC-R7-3 的 kill 可复现模型，真库）：
 * 「任意时机 kill」的可单测等价——订阅者收集一段帧前缀后**停止发射**
 * （= 进程死亡：不再有 emit），随后 journal flush（close）——断言：
 *  ① 订阅者已收的每一帧与 journal event 行 payload **逐字节一致**
 *    （JSON.stringify 相等——at/seq 原值，不重打；AC-R7-1 的逐字节面）；
 *  ② journal 回放 ⊇ 已收前缀（同一前缀可从 journal 重放——重启后一致）；
 *  ③ 无崩溃流的零丢失对账：发射帧数 == journal event 行数（delta 微批
 *    尾部经 close 全量落库；AC-R7-3 的 live 期累计 vs journal 行数）。
 *
 * 经 forRunLive + makeJournalWriter 的真实组合（emit 单点取号 + write-through
 * 先落库后发帧——run-live-registry 的 §3.4(a)/(b) 链路），kill = 停止发射。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { forRunLive, resetRunLiveForTest, attachRunLive } from '../run-live-registry.js'
import { makeJournalWriter } from '../journal-writer.js'

const FLOW_ID = '00000000-0000-4000-8000-00000000bb01'
const RUN_SUPERSET = '00000000-0000-4000-8000-00000000bb11'
const RUN_ZEROLOSS = '00000000-0000-4000-8000-00000000bb12'
const ALL_RUNS = [RUN_SUPERSET, RUN_ZEROLOSS]

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
  resetRunLiveForTest()
})

afterAll(async () => {
  resetRunLiveForTest()
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
})

/** canonical 序列化（递归键排序）：jsonb 落库会按物理序重排对象键——
 * 「逐字节一致」的可测口径 = 键序无关的规范化字节（值/at/seq 逐一保留）。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
  return `{${entries.join(',')}}`
}

/** 组装 live tap + journal writer 的真实组合（emit 分配 seq + 落库）。 */
function wiredTap(runId: string): {
  tap: ReturnType<typeof forRunLive>
  writer: ReturnType<typeof makeJournalWriter>
} {
  let counter = 0
  const allocSeq = (): number => {
    counter += 1
    return counter
  }
  const writer = makeJournalWriter({ runId, flowId: FLOW_ID, allocSeq })
  const tap = forRunLive(runId, FLOW_ID, () => 'llmAgentflow', writer)
  return { tap, writer }
}

describe('AC-R7-1：kill 后 journal 回放 ⊇ 已收前缀（逐字节一致）', () => {
  it('订阅者收 N 帧后停止发射（= kill）→ journal 行 payload 与已收帧逐字节相等', async () => {
    const { tap, writer } = wiredTap(RUN_SUPERSET)
    // 订阅者先挂上（收到全部后续帧——「已收前缀」的采集面，canonical 序列化）
    const received: string[] = []
    const attachment = attachRunLive(RUN_SUPERSET, (f) => {
      received.push(canonical(f))
    })
    expect(attachment).not.toBeNull()

    // 发射结构帧 + delta 混合流（write-through 落库后才 deliver）
    tap.nodeStart({ nodeId: 'n1', nodeName: 'LLM 1', ordinal: 0 })
    tap.delta({ nodeId: 'n1', nodeName: 'LLM 1' }, { type: 'text', text: '部分输出' })
    tap.delta({ nodeId: 'n1', nodeName: 'LLM 1' }, { type: 'text', text: '（尚未收尾）' })
    // 「kill」：nodeEnd 永不发出（在途边界帧的任意时机模型）、进程死亡
    // = 停止发射；close 把 delta 微批尾部落库（write-behind 尾部兑现）。
    writer.close()
    await new Promise((r) => setTimeout(r, 50))
    attachment!.unsubscribe()

    expect(received.length).toBeGreaterThanOrEqual(3)
    // journal 回放读取（seq 升序）
    const { records } = await runQuery<{ payload: unknown }>(
      `SELECT payload FROM run_node_journal
        WHERE run_id = $1::uuid AND kind = 'event' ORDER BY seq`,
      [RUN_SUPERSET],
    )
    const journalFrames = records.map((r) => canonical(r.payload))
    // ② ⊇：订阅者收到的每帧都能在 journal 行里找到（kill 后回放不缺帧）
    for (const frame of received) {
      expect(journalFrames).toContain(frame)
    }
    // ① 逐字节（按 seq 对齐）：订阅者接收序 ≠ seq 序——结构帧 write-through
    // 落库后才 deliver（晚于紧随的 delta）；回放按 seq 交付。两侧各按帧内
    // seq 排序后逐字节相等 = 「重放与关闭前已收内容一致」（AC-R7-1 口径）。
    const bySeq = (a: string, b: string): number =>
      (JSON.parse(a).seq ?? 0) - (JSON.parse(b).seq ?? 0)
    expect([...journalFrames].sort(bySeq)).toEqual([...received].sort(bySeq))
  })
})

describe('AC-R7-3：无崩溃流全程 journal 零丢失（发射数 == 行数）', () => {
  it('结构帧 + delta 全程跑完 + close → journal 行数 == 发射帧数（微批尾部不丢）', async () => {
    const { tap, writer } = wiredTap(RUN_ZEROLOSS)
    let emitted = 0
    const emitDelta = (text: string): void => {
      tap.delta({ nodeId: 'n1', nodeName: 'LLM 1' }, { type: 'text', text })
      emitted += 1
    }
    tap.nodeStart({ nodeId: 'n1', nodeName: 'LLM 1', ordinal: 0 })
    emitted += 1
    // 跨微批阈值（64 条）的混合量：1 批满 + 1 批尾部
    for (let i = 0; i < 70; i++) emitDelta(`chunk-${i}`)
    tap.nodeEnd({
      nodeId: 'n1',
      nodeName: 'LLM 1',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'success',
      input: {},
      output: { content: 'done' },
      tokens: null,
      ordinal: 0,
    })
    emitted += 1
    tap.finish('completed')
    emitted += 1
    writer.close()
    await new Promise((r) => setTimeout(r, 80))

    const { records } = await runQuery<{ count: string }>(
      `SELECT count(*) AS count FROM run_node_journal
        WHERE run_id = $1::uuid AND kind = 'event'`,
      [RUN_ZEROLOSS],
    )
    expect(Number(records[0]!.count)).toBe(emitted)
    // 终态 runEnd 也在（含 stopReason 缺席——completed 无来源）
    const runEnd = await runQuery<{ payload: unknown }>(
      `SELECT payload FROM run_node_journal
        WHERE run_id = $1::uuid AND event_type = 'runEnd'`,
      [RUN_ZEROLOSS],
    )
    expect((runEnd.records[0]!.payload as { status: string }).status).toBe('completed')
  })
})
