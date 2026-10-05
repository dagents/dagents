import { describe, it, expect } from 'vitest'
import { assembleUnderBudget, tailPreservingTruncate } from '../utils/context-budget.js'

/**
 * P1a 上下文总预算分配制语义钉死（docs/context-management-research.md §7）：
 * 牺牲序 = 检索历史（摘要最先丢）→ 上游输入（头尾保真截断）→ 常驻不裁
 * 只如实标记超限。
 */

describe('tailPreservingTruncate', () => {
  it('未超限原样返回', () => {
    expect(tailPreservingTruncate('short', 100, 'X')).toBe('short')
  })
  it('超限保头 60% + 标记 + 保尾 40%', () => {
    const text = 'A'.repeat(600) + 'B'.repeat(400) // 1000 字符
    const out = tailPreservingTruncate(text, 100, '测试')
    expect(out).toContain('[测试截断：全文 1000 字符，上限 100')
    expect(out.startsWith('A'.repeat(60))).toBe(true)
    expect(out.endsWith('B'.repeat(40))).toBe(true)
  })
})

describe('assembleUnderBudget', () => {
  it('预算内全量注入', () => {
    const r = assembleUnderBudget({
      capChars: 10_000,
      systemPrompt: 'SYS',
      prompt: 'P',
      inputText: 'UPSTREAM',
      historyMessages: [
        { role: 'user', content: 'h1' },
        { role: 'assistant', content: 'h2' },
      ],
      historySummary: '早期摘要',
    })
    expect(r.userContent).toBe('P\n\nUPSTREAM')
    expect(r.historyUsed).toHaveLength(2)
    expect(r.summaryUsed).toContain('早期摘要')
    expect(r.accounting.overBudget).toBe(false)
    expect(r.accounting.historyDropped).toBe(0)
  })

  it('历史超剩余预算 → 从排名末尾丢、摘要先丢', () => {
    const r = assembleUnderBudget({
      // SYS(3)+P(1)=4 常驻；剩余 16：rank1 块('[user] rank1'12+2=14)放得下，
      // rank2 块放不下——摘要块(远超)最先丢。
      capChars: 'SYS'.length + 'P'.length + 16,
      systemPrompt: 'SYS',
      prompt: 'P',
      inputText: '',
      historyMessages: [
        { role: 'user', content: 'rank1' }, // 最相关
        { role: 'assistant', content: 'rank2-会被丢' },
      ],
      historySummary: 'SUMMARY-会被最先丢',
    })
    expect(r.summaryUsed).toBeNull()
    expect(r.historyUsed.map((m) => m.content)).toEqual(['[user] rank1'])
    expect(r.accounting.historyDropped).toBe(1)
  })

  it('上游输入超预算 → 头尾保真截断（不整段丢弃）', () => {
    const head = 'H'.repeat(500)
    const tail = 'T'.repeat(500)
    const r = assembleUnderBudget({
      capChars: 100 + 'SYS'.length + 'P'.length,
      systemPrompt: 'SYS',
      prompt: 'P',
      inputText: head + tail,
      historyMessages: [],
    })
    expect(r.accounting.inputChars).toBeLessThan(1000)
    expect(r.userContent).toContain('H')
    expect(r.userContent).toContain('T')
    expect(r.accounting.notes.join(' ')).toContain('上游输入')
  })

  it('常驻块自身超预算 → overBudget 标记，历史与输入不注入', () => {
    const r = assembleUnderBudget({
      capChars: 10,
      systemPrompt: 'S'.repeat(50),
      prompt: 'P'.repeat(50),
      inputText: 'UPSTREAM',
      historyMessages: [{ role: 'user', content: 'h' }],
    })
    expect(r.accounting.overBudget).toBe(true)
    expect(r.accounting.historyIncluded).toBe(0)
    expect(r.accounting.inputChars).toBe(0)
    expect(r.accounting.notes.join(' ')).toContain('常驻块')
  })

  it('flow 上下文进常驻块（不参与牺牲序）', () => {
    const r = assembleUnderBudget({
      capChars: 500,
      systemPrompt: 'S',
      prompt: 'P',
      flowContext: 'FLOW-CTX',
      inputText: 'U',
      historyMessages: [{ role: 'user', content: 'h' }],
    })
    expect(r.flowContextBlock).toContain('【流程上下文】')
    expect(r.flowContextBlock).toContain('FLOW-CTX')
    expect(r.accounting.fixedChars).toBeGreaterThan('FLOW-CTX'.length)
  })
})
