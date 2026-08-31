import { describe, it, expect } from 'vitest'
import { resolveVariables } from '../utils/variables.js'

describe('resolveVariables', () => {
  it('returns non-string values unchanged', () => {
    expect(resolveVariables(42, {})).toBe(42)
    expect(resolveVariables({ a: 1 }, {})).toEqual({ a: 1 })
    expect(resolveVariables(null, {})).toBeNull()
  })

  it('returns string with no variables unchanged', () => {
    expect(resolveVariables('hello world', {})).toBe('hello world')
  })

  it('resolves {{key}} from state', () => {
    expect(resolveVariables('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice')
  })

  it('resolves multiple variables in one string', () => {
    expect(resolveVariables('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Bob' })).toBe('Hi, Bob!')
  })

  it('resolves dotted paths {{node.output.field}}', () => {
    const state = {
      directReplyAgentflow: { output: { content: 'resolved text' } },
    }
    expect(resolveVariables('{{directReplyAgentflow.output.content}}', state)).toBe('resolved text')
  })

  it('leaves variable as-is when not found in state', () => {
    expect(resolveVariables('Hello {{missing}}', {})).toBe('Hello {{missing}}')
  })

  it('resolves $start.question shorthand', () => {
    const state = { start: { question: 'what is 2+2?' } }
    expect(resolveVariables('Q: {{$start.question}}', state)).toBe('Q: what is 2+2?')
  })

  it('resolves $webhook.body.field shorthand', () => {
    const state = { webhook: { body: { user: 'alice' } } }
    expect(resolveVariables('user={{$webhook.body.user}}', state)).toBe('user=alice')
  })
})

describe('resolveVariables (node outputs + $flow scope)', () => {
  it('resolves {{nodeId}} to the node output as JSON', () => {
    const state = { cf1: { content: 'hi', output: { content: 'hi' } } }
    expect(resolveVariables('{{cf1}}', state)).toBe('{"content":"hi","output":{"content":"hi"}}')
  })

  it('resolves {{nodeId.field}} and {{nodeId.output.field}}', () => {
    const state = { cf1: { content: 'hi', output: { content: 'hi' } } }
    expect(resolveVariables('x={{cf1.content}} y={{cf1.output.content}}', state)).toBe('x=hi y=hi')
  })

  it('resolves $flow.chatId from the run metadata scope', () => {
    const state = { flow: { chatId: 'c-42', sessionId: 's-1' } }
    expect(resolveVariables('chat={{$flow.chatId}}', state)).toBe('chat=c-42')
  })

  it('resolves $flow.state.<key> onto the flat runtime state', () => {
    const state = { flow: { chatId: 'c' }, done: true }
    expect(resolveVariables('{{$flow.state.done}}', state)).toBe('true')
  })

  it('resolves $iteration to the current iteration item', () => {
    const state = { iteration: { name: 'ada' }, iterationItem: { name: 'ada' } }
    expect(resolveVariables('item={{$iteration.name}}', state)).toBe('item=ada')
  })
})

// ── 文档语法兼容别名（PRD FR-02 / 决议 D2）─────────────────────────────
// 运行面板教学文案宣称 `{{$start.input}}` 与 `{{<节点id>.output}}`，但引擎
// 真实形状是 start.content / {text,content} —— 别名层修复之。实测复现：
// run f68b83dd（字面量送达 LLM「变量未解析」）vs d9064c5d（{{input}} 正常）。
describe('resolveVariables (documented-syntax aliases)', () => {
  const state = {
    start: { variables: {}, content: '线上数据库紧急告警' },
    llm1: { text: '关键词A, 关键词B', content: '关键词A, 关键词B' },
    cond: { matched: 'true' },
  }

  it('{{$start.input}} → start 节点的 content（运行输入）', () => {
    expect(resolveVariables('建议：{{$start.input}}', state)).toBe('建议：线上数据库紧急告警')
  })

  it('{{start.input}}（无 $ 前缀）同样命中别名', () => {
    expect(resolveVariables('{{start.input}}', state)).toBe('线上数据库紧急告警')
  })

  it('{{<id>.output}} → 输出正文（text ?? content）', () => {
    expect(resolveVariables('造句：{{llm1.output}}', state)).toBe('造句：关键词A, 关键词B')
  })

  it('无 text/content 的输出（如 Condition）回落整对象 JSON —— matched 可达', () => {
    expect(resolveVariables('{{cond.output}}', state)).toBe('{"matched":"true"}')
  })

  it('executor 自引用形态（{...out, output: out}）的 {{id.output}} 同样解包正文', () => {
    // executor 实际注入 state 的形状（executor.ts runtime.merge 处）
    const out = { text: '正文A', content: '正文A' }
    const s = { llm1: { ...out, output: out } }
    expect(resolveVariables('{{llm1.output}}', s)).toBe('正文A')
  })

  it('嵌套显式路径 {{id.output.field}} 不受解包影响', () => {
    const s = { cf1: { content: 'hi', output: { content: 'hi', meta: 'm' } } }
    expect(resolveVariables('{{cf1.output.meta}}', s)).toBe('m')
    expect(resolveVariables('{{cf1.output.content}}', s)).toBe('hi')
  })

  it('显式字段优先于别名：未知形状不经别名误解析', () => {
    const s = { sub: { output: { result: 'r1' }, result: 'r2' } }
    // output 无 text/content → 整对象 JSON（显式命中，不走别名兜底）
    expect(resolveVariables('{{sub.output}}', s)).toBe('{"result":"r1"}')
  })

  it('未知节点/路径仍保留字面量（不因别名而误解析）', () => {
    expect(resolveVariables('{{ghost.output}}', state)).toBe('{{ghost.output}}')
    expect(resolveVariables('{{$start.input}}', {})).toBe('{{$start.input}}')
  })

  it('别名与显式路径混用时互不干扰', () => {
    expect(
      resolveVariables('{{llm1.output}} + {{llm1.content}} + {{missing.x}}', state),
    ).toBe('关键词A, 关键词B + 关键词A, 关键词B + {{missing.x}}')
  })
})
