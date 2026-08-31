/**
 * Template parameterization (方案 G) — pure-function coverage: `{{var}}`
 * scanning on extract and substitution on instantiate. Scope is deliberately
 * narrow (prompt/reply text fields only) so canvas structure fields are never
 * touched.
 */
import { describe, it, expect } from 'vitest'
import { scanTemplateParams, applyTemplateParams } from '../flow-template-pipeline.js'

const flowWith = (dataList: Record<string, unknown>[]) => ({
  nodes: dataList.map((data, i) => ({ id: `n${i}`, type: 'customNode', data })),
  edges: [],
})

describe('scanTemplateParams', () => {
  it('collects {{var}} from flat and nested prompt fields, dedup + order', () => {
    const params = scanTemplateParams(
      flowWith([
        { name: 'llmAgentflow', systemPrompt: '审查 {{language}} 代码，关注{{ focus }}' },
        { name: 'platformAgentAgentflow', inputs: { systemPrompt: '输出用 {{language}}' } },
        { name: 'directReplyAgentflow', content: '完成 {{task}} 与 {{task}}' },
      ]),
    )
    expect(params.map((p) => p.name)).toEqual(['language', 'focus', 'task'])
  })

  it('accepts CJK variable names and ignores engine-style refs', () => {
    const params = scanTemplateParams(
      flowWith([{ name: 'llmAgentflow', systemPrompt: '{{项目名}} 与 {{n1.output.field}}' }]),
    )
    // `{{n1.output.field}}` — dotted paths don't match the identifier pattern
    expect(params.map((p) => p.name)).toEqual(['项目名'])
  })

  it('does not scan structural fields (label/model/position)', () => {
    const params = scanTemplateParams(
      flowWith([{ name: 'llmAgentflow', label: '{{oops}}', model: '{{m}}' }]),
    )
    expect(params).toEqual([])
  })

  // ── 引擎保留字（PRD FR-02 / 决议 D3）───────────────────────────────
  // 单词型 flat-state 键若被收进模板参数，实例化时会被 answers 静默替换，
  // 运行输入从此到不了节点（{{input}} 双重身份坑）。带 $/./路 径的写法
  // 正则天然不匹配，此处钉住单词型保留字。
  it('excludes engine runtime variables from params (input / question / ...)', () => {
    const params = scanTemplateParams(
      flowWith([
        { name: 'llmAgentflow', systemPrompt: '复读 {{input}}，历史 {{chat_history}}，时间 {{current_date_time}}' },
        { name: 'directReplyAgentflow', content: '{{question}} {{loop_count}} {{file_attachment}} {{runtime_messages_length}}' },
      ]),
    )
    expect(params).toEqual([])
  })

  it('still collects genuine params alongside reserved words', () => {
    const params = scanTemplateParams(
      flowWith([{ name: 'llmAgentflow', systemPrompt: '为 {{项目名}} 复读 {{input}}' }]),
    )
    expect(params.map((p) => p.name)).toEqual(['项目名'])
  })
})

describe('applyTemplateParams', () => {
  const params = [
    { name: 'language', defaultValue: 'TypeScript' },
    { name: 'task' },
  ]

  it('substitutes answers, falls back to defaultValue, then empty string', () => {
    const flow = flowWith([
      { name: 'llmAgentflow', systemPrompt: '审查 {{language}} 代码' },
      { name: 'platformAgentAgentflow', inputs: { systemPrompt: '执行 {{task}}' } },
    ])
    const out = applyTemplateParams(flow, params, { task: '重构' })
    expect((out.nodes[0]!.data as { systemPrompt: string }).systemPrompt).toBe('审查 TypeScript 代码')
    expect(((out.nodes[1]!.data as { inputs: { systemPrompt: string } }).inputs).systemPrompt).toBe('执行 重构')
  })

  it('empty answer without default resolves to empty string (no dangling placeholder)', () => {
    const flow = flowWith([{ name: 'llmAgentflow', systemPrompt: '做 {{task}}' }])
    const out = applyTemplateParams(flow, params, {})
    expect((out.nodes[0]!.data as { systemPrompt: string }).systemPrompt).toBe('做 ')
  })

  it('leaves unknown placeholders untouched', () => {
    const flow = flowWith([{ name: 'llmAgentflow', systemPrompt: '保持 {{unknown_ref}}' }])
    const out = applyTemplateParams(flow, params, {})
    expect((out.nodes[0]!.data as { systemPrompt: string }).systemPrompt).toBe('保持 {{unknown_ref}}')
  })
})
