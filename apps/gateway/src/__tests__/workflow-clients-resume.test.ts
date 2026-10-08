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

import { buildCliMessages, createCliLlmClient } from '../routes/workflow-clients.js'

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

describe('resume 轮的消息折叠与文本档（2026-10-08 R5 测试补齐）', () => {
  it('增量回喂消息折叠 → systemPrompt=undefined（不重复注入 system 头/schema 契约块）', () => {
    // 节点层 resume 档只发 [本轮 user 回喂消息]（能力披露协议）——折叠结果
    // 无 system → claude buildClaudeArgs 跳过 --append-system-prompt，schema
    // 契约块由 --resume 会话文件自持（设计 §3.2 定稿）。
    const feed = {
      role: 'user',
      content:
        '你上一条输出不符合节点 outputSchema，违规明细（路径/期望/实际）：\n' +
        '- $.decision：期望 ["ship","hold"]，实际 "maybe"\n' +
        '请重新输出——只输出修正后的 JSON，不要任何其他文字、不要调用工具。',
    }
    const { systemPrompt, prompt } = buildCliMessages([feed])
    expect(systemPrompt).toBeUndefined()
    expect(prompt).toBe(`user: ${feed.content}`)
  })

  it('修复轮不传 tools + claude 档 → 文本档 extraArgs 生效（--disallowedTools）', async () => {
    // 设计 §3.1「顺带利好」：修复/NUDGE 轮无工具声明，claude 文本档自动收紧
    //（修复轮目标是交付 JSON，不给内建工具引入再截断风险）。
    scripted.events = [{ type: 'text', content: '{"decision":"ship"}' }]
    scripted.result = completedResult('{"decision":"ship"}', 'sess-xyz')
    scripted.execOptions = []
    const client = createCliLlmClient('claude', undefined, 'run-r5-3')

    const out = await client.chat({
      model: '',
      messages: [{ role: 'user', content: '你上一条输出不符合节点 outputSchema…' }],
      resumeSessionId: 'sess-xyz',
      // 修复轮形状：不带 tools
    })
    expect(out.sessionId).toBe('sess-xyz')
    expect(scripted.execOptions).toHaveLength(1)
    const opts = scripted.execOptions[0]!
    expect(opts.resumeSessionId).toBe('sess-xyz')
    expect(Array.isArray(opts.extraArgs)).toBe(true)
    expect((opts.extraArgs as string[]).join(' ')).toContain('--disallowedTools')
  })

  it('工具循环轮（带 tools）不做文本档收紧 —— 与修复轮形成对照', async () => {
    scripted.events = [{ type: 'text', content: 'ok' }]
    scripted.result = completedResult('ok', 'sess-loop')
    scripted.execOptions = []
    const client = createCliLlmClient('claude', undefined, 'run-r5-4')

    await client.chat({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'datetime_now', description: 'clock', parameters: { type: 'object' } },
        },
      ],
    })
    expect(scripted.execOptions[0]!.extraArgs).toBeUndefined()
  })
})
