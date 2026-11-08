import { describe, expect, it } from 'vitest'
import { normalizeRunNodeSpan } from './node-spans'
import {
  createLiveSectionBuilder,
  extractOutputText,
  formatTokensBadge,
  sectionTranscript,
  spanToTerminalSection,
  buildDeliverablesTranscript,
} from './run-terminal-format'
import { extractDeliverableText, type DeliverableItem } from '@dagents/contracts'

/** 消费方契约：原始行先过边界归一（nodeId/node_id 双写在那一层处理），
 *  派生层只吃规范 RunNodeSpan —— 测试同管线组合。 */
const row = (raw: Record<string, unknown>) => normalizeRunNodeSpan(raw)

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
    const section = spanToTerminalSection(row({
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
    }))
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
    const section = spanToTerminalSection(row({
      nodeId: 'n1',
      output: {
        activity: [
          { kind: 'tool', label: 'Bash', summary: '{"command":"ls"}', at: '2026-09-06T10:00:02Z' },
          { kind: 'thinking', label: '旧形状全文在 label', at: '2026-09-06T10:00:01Z' },
        ],
      },
    }))
    expect(section.lines).toHaveLength(2)
    expect(section.lineSource).toBe('activity') // 降级来源如实标注
    expect(section.lines[0]).toMatchObject({ kind: 'tool', label: 'Bash', detail: '{"command":"ls"}' })
    expect(section.lines[1]).toMatchObject({ kind: 'thinking', label: '旧形状全文在 label' })
  })

  it('形状坏损的条目被丢弃，不炸整段', () => {
    const section = spanToTerminalSection(row({
      nodeId: 'n1',
      output: { events: [{ kind: 'nonsense', label: 'x' }, { kind: 'tool' }, 'garbage', { kind: 'error', label: 'boom' }] },
    }))
    expect(section.lines).toEqual([{ kind: 'error', label: 'boom' }])
  })

  it('无正文的裸 JSON 产出进 rawJson（controller 类节点）', () => {
    const section = spanToTerminalSection(row({ nodeId: 'n1', output: { iterations: 3 } }))
    expect(section.output).toBe('')
    expect(section.hasText).toBe(false)
    expect(section.rawJson).toContain('iterations')
  })

  it('node_id 兜底在边界归一层完成；command 随 nodeType 变化', () => {
    const s1 = spanToTerminalSection(row({ node_id: 'x1', nodeType: 'llm', input: {} }))
    expect(s1.id).toBe('x1')
    expect(s1.command).toBe('$ llm')
    const s2 = spanToTerminalSection(row({ node_id: 'x2', nodeType: 'unknown-kind' }))
    expect(s2.command).toBe('$ unknown-kind')
  })
})

describe('user_input 插话行（2026-09-08 可操作终端）', () => {
  it('events 与 activity 环里的 user_input 都映射为终端行（label = 消息全文）', () => {
    for (const channel of ['events', 'activity'] as const) {
      const section = spanToTerminalSection(row({
        nodeId: 'n2',
        nodeLabel: '开发',
        nodeType: 'platformAgent',
        status: 'running',
        output: {
          [channel]: [{ kind: 'user_input', label: '重点看登录模块', at: '2026-09-08T10:00:00Z' }],
        },
      }))
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

/* ── R6 渐进产物（2026-10-07）：聚合区 transcript + 同一提取单源钉子 ── */

describe('AC-R6-4：聚合区与单节点行同一提取单源', () => {
  it('extractOutputText 就是 contracts 的 extractDeliverableText（同一函数对象）', () => {
    // 物理单源：run-terminal-format 只 re-export（实现上移 contracts），
    // 不存在第二套提取实现。
    expect(extractOutputText).toBe(extractDeliverableText)
  })

  it('同一 span 载荷语料：聚合路径与终端段路径提取的正文逐字一致', () => {
    const corpus: unknown[] = [
      { text: '正文甲' },
      { content: '正文乙' },
      { text: '{"text":"DirectReply 内层"}' },
      { text: '{"content":"内层 content"}' },
      { foo: 'bar' },
      'plain string',
      null,
    ]
    for (const payload of corpus) {
      // 单节点行路径：spanToDisplay 的正文 = extractOutputText(payload)
      //（canvas-results-panel.tsx spanToDisplay）；终端段同源
      const viaSection = spanToTerminalSection(
        row({ nodeId: 'n1', nodeLabel: '节点一', output: payload as never }),
      ).output
      const viaAggregate = extractDeliverableText(payload as never) ?? ''
      expect(viaSection).toBe(viaAggregate)
    }
  })
})

describe('buildDeliverablesTranscript（聚合区复制/下载载荷，R6）', () => {
  const base: DeliverableItem = {
    nodeId: 'a',
    nodeLabel: '翻译',
    nodeType: 'llmAgentflow',
    ordinal: 0,
    status: 'done',
    tokens: { inputTokens: 12, outputTokens: 34 },
    output: { text: '翻译产物全文' },
    inheritedFromRunId: null,
    subflowName: null,
  }

  it('节点名标题 + 提取正文 + tokens 徽章', () => {
    const md = buildDeliverablesTranscript([base])
    expect(md).toContain('## 翻译（a）')
    expect(md).toContain('翻译产物全文')
    expect(md).toContain('↑12 ↓34')
  })

  it('无正文时 JSON 兜底；无产出有占位', () => {
    const json: DeliverableItem = { ...base, output: { foo: 1 } }
    const none: DeliverableItem = { ...base, output: null }
    const md = buildDeliverablesTranscript([json, none])
    expect(md).toContain('"foo": 1')
    expect(md).toContain('（无产出）')
  })

  it('迭代多 ordinal：聚合一个小节、逐项「第 k/n」编号', () => {
    const items: DeliverableItem[] = [0, 1].map((i) => ({
      ...base,
      ordinal: i,
      output: { text: `第${i}项产物` },
    }))
    const md = buildDeliverablesTranscript(items)
    expect(md).toContain('## 翻译（a · 2 项）')
    expect(md).toContain('### 第 1/2 项')
    expect(md).toContain('### 第 2/2 项')
    expect(md).toContain('第0项产物')
    expect(md).toContain('第1项产物')
  })

  it('继承标注与子流程归属以引用行呈现', () => {
    const item: DeliverableItem = {
      ...base,
      status: 'cached',
      inheritedFromRunId: 'abcdef12-3456-4789-abcd-ef0123456789',
      subflowName: '子流程甲',
    }
    const md = buildDeliverablesTranscript([item])
    expect(md).toContain('> 继承自前次运行 abcdef12')
    expect(md).toContain('> 子流程：子流程甲')
  })

  it('label 缺席时退 nodeId；空清单得空串', () => {
    const anon: DeliverableItem = { ...base, nodeLabel: null }
    expect(buildDeliverablesTranscript([anon])).toContain('## a（a）')
    expect(buildDeliverablesTranscript([])).toBe('')
  })
})

/* ── R5 三值裁决（2026-10-08）：verdict 活动行贯通终端视图 ── */

describe('verdict 裁决行（R5 三值裁决，2026-10-08）', () => {
  it('events 通道的 verdict 行映射为终端行（label/detail 全文保真）', () => {
    const section = spanToTerminalSection(
      row({
        nodeId: 'n1',
        nodeLabel: '评审',
        nodeType: 'platformAgent',
        status: 'done',
        output: {
          text: '{"decision":"accept"}',
          events: [
            {
              kind: 'verdict',
              label: '第 1 轮裁决：violations（2 项违规）',
              detail: '- $.decision：期望 ["accept","reject"]，实际 "maybe"',
              at: '2026-10-08T10:00:01Z',
            },
            {
              kind: 'verdict',
              label: '第 2 轮 · 违规修复回喂（会话重建·对话回放）',
              detail: '你上一条输出不符合节点 outputSchema…',
              at: '2026-10-08T10:00:02Z',
            },
            {
              kind: 'verdict',
              label: '第 2 轮裁决：accept（合规收下）',
              at: '2026-10-08T10:00:03Z',
            },
          ],
        },
      }),
    )
    expect(section.lines).toHaveLength(3)
    expect(section.lines.every((l) => l.kind === 'verdict')).toBe(true)
    // 违规明细全文在 detail（保真契约：不截断）
    expect(section.lines[0]!.detail).toContain('$.decision')
    expect(section.lines[1]!.label).toContain('会话重建')
    expect(section.lines[2]!.label).toContain('accept')
  })

  it('activity 环降级路同样放行 verdict（旧运行/早期 running 策展缓存）', () => {
    const section = spanToTerminalSection(
      row({
        nodeId: 'n1',
        output: {
          activity: [
            {
              kind: 'verdict',
              label: '第 2 轮裁决：accept（合规收下）',
              summary: '',
              at: '2026-10-08T10:00:03Z',
            },
          ],
        },
      }),
    )
    expect(section.lineSource).toBe('activity')
    expect(section.lines[0]).toMatchObject({
      kind: 'verdict',
      label: '第 2 轮裁决：accept（合规收下）',
    })
  })

  it('直播路：verdict 帧保持专有 kind（不降级 log），at 取服务端时间戳', () => {
    const b = createLiveSectionBuilder()
    b.push({ type: 'nodeStart', nodeId: 'n1', nodeName: '评审', nodeType: 'platformAgent' })
    b.push({
      type: 'delta',
      nodeId: 'n1',
      nodeName: '评审',
      delta: { type: 'activity', kind: 'verdict', label: '第 1 轮裁决：violations（1 项违规）' },
      at: '2026-10-08T10:00:01Z',
    })
    const [section] = b.sections()
    expect(section!.lines).toHaveLength(1)
    expect(section!.lines[0]).toMatchObject({
      kind: 'verdict',
      label: '第 1 轮裁决：violations（1 项违规）',
      at: '2026-10-08T10:00:01Z',
    })
  })

  it('sectionTranscript 含 verdict 行文本（复制实录不丢裁决审计）', () => {
    const transcript = sectionTranscript({
      id: 'n1',
      title: '评审',
      status: 'done',
      tokensBadge: null,
      command: '$ agent',
      lines: [
        {
          kind: 'verdict',
          label: '第 1 轮裁决：violations（2 项违规）',
          detail: '- $.decision：期望 …',
        },
      ],
      output: '',
      rawJson: '',
      lineSource: 'events',
      error: null,
      hasText: false,
    })
    expect(transcript).toContain('第 1 轮裁决：violations（2 项违规）')
    expect(transcript).toContain('- $.decision：期望 …')
  })
})
