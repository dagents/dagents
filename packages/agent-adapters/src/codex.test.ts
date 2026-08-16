import { describe, it, expect } from 'vitest'
import { buildCodexArgs, parseCodexLine } from './codex.js'
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

describe('buildCodexArgs — 真实无头模式（codex exec --json）', () => {
  it('uses the exec subcommand with --json and the prompt after --', () => {
    const args = buildCodexArgs('do the thing', {})
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args[args.length - 2]).toBe('--')
    expect(args[args.length - 1]).toBe('do the thing')
  })

  it('never spawns the interactive TUI (no bare -q form)', () => {
    const args = buildCodexArgs('p', {})
    expect(args).not.toContain('-q')
  })

  it('passes model and maxTurns as daemon-owned flags', () => {
    const args = buildCodexArgs('p', { model: 'gpt-5.3-codex', maxTurns: 4 })
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.3-codex')
    expect(args).toContain('--max-turns')
    expect(args).toContain('4')
  })
})

describe('parseCodexLine — codex-rs exec --json 事件流', () => {
  it('captures thread_id and streams agent_message text', () => {
    const state = makeState()
    parseCodexLine('{"type":"thread.started","thread_id":"th_123"}', state)
    expect(state.sessionId).toBe('th_123')

    const events = parseCodexLine(
      '{"type":"item.completed","item":{"item_id":"item_0","type":"agent_message","text":"hello"}}',
      state,
    )
    expect(state.output).toBe('hello')
    expect(events).toEqual([{ type: 'text', content: 'hello' }])
  })

  it('maps command_execution to tool-use + tool-result pairs', () => {
    const state = makeState()
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"item_id":"c1","type":"command_execution","command":"ls -la","aggregated_output":"file-a\\nfile-b","exit_code":0}}',
      state,
    )
    expect(events[0]).toMatchObject({ type: 'tool-use', tool: 'shell', callId: 'c1' })
    expect(events[1]).toMatchObject({ type: 'tool-result', output: 'file-a\nfile-b' })
  })

  it('records turn.completed usage (incl. cached input)', () => {
    const state = makeState()
    parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":50}}',
      state,
    )
    expect(state.usage['codex']).toMatchObject({ inputTokens: 100, outputTokens: 50 })
    expect(state.usage['codex'].cacheReadTokens).toBe(80)
  })

  it('marks the run failed on turn.failed / error events', () => {
    const s1 = makeState()
    parseCodexLine('{"type":"turn.failed","error":{"message":"stream disconnected"}}', s1)
    expect(s1.finalStatus).toBe('failed')
    expect(s1.finalError).toBe('stream disconnected')

    const s2 = makeState()
    parseCodexLine('{"type":"error","error":{"message":"boom"}}', s2)
    expect(s2.finalStatus).toBe('failed')
  })
})
