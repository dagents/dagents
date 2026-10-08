import { describe, it, expect } from 'vitest'
import {
  DELIVERABLE_STATUSES,
  extractDeliverableText,
  type DeliverableItem,
} from '../run-deliverables.js'

/**
 * extractDeliverableText 语义钉子（design-artifacts.md §⑥ contracts 行）。
 *
 * 这是「搬家回归」测试：实现自 console run-terminal-format.ts 的
 * extractOutputText 原样上移——本文件钉住既有语义（text/content 直出 +
 * DirectReply 字符串化 JSON 二次解包 + 各 null 形状），任何行为漂移在
 * 这里第一时间暴露（AC-R6-4「同一提取单源」的结构前提）。
 */
describe('extractDeliverableText（上移搬家回归钉子）', () => {
  it('text 直出', () => {
    expect(extractDeliverableText({ text: 'hello' })).toBe('hello')
  })

  it('content 兜底直出（无 text 时）', () => {
    expect(extractDeliverableText({ content: 'via content' })).toBe('via content')
    expect(extractDeliverableText({ text: '', content: 'fallback' })).toBe('fallback')
  })

  it('text 优先于 content（两者都在场）', () => {
    expect(extractDeliverableText({ text: 'primary', content: 'secondary' })).toBe('primary')
  })

  it('字符串载荷原样直出；空串归 null', () => {
    expect(extractDeliverableText('plain string')).toBe('plain string')
    expect(extractDeliverableText('')).toBeNull()
  })

  it('DirectReply 的字符串化 JSON 二次解包（{text} / {content}）', () => {
    expect(extractDeliverableText({ text: '{"text":"inner text"}' })).toBe('inner text')
    expect(extractDeliverableText({ text: '{"content":"inner content"}' })).toBe('inner content')
  })

  it('字符串化 JSON 但无 text/content 键 → 保持原样（不吞不造）', () => {
    expect(extractDeliverableText({ text: '{"foo":1}' })).toBe('{"foo":1}')
  })

  it('非 JSON 的 { 开头文本（解析失败）→ 保持原样', () => {
    expect(extractDeliverableText({ text: '{ not json' })).toBe('{ not json')
  })

  it('无正文的对象 → null；null/undefined 载荷 → null', () => {
    expect(extractDeliverableText({ foo: 'bar' })).toBeNull()
    expect(extractDeliverableText(null)).toBeNull()
    expect(extractDeliverableText(undefined)).toBeNull()
  })

  it('whitespace 后 { 才触发二次解包（trimStart 语义）', () => {
    expect(extractDeliverableText({ text: '  \n {"text":"indented"}' })).toBe('indented')
  })
})

describe('DELIVERABLE_STATUSES 词表', () => {
  it('deliverable 词表 = done + cached（cached 前置已随可恢复性地基落地）', () => {
    expect([...DELIVERABLE_STATUSES]).toEqual(['done', 'cached'])
  })

  it('失败/在途/未知词不在词表（不入清单）', () => {
    for (const st of ['failed', 'running', 'paused', 'unknown', 'cancelled']) {
      expect(DELIVERABLE_STATUSES.includes(st)).toBe(false)
    }
  })
})

describe('DeliverableItem 形状（编译期契约）', () => {
  it('九字段齐全（nodeId/label/type/ordinal/status/tokens/output/lineage/subflow）', () => {
    const item: DeliverableItem = {
      nodeId: 'n1',
      nodeLabel: '翻译',
      nodeType: 'llmAgentflow',
      ordinal: 0,
      status: 'done',
      tokens: { inputTokens: 10, outputTokens: 5 },
      output: { text: 'hi' },
      inheritedFromRunId: null,
      subflowName: null,
    }
    expect(item.nodeId).toBe('n1')
    expect(item.ordinal).toBe(0)
  })
})
