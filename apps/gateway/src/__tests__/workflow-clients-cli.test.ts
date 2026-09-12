/**
 * createCliLlmClient 的 turn-boundary 分隔符（2026-09-08 可操作终端）：
 * 运行中插话把节点产出拆成多个 turn，正文拼接必须补分隔符 —— 否则
 * 「数到 40」和「插话后的回答」粘成「40我此刻」。可编程后端桩回放
 * turn-boundary 事件序列，钉 chat 与 chatStream 两条消费路径。
 */
import { describe, it, expect, vi } from 'vitest'

const scripted = vi.hoisted(() => ({
  events: [] as unknown[],
  result: null as unknown,
}))

vi.mock('@dagents/db', () => ({
  runQuery: vi.fn().mockResolvedValue({ records: [], affected: 1 }),
}))

vi.mock('@dagents/agent-adapters', () => ({
  createBackend: () => ({
    execute: () => ({
      events: (async function* () {
        for (const e of scripted.events) yield e
      })(),
      result: Promise.resolve(scripted.result),
    }),
  }),
}))

import { createCliLlmClient } from '../routes/workflow-clients.js'

function completedResult(output: string): unknown {
  return { status: 'completed', output, durationMs: 1, usage: {} }
}

describe('CLI client turn-boundary 分隔符（2026-09-08 可操作终端）', () => {
  it('chat：turn-boundary → 正文补 \\n\\n 分隔 + 过程流记「插话已并入」', async () => {
    scripted.events = [
      { type: 'status', status: 'started', sessionId: 's1' },
      { type: 'text', content: '1\n2\n40' },
      { type: 'status', status: 'turn-boundary' },
      { type: 'text', content: '我此刻运行在…' },
      { type: 'status', status: 'completed', sessionId: 's1' },
    ]
    scripted.result = completedResult('我此刻运行在…')
    const client = createCliLlmClient('claude', undefined, 'run-sep-1')
    const deltas: Array<{ type: string; label?: string; text?: string }> = []
    const { text } = await client.chat({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      nodeId: 'n2',
      onDelta: (d) => deltas.push(d as { type: string; label?: string }),
    })
    // 回归钉死：turn 边界不再是「40我此刻」粘连
    expect(text).toBe('1\n2\n40\n\n我此刻运行在…')
    expect(text).not.toContain('40我')
    // 边界在过程流里可见（终端回放读得出「插话在这里被消化」）
    expect(
      deltas.some((d) => typeof d.label === 'string' && d.label.includes('插话已并入')),
    ).toBe(true)
    // text 增量照旧逐段转发（两段正文都在）
    expect(deltas.filter((d) => d.type === 'text')).toHaveLength(2)
  })

  it('chatStream：turn-boundary → yield 分隔 delta（SSE 流同语义）', async () => {
    scripted.events = [
      { type: 'text', content: 'A' },
      { type: 'status', status: 'turn-boundary' },
      { type: 'text', content: 'B' },
    ]
    scripted.result = completedResult('B')
    const client = createCliLlmClient('claude', undefined, 'run-sep-2')
    let acc = ''
    for await (const chunk of client.chatStream({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.delta) acc += chunk.delta
    }
    expect(acc).toBe('A\n\nB')
  })
})
