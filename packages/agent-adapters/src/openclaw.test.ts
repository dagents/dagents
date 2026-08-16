import { describe, it, expect } from 'vitest'
import { parseOpenclawLine } from './openclaw.js'
import type { StreamAgentRunState } from './stream-backend.js'

function makeState(): StreamAgentRunState {
  return {
    usage: {},
    sessionId: undefined,
    output: '',
    finalStatus: 'completed',
    finalError: undefined,
  }
}

describe('parseOpenclawLine — 实测 openclaw 2026.7.1 输出格式（2026-08-16 probe）', () => {
  it('parses a single-line result blob (payloads + agentMeta)', () => {
    const state = makeState()
    const events = parseOpenclawLine(
      '{"payloads":[{"text":"hello"}],"meta":{"durationMs":42,"agentMeta":{"model":"gpt","sessionId":"s1","usage":{"input":10,"output":5}}}}',
      state,
    )
    expect(state.output).toBe('hello')
    expect(state.sessionId).toBe('s1')
    expect(state.usage['gpt']).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(events).toEqual([{ type: 'text', content: 'hello' }])
    expect(state.finalStatus).toBe('completed')
  })

  it('buffers a pretty-printed (multi-line) result blob until it parses', () => {
    const state = makeState()
    const lines = [
      '{',
      '  "payloads": [',
      '    { "text": "multi" },',
      '    { "text": "line" }',
      '  ],',
      '  "meta": { "durationMs": 7 }',
      '}',
    ]
    // 前 N-1 行都在缓冲，无事件产出
    for (let i = 0; i < lines.length - 1; i++) {
      expect(parseOpenclawLine(lines[i], state)).toEqual([])
    }
    const events = parseOpenclawLine(lines[lines.length - 1], state)
    expect(state.output).toBe('multiline')
    expect(events.map((e) => e.type)).toEqual(['text', 'text'])
  })

  it('multi-line buffering is isolated per run state', () => {
    const a = makeState()
    const b = makeState()
    parseOpenclawLine('{', a)
    parseOpenclawLine('{', b) // b 单独缓冲，不受 a 影响
    expect(parseOpenclawLine('"meta": { "durationMs": 1 },', b)).toEqual([])
    expect(parseOpenclawLine('"payloads": []', b)).toEqual([])
    expect(parseOpenclawLine('}', b)).toEqual([]) // 合法结果 blob，无 text → 无事件
    expect(a.output).toBe('')
    expect(b.output).toBe('')
    // a 的缓冲仍未闭合，b 已完成
    expect(parseOpenclawLine('"still": "open"', a)).toEqual([])
  })

  it('marks a run failed on plain-text error lines (exit code is 0!)', () => {
    const state = makeState()
    const events = parseOpenclawLine(
      'FailoverError: No API key found for provider "openai". Auth store: ~/.openclaw/agents/main/agent/openclaw-agent.sqlite | missing-provider-auth',
      state,
    )
    expect(state.finalStatus).toBe('failed')
    expect(state.finalError).toMatch(/No API key found/)
    expect(events[0].type).toBe('error')

    const state2 = makeState()
    parseOpenclawLine('GatewayCredentialsRequiredError: gateway agent requires credentials', state2)
    expect(state2.finalStatus).toBe('failed')
  })

  it('keeps [diagnostic] lines as logs without failing the run', () => {
    const state = makeState()
    const events = parseOpenclawLine(
      '[diagnostic] lane task error: lane=main durationMs=1404 error="ProviderAuthError: ..."',
      state,
    )
    expect(events).toEqual([{ type: 'log', content: expect.stringContaining('lane task error') }])
    expect(state.finalStatus).toBe('completed')
  })

  it('still parses NDJSON streaming events (forward-compat)', () => {
    const state = makeState()
    const events = parseOpenclawLine('{"type":"text","text":"chunk","sessionId":"s9"}', state)
    expect(events).toEqual([{ type: 'text', content: 'chunk' }])
    expect(state.sessionId).toBe('s9')

    const errEvents = parseOpenclawLine('{"type":"error","error":{"message":"boom"}}', state)
    expect(state.finalStatus).toBe('failed')
    expect(errEvents[0]).toMatchObject({ type: 'error', content: 'boom' })
  })
})
