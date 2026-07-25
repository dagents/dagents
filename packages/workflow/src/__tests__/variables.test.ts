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
