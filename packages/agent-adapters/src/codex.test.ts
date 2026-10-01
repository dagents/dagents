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
    const args = buildCodexArgs('p', { model: 'gpt-5.3-codex' })
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.3-codex')
  })
})

// ─── 真机回归取证（2026-09-23，codex-cli 0.156.1 实测 argv 兼容性）──────────
describe('buildCodexArgs — 0.156.1 实测 argv', () => {
  it('默认沙箱映射到 -s workspace-write（--full-auto 已于 0.15x 移除）', () => {
    // 真机取证：0.156.1 二进制零 "full-auto" 字符串；--full-auto 直接
    // exit 2（unexpected argument）。语义等价的保守全自动是 workspace-write。
    const args = buildCodexArgs('p', {})
    expect(args).not.toContain('--full-auto')
    expect(args).toContain('-s')
    expect(args[args.indexOf('-s') + 1]).toBe('workspace-write')
  })

  it('DAGENTS_CODEX_SANDBOX 透传到 -s（workspace-write/read-only/danger-full-access 三档）', () => {
    const prev = process.env.DAGENTS_CODEX_SANDBOX
    try {
      process.env.DAGENTS_CODEX_SANDBOX = 'read-only'
      const args = buildCodexArgs('p', {})
      expect(args[args.indexOf('-s') + 1]).toBe('read-only')

      process.env.DAGENTS_CODEX_SANDBOX = 'danger-full-access'
      const args2 = buildCodexArgs('p', {})
      expect(args2[args2.indexOf('-s') + 1]).toBe('danger-full-access')

      process.env.DAGENTS_CODEX_SANDBOX = 'none'
      const args3 = buildCodexArgs('p', {})
      expect(args3).not.toContain('-s')
    } finally {
      if (prev === undefined) delete process.env.DAGENTS_CODEX_SANDBOX
      else process.env.DAGENTS_CODEX_SANDBOX = prev
    }
  })

  it('maxTurns 不再映射 --max-turns（0.156.1 已移除且无替代 flag/config）', () => {
    // 真机取证：--max-turns → exit 2；binary 无任何 max_turns config key；
    // -c 'turn_context.max_turns' 等试探均被 "unrecognized setting" 忽略。
    // 诚实行为：不生成该 flag（多轮上限交由调用方 timeoutMs/看门狗兜底）。
    const args = buildCodexArgs('p', { maxTurns: 4 })
    expect(args).not.toContain('--max-turns')
    expect(args).not.toContain('4')
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

// ─── 真机回归取证（2026-09-23，codex-cli 0.156.1 + 本地 Responses 后端）──────
// 以下形状全部来自 Gate-RC1 真实捕获（fixtures/codex/*/raw.ndjson 的最小化
// 抽样）——文档假设与真机的偏差在此钉死。
describe('parseCodexLine — 真机 0.156.1 实测形状', () => {
  it('error 顶层帧是瞬态重连事件（无 error 包装对象），不得毒化 finalStatus', () => {
    // 真机：模型断流时 codex 发 {"type":"error","message":"Reconnecting... 1/5 (...)"}
    // 连发最多 5 次，随后可能恢复。把瞬态帧当终态会把成功运行标成 failed。
    const state = makeState()
    const events = parseCodexLine(
      '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: model \'x\' not found)"}',
      state,
    )
    expect(state.finalStatus).toBe('completed') // 瞬态：不置 failed
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0) // 也不是 error 事件
    expect(events.some((e) => e.type === 'log')).toBe(true) // 以 log 透出（保留证据）
  })

  it('终局 error 帧（非 Reconnecting）仍标 failed', () => {
    // 真机：重试耗尽后 codex 发一条不带 "Reconnecting" 前缀的最终 error 帧，
    // 随后 turn.failed 收尾。最终帧语义仍是失败信号（turn.failed 也会到，
    // 双保险）。
    const state = makeState()
    parseCodexLine(
      '{"type":"error","message":"stream disconnected before completion: model \'x\' not found"}',
      state,
    )
    expect(state.finalStatus).toBe('failed')
  })

  it('旧文档形状（error.message 包装）仍标 failed（兼容分支保留）', () => {
    const state = makeState()
    parseCodexLine('{"type":"error","error":{"message":"boom"}}', state)
    expect(state.finalStatus).toBe('failed')
  })

  it('reasoning item 的正文字段是 text（0.156.1 实测），summary 仅作旧形状兜底', () => {
    const state = makeState()
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking..."}}',
      state,
    )
    expect(events).toEqual([{ type: 'log', content: 'thinking...' }])

    const events2 = parseCodexLine(
      '{"type":"item.completed","item":{"id":"item_2","type":"reasoning","summary":"old shape"}}',
      state,
    )
    expect(events2).toEqual([{ type: 'log', content: 'old shape' }])
  })

  it('item.completed 的 callId 主字段是 id（item_id 为旧形状兜底）', () => {
    const state = makeState()
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"cmd_9","type":"command_execution","command":"ls","aggregated_output":"a","exit_code":0}}',
      state,
    )
    expect(events[0]).toMatchObject({ type: 'tool-use', callId: 'cmd_9' })
  })

  it('error item（如模型元数据警告）→ log 事件透出，不影响终态', () => {
    // 真机：{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata ... not found. Defaulting to fallback ..."}}
    const state = makeState()
    const events = parseCodexLine(
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `qwen3:8b` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
      state,
    )
    expect(state.finalStatus).toBe('completed')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('log')
  })

  it('turn.completed usage 实测形状：含 cache_write_input_tokens / reasoning_output_tokens 附加字段（映射兼容）', () => {
    const state = makeState()
    parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":2050,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":684,"reasoning_output_tokens":0}}',
      state,
    )
    expect(state.usage['codex']).toMatchObject({ inputTokens: 2050, outputTokens: 684 })
    expect(state.usage['codex'].cacheReadTokens).toBe(4)
  })
})
