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
