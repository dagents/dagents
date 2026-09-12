import { describe, expect, it } from 'vitest'
import {
  extractOutputText,
  formatTokensBadge,
  sectionTranscript,
  spanToTerminalSection,
} from './run-terminal-format'

describe('extractOutputText（正文直出 + DirectReply 二次解包）', () => {
  it('text 优先，content 兜底', () => {
    expect(extractOutputText({ text: '正文', content: 'c' })).toBe('正文')
    expect(extractOutputText({ content: 'c' })).toBe('c')
    expect(extractOutputText({})).toBeNull()
    expect(extractOutputText(null)).toBeNull()
  })

  it('字符串化 JSON 的 content 二次解包（DirectReply 形状）', () => {
    const wrapped = JSON.stringify({ text: '内层正文' })
    expect(extractOutputText({ content: wrapped })).toBe('内层正文')
  })
})

describe('spanToTerminalSection（events 全量 > activity 环降级）', () => {
  it('events 通道：全文保真映射成终端行', () => {
    const section = spanToTerminalSection({
      nodeId: 'n1',
      nodeLabel: '竞品分析',
      nodeType: 'platformAgent',
      status: 'done',
      durationMs: 2300,
      tokens: { inputTokens: 1200, outputTokens: 3400 },
      input: { model: 'sonnet' },
      output: {
        text: '最终正文',
        events: [
          { kind: 'thinking', label: '思考'.repeat(120), at: '2026-09-06T10:00:01Z' },
          { kind: 'tool', label: 'Bash', detail: '{"command":"ls -la"}', at: '2026-09-06T10:00:02Z' },
          { kind: 'tool_result', label: 'Bash', detail: 'file-a\nfile-b', at: '2026-09-06T10:00:03Z' },
          { kind: 'status', label: 'started', at: '2026-09-06T10:00:00Z' },
        ],
      },
    })
    expect(section.title).toBe('竞品分析')
    expect(section.command).toBe('$ agent · sonnet')
    expect(section.tokensBadge).toBe('↑1.2k ↓3.4k')
    expect(section.output).toBe('最终正文')
    expect(section.hasText).toBe(true)
    expect(section.rawJson).toBe('')
    expect(section.lines).toHaveLength(4)
    expect(section.lineSource).toBe('events')
    // thinking 全文（>100 字不截断 —— 终端是保真视图）
    expect(section.lines[0]!.label).toHaveLength(240)
    expect(section.lines[1]).toMatchObject({ kind: 'tool', label: 'Bash', detail: '{"command":"ls -la"}' })
    expect(section.lines[2]).toMatchObject({ kind: 'tool_result', detail: 'file-a\nfile-b' })
    expect(section.lines[3]).toMatchObject({ kind: 'status', label: 'started' })
  })

  it('无 events 时降级 activity 环（summary 作为行内容 —— 旧运行/早期 running）', () => {
    const section = spanToTerminalSection({
      nodeId: 'n1',
      output: {
        activity: [
          { kind: 'tool', label: 'Bash', summary: '{"command":"ls"}', at: '2026-09-06T10:00:02Z' },
          { kind: 'thinking', label: '旧形状全文在 label', at: '2026-09-06T10:00:01Z' },
        ],
      },
    })
    expect(section.lines).toHaveLength(2)
    expect(section.lineSource).toBe('activity') // 降级来源如实标注
    expect(section.lines[0]).toMatchObject({ kind: 'tool', label: 'Bash', detail: '{"command":"ls"}' })
    expect(section.lines[1]).toMatchObject({ kind: 'thinking', label: '旧形状全文在 label' })
  })

  it('形状坏损的条目被丢弃，不炸整段', () => {
    const section = spanToTerminalSection({
      nodeId: 'n1',
      output: { events: [{ kind: 'nonsense', label: 'x' }, { kind: 'tool' }, 'garbage', { kind: 'error', label: 'boom' }] },
    })
    expect(section.lines).toEqual([{ kind: 'error', label: 'boom' }])
  })

  it('无正文的裸 JSON 产出进 rawJson（controller 类节点）', () => {
    const section = spanToTerminalSection({ nodeId: 'n1', output: { iterations: 3 } })
    expect(section.output).toBe('')
    expect(section.hasText).toBe(false)
    expect(section.rawJson).toContain('iterations')
  })

  it('nodeId 缺失时 node_id 兜底；command 随 nodeType 变化', () => {
    const s1 = spanToTerminalSection({ node_id: 'x1', nodeType: 'llm', input: {} })
    expect(s1.id).toBe('x1')
    expect(s1.command).toBe('$ llm')
    const s2 = spanToTerminalSection({ node_id: 'x2', nodeType: 'unknown-kind' })
    expect(s2.command).toBe('$ unknown-kind')
  })
})

describe('user_input 插话行（2026-09-08 可操作终端）', () => {
  it('events 与 activity 环里的 user_input 都映射为终端行（label = 消息全文）', () => {
    for (const channel of ['events', 'activity'] as const) {
      const section = spanToTerminalSection({
        nodeId: 'n2',
        nodeLabel: '开发',
        nodeType: 'platformAgent',
        status: 'running',
        output: {
          [channel]: [{ kind: 'user_input', label: '重点看登录模块', at: '2026-09-08T10:00:00Z' }],
        },
      })
      expect(section.lines).toHaveLength(1)
      expect(section.lines[0]).toMatchObject({ kind: 'user_input', label: '重点看登录模块' })
      expect(section.lineSource).toBe(channel)
    }
  })

  it('sectionTranscript 用 ❯ 标记插话行（与 $ 提示行同一终端字形惯例）', () => {
    const transcript = sectionTranscript({
      id: 'n2',
      title: '开发',
      status: 'running',
      tokensBadge: null,
      command: '$ agent · sonnet',
      lines: [{ kind: 'user_input', label: '补一条约束' }],
      output: '',
      rawJson: '',
      lineSource: 'events',
      error: null,
      hasText: false,
    })
    expect(transcript).toContain('❯ 补一条约束')
  })
})

describe('formatTokensBadge', () => {
  it('k 缩写 / 空用量 null', () => {
    expect(formatTokensBadge({ inputTokens: 999, outputTokens: 1200 })).toBe('↑999 ↓1.2k')
    expect(formatTokensBadge({})).toBeNull()
    expect(formatTokensBadge(null)).toBeNull()
  })
})

describe('sectionTranscript（复制实录）', () => {
  it('段头 + 提示行 + 事件行 + 正文', () => {
    const text = sectionTranscript({
      id: 'n1',
      title: '竞品分析',
      status: 'done',
      durationMs: 2300,
      tokensBadge: '↑1.2k ↓3.4k',
      nodeType: 'platformAgent',
      command: '$ agent · sonnet',
      lines: [
        { kind: 'thinking', label: '先查文档' },
        { kind: 'tool', label: 'Bash', detail: '{"command":"ls"}' },
      ],
      output: '最终正文',
      rawJson: '',
      lineSource: 'events',
      error: null,
      hasText: true,
    })
    expect(text).toContain('── 竞品分析 · done ──')
    expect(text).toContain('$ agent · sonnet')
    expect(text).toContain('💭 先查文档')
    expect(text).toContain('🔧 Bash')
    expect(text).toContain('{"command":"ls"}')
    expect(text).toContain('最终正文')
  })
})
