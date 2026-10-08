/**
 * createCliLlmClient 的会话延续接线（2026-10-07 R5 三值裁决）：
 *  1. chat 返回透传后端 result.sessionId（能力披露协议的回传腿）；
 *  2. params.resumeSessionId 原样进 backend.execute 的 ExecOptions（claude
 *     侧自动转 `--resume`；gateway 层零 id 换算——取值单源约束）；
 *  3. 两侧缺席 = 诚实缺席（无会话延续能力，节点层自动落回放路径）。
 */
import { describe, it, expect, vi } from 'vitest'

const scripted = vi.hoisted(() => ({
  events: [] as unknown[],
  result: null as unknown,
  execOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@dagents/db', () => ({
  runQuery: vi.fn().mockResolvedValue({ records: [], affected: 1 }),
}))

vi.mock('@dagents/agent-adapters', () => ({
  createBackend: () => ({
    execute: (_prompt: string, opts: Record<string, unknown>) => {
      scripted.execOptions.push(opts)
      return {
        events: (async function* () {
          for (const e of scripted.events) yield e
        })(),
        result: Promise.resolve(scripted.result),
      }
    },
  }),
}))

import { createCliLlmClient } from '../routes/workflow-clients.js'

function completedResult(output: string, sessionId?: string): unknown {
  return { status: 'completed', output, durationMs: 1, usage: {}, sessionId }
}

describe('CLI client 会话延续接线（2026-10-07 R5）', () => {
  it('chat 透传 result.sessionId + resumeSessionId 原样进 ExecOptions', async () => {
    scripted.events = [{ type: 'text', content: 'final' }]
    scripted.result = completedResult('final', 'sess-abc')
    scripted.execOptions = []
    const client = createCliLlmClient('claude', undefined, 'run-r5-1')

    const out = await client.chat({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      resumeSessionId: 'sess-abc',
    })
    // 回传腿：后端真实会话 id 原样上抛（节点层能力披露协议的输入）
    expect(out.sessionId).toBe('sess-abc')
    // 去程腿：参数原样透传进 ExecOptions（claude buildClaudeArgs → --resume）
    expect(scripted.execOptions).toHaveLength(1)
    expect(scripted.execOptions[0]!.resumeSessionId).toBe('sess-abc')
  })

  it('两侧缺席 = 诚实缺席：返回不带 sessionId、ExecOptions 无 resumeSessionId 键', async () => {
    scripted.events = [{ type: 'text', content: 'final' }]
    scripted.result = completedResult('final')
    scripted.execOptions = []
    const client = createCliLlmClient('claude', undefined, 'run-r5-2')

    const out = await client.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(out.sessionId).toBeUndefined()
    expect(scripted.execOptions).toHaveLength(1)
    expect('resumeSessionId' in scripted.execOptions[0]!).toBe(false)
  })
})
