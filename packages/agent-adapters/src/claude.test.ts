import { describe, it, expect } from 'vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { claudeBackend, buildClaudeArgs, parseEvent } from './claude.js'
import { writeMcpConfigToTemp } from './mcp-config.js'
import type { Logger } from '@dagents/contracts'
import './claude.lifecycle.test.js'

// A capturing logger for asserting filterCustomArgs warn output.
function capturingLogger(): Logger & { warns: Array<{ msg: string; ctx?: unknown }> } {
  const warns: Array<{ msg: string; ctx?: unknown }> = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, ctx) => warns.push({ msg, ctx }),
    error: () => {},
  }
  return { ...log, warns }
}

describe('claudeBackend', () => {
  it('execute 返回 AgentSession', () => {
    const b = claudeBackend({ executablePath: 'claude' })
    const session = b.execute('hi', {})
    expect(session.events).toBeDefined()
    expect(typeof session.result.then).toBe('function')
  })

  it('buildClaudeArgs 构造 stream-json 参数', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-4-20250514', thinkingLevel: 'high' })
    expect(args).toContain('--print')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--model')
    expect(args).toContain('claude-sonnet-4-20250514')
  })

  it('buildClaudeArgs 含 resume', () => {
    const args = buildClaudeArgs({ resumeSessionId: 'sess-123' })
    expect(args).toContain('--resume')
    expect(args).toContain('sess-123')
  })

  it('buildClaudeArgs thinkingLevel 透传为 --effort', () => {
    const args = buildClaudeArgs({ thinkingLevel: 'xhigh' })
    expect(args).toContain('--effort')
    expect(args).toContain('xhigh')
  })

  it('buildClaudeArgs extraArgs/customArgs 透传，但协议关键 flag 被过滤', () => {
    const args = buildClaudeArgs({
      extraArgs: ['--add-dir', '/tmp'],
      customArgs: ['--output-format', 'json', '--foo', 'bar'],
    })
    expect(args).toContain('--add-dir')
    expect(args).toContain('/tmp')
    expect(args).toContain('--foo')
    expect(args).toContain('bar')
    // 协议关键 flag 必须被过滤：不能让用户覆盖 stream-json
    expect(args.filter((a) => a === '--output-format')).toHaveLength(1)
    expect(args.filter((a) => a === 'json')).toHaveLength(0)
  })

  it('buildClaudeArgs 过滤 blocked flag 时记 warn 日志', () => {
    const log = capturingLogger()
    buildClaudeArgs({ customArgs: ['--output-format', 'json'] }, log)
    expect(log.warns.length).toBeGreaterThan(0)
    expect(log.warns[0].ctx).toMatchObject({ flag: '--output-format' })
  })

  it('buildClaudeArgs maxTurns/systemPrompt 透传', () => {
    const args = buildClaudeArgs({ maxTurns: 5, systemPrompt: 'be terse' })
    expect(args).toContain('--max-turns')
    expect(args).toContain('5')
    expect(args).toContain('--append-system-prompt')
    expect(args).toContain('be terse')
  })

  it('buildClaudeArgs mcpConfigPath 注入 --mcp-config', () => {
    const args = buildClaudeArgs({}, undefined, '/tmp/mil-claude-mcp-xyz/mcp.json')
    const idx = args.indexOf('--mcp-config')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('/tmp/mil-claude-mcp-xyz/mcp.json')
  })

  it('buildClaudeArgs 无 mcpConfigPath 时不加 --mcp-config', () => {
    const args = buildClaudeArgs({})
    expect(args).not.toContain('--mcp-config')
  })

  it('buildClaudeArgs mcpConfig 路径优先于 customArgs 中的 --mcp-config（blocked）', () => {
    const log = capturingLogger()
    const args = buildClaudeArgs(
      { customArgs: ['--mcp-config', '/attacker/controlled.json'] },
      log,
      '/daemon/owned.json',
    )
    // daemon-owned path is the single authoritative occurrence
    const occ = args.reduce((acc: number[], a, i) => (a === '--mcp-config' ? [...acc, i] : acc), [])
    expect(occ).toHaveLength(1)
    expect(args[occ[0] + 1]).toBe('/daemon/owned.json')
    // the caller's copy was filtered with a warn
    expect(log.warns.some((w) => (w.ctx as { flag?: string })?.flag === '--mcp-config')).toBe(true)
  })

  it('parseEvent: assistant text → text 事件', () => {
    const evs = parseEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(evs).toEqual([{ type: 'text', content: 'hello' }])
  })

  it('parseEvent: assistant thinking block → thinking 事件', () => {
    const evs = parseEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
    })
    expect(evs).toEqual([{ type: 'thinking', content: 'pondering' }])
  })

  it('parseEvent: assistant tool_use → tool-use 事件', () => {
    const evs = parseEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', id: 'tu_1', input: { command: 'echo hi' } }],
      },
    })
    expect(evs).toEqual([
      { type: 'tool-use', tool: 'Bash', callId: 'tu_1', input: { command: 'echo hi' } },
    ])
  })

  it('parseEvent: user tool_result → tool-result 事件', () => {
    const evs = parseEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hi\n' }] },
    })
    expect(evs).toEqual([{ type: 'tool-result', tool: '', callId: 'tu_1', output: 'hi\n' }])
  })

  it('parseEvent: system init → status started；result → status completed（result 文本由 loop 聚合，非 parseEvent）', () => {
    const start = parseEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    expect(start).toContainEqual({ type: 'status', status: 'started', sessionId: 'sess-1' })
    const done = parseEvent({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' })
    expect(done).toContainEqual({ type: 'status', status: 'completed', sessionId: 'sess-1' })
  })
})

describe('writeMcpConfigToTemp', () => {
  it('无 mcpConfig 返回 null（不写文件）', async () => {
    expect(await writeMcpConfigToTemp(undefined)).toBeNull()
    expect(await writeMcpConfigToTemp(null)).toBeNull()
  })

  it('空对象 返回 null（no-op，不付 IO 代价）', async () => {
    expect(await writeMcpConfigToTemp({})).toBeNull()
  })

  it('写入临时文件，内容 = JSON(mcpConfig)，路径以 mil-claude-mcp 开头', async () => {
    const fs = await import('node:fs/promises')
    const mcp = { mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } } }
    const file = await writeMcpConfigToTemp(mcp)
    expect(file).not.toBeNull()
    const f = file!
    expect(f.path).toMatch(/mil-claude-mcp/)
    const written = await fs.readFile(f.path, 'utf8')
    expect(JSON.parse(written)).toEqual(mcp)
    await f.cleanup()
    // cleanup removed the file
    await expect(fs.readFile(f.path, 'utf8')).rejects.toThrow()
  })

  it('cleanup 幂等：多次调用不抛', async () => {
    const file = await writeMcpConfigToTemp({ mcpServers: { x: { command: 'y' } } })
    const f = file!
    await f.cleanup()
    await f.cleanup() // no throw
  })

  it('非对象 mcpConfig 抛 TypeError（数组 / 原始值）', async () => {
    await expect(writeMcpConfigToTemp([{ command: 'x' }])).rejects.toThrow(TypeError)
    await expect(writeMcpConfigToTemp('not-an-object')).rejects.toThrow(TypeError)
  })
})

describe('buildClaudeArgs — permission mode（非交互工具授权）', () => {
  const ORIGINAL = process.env.DAGENTS_CLAUDE_PERMISSION_MODE
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DAGENTS_CLAUDE_PERMISSION_MODE
    else process.env.DAGENTS_CLAUDE_PERMISSION_MODE = ORIGINAL
  })

  it('默认追加 --permission-mode bypassPermissions（否则 --print 下写文件类工具被拒）', () => {
    delete process.env.DAGENTS_CLAUDE_PERMISSION_MODE
    const args = buildClaudeArgs({})
    const i = args.indexOf('--permission-mode')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('bypassPermissions')
  })

  it('DAGENTS_CLAUDE_PERMISSION_MODE 可覆盖（收紧为 acceptEdits）', () => {
    process.env.DAGENTS_CLAUDE_PERMISSION_MODE = 'acceptEdits'
    const args = buildClaudeArgs({})
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('设为 none 时不加该参数（交由 CLI 默认行为）', () => {
    process.env.DAGENTS_CLAUDE_PERMISSION_MODE = 'none'
    expect(buildClaudeArgs({})).not.toContain('--permission-mode')
  })
})
