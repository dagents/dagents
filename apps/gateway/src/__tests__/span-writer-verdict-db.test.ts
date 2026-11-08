import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { makeIncrementalSpanWriter } from '../span-writer.js'
import type { IExecutedNode } from '@dagents/workflow'

/**
 * R5 三值裁决的真库落点（design-verdict §3.1.1/§1-2，2026-10-08 测试补齐）：
 * verdict 裁决活动经 span-writer 终态合并落 `run_node_spans.output` JSONB
 * （events 全量 + activity 策展环 + 产出 json 字段共存）——mock 层钉子在同
 * 目录 span-writer.test.ts（vi.mock runQuery + fake timers 节流门控），本
 * 文件走 dagents_gw_test 真库（globalSetup 自动建/迁移）钉「SQL 真执行 +
 * JSONB 真落库 + UPDATE-then-INSERT 幂等」这段：这是终端/轨迹视图回放的
 * 数据源契约（AC-R5 轮次可观测）。
 *
 * 时序注意：writer 内部是 fire-and-forget + per-node promise 链（不阻塞
 * 执行波），终态行到位用 expect.poll 等待，不依赖毫秒时序。
 */

const createdRunIds: string[] = []
const createdFlowIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  assertTestDatabase(AppDataSource)
  for (const id of createdRunIds) {
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM run_node_journal WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM runs WHERE id = $1::uuid`, [id]).catch(() => {})
  }
  for (const id of createdFlowIds) {
    await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [id]).catch(() => {})
  }
})

/** jsonb 列兼容解析（pg 驱动常给对象，个别驱动配置给字符串）。 */
function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>
  return (v ?? {}) as Record<string, unknown>
}

async function seedRun(name: string): Promise<{ flowId: string; runId: string }> {
  const flowId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  createdFlowIds.push(flowId)
  createdRunIds.push(runId)
  await runQuery(
    `INSERT INTO flows (id, name, flow_data) VALUES ($1::uuid, $2, '{"nodes":[],"edges":[]}'::jsonb)`,
    [flowId, name],
  )
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at)
     VALUES ($1::uuid, $1::text, $2, 'running', '{}'::jsonb, NOW())`,
    [runId, flowId],
  )
  return { flowId, runId }
}

describe('span-writer verdict 活动真库落点（R5，dagents_gw_test）', () => {
  it('裁决轮次终态合并：events 全量 + activity 环 + 产出 json 共存于 output JSONB', async () => {
    const { flowId, runId } = await seedRun('e2e-gw-r5-verdict-db')
    const writer = makeIncrementalSpanWriter({
      runId,
      flowId,
      nodeLabelById: new Map([['agent', '裁决节点']]),
      nodeTypeById: new Map([['agent', 'platformAgent']]),
      log: { warn: () => {} },
    })

    const node = { nodeId: 'agent', nodeName: '裁决节点' }
    writer.onNodeStart(node)
    // 裁决循环的三类典型活动（platform-agent.node.ts emitVerdict 的产物）
    writer.onNodeDelta(node, {
      type: 'activity',
      kind: 'verdict',
      label: '第 1 轮裁决：violations（2 项违规）',
      detail: '- $.decision：期望 ["ship","hold"]，实际 "maybe"',
    })
    writer.onNodeDelta(node, {
      type: 'activity',
      kind: 'verdict',
      label: '第 2 轮 · 违规修复回喂（会话重建·对话回放）',
      detail: '你上一条输出不符合节点 outputSchema…',
    })
    writer.onNodeDelta(node, {
      type: 'activity',
      kind: 'verdict',
      label: '第 2 轮裁决：accept（合规收下）',
    })
    writer.onNodeDelta(node, { type: 'activity', kind: 'status', label: 'noise-not-in-ring' })
    writer.onNodeEnd({
      nodeId: 'agent',
      nodeName: '裁决节点',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      endedAt: new Date().toISOString(),
      status: 'success',
      input: { agentId: 'a1' },
      // 裁决 accept 路径的节点产出：text/content + 解析对象 json（{{id.json}}）
      output: {
        text: '{"decision":"ship","reason":"ok"}',
        content: '{"decision":"ship","reason":"ok"}',
        json: { decision: 'ship', reason: 'ok' },
      },
      ordinal: 0,
    } satisfies IExecutedNode)

    // fire-and-forget 写入链：轮询等终态行（含合并后的 output）
    await expect
      .poll(
        async () => {
          const { records } = await runQuery<{ status: string; output: unknown }>(
            `SELECT status, output FROM run_node_spans WHERE run_id = $1::uuid AND node_id = 'agent'`,
            [runId],
          )
          return records[0]?.status ?? ''
        },
        { timeout: 5000 },
      )
      .toBe('done')

    const { records } = await runQuery<{
      node_label: string
      node_type: string
      status: string
      output: unknown
    }>(
      `SELECT node_label, node_type, status, output FROM run_node_spans
        WHERE run_id = $1::uuid AND node_id = 'agent'`,
      [runId],
    )
    expect(records).toHaveLength(1)
    const row = records[0]!
    expect(row.node_label).toBe('裁决节点')
    expect(row.node_type).toBe('platformAgent')

    const out = asObject(row.output)
    // 产出契约共存：裁决收下的 json 与过程审计在同一行 output 里
    expect((out.json as Record<string, unknown>)?.decision).toBe('ship')
    // events：全量保真（三轮 verdict + status 噪音都在——status 也在 events，
    // 只是不进 activity 策展环）
    const events = (out.events as Array<{ kind: string; label: string; detail?: string }>) ?? []
    expect(events.filter((e) => e.kind === 'verdict').map((e) => e.label)).toEqual([
      '第 1 轮裁决：violations（2 项违规）',
      '第 2 轮 · 违规修复回喂（会话重建·对话回放）',
      '第 2 轮裁决：accept（合规收下）',
    ])
    expect(events[0]!.detail).toContain('$.decision')
    // activity 环：verdict 进环（策展可见），status 噪音不进
    const activity = (out.activity as Array<{ kind: string }>) ?? []
    expect(activity.every((a) => a.kind === 'verdict')).toBe(true)
    expect(activity).toHaveLength(3)
  })
})
