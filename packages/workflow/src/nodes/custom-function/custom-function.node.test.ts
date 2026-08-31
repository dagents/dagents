import { describe, it, expect } from 'vitest'
import { CustomFunctionNode } from './custom-function.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(code: string, input: unknown = {}): INodeData {
  return {
    id: 'n1',
    name: 'customFunctionAgentflow',
    inputs: { functionCode: code, functionInput: input },
  }
}

function makeContext(state: Record<string, unknown> = {}): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state, isLastNode: false }
}

describe('CustomFunctionNode', () => {
  it('executes a simple function and returns its output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { doubled: $input.value * 2 }'
    const result = await node.run(makeNodeData(code, { value: 21 }), '', makeContext())
    expect(result.output.doubled).toBe(42)
  })

  it('can read from $flow.state', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { greeting: "Hello " + $flow.state.name }'
    const result = await node.run(makeNodeData(code), '', makeContext({ name: 'World' }))
    expect(result.output.greeting).toBe('Hello World')
  })

  // FR-11（PRD）：$inputText = 对象入参的正文解包 —— 用户函数里
  // String($input) 得 "[object Object]" 的实测踩坑修复。
  it('exposes $inputText as the unwrapped content of an object $input', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { viaText: $inputText, naive: String($input) }'
    const result = await node.run(makeNodeData(code, { content: '上游正文' }), '', makeContext())
    expect(result.output.viaText).toBe('上游正文')
    expect(result.output.naive).toBe('[object Object]')
  })

  it('$inputText prefers content over text and JSON-stringifies shapeless objects', async () => {
    const node = new CustomFunctionNode()
    const a = await node.run(makeNodeData('return { t: $inputText }', { text: 'T', content: 'C' }), '', makeContext())
    expect(a.output.t).toBe('C')
    const b = await node.run(makeNodeData('return { t: $inputText }', { matched: 'true' }), '', makeContext())
    expect(b.output.t).toBe('{"matched":"true"}')
    const c = await node.run(makeNodeData('return { t: $inputText }', '裸字符串'), '', makeContext())
    expect(c.output.t).toBe('裸字符串')
  })

  it('returns the raw return value wrapped in output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return "plain string"'
    const result = await node.run(makeNodeData(code), '', makeContext())
    expect(result.output).toEqual({ value: 'plain string' })
  })

  it('throws on syntax error', async () => {
    const node = new CustomFunctionNode()
    const code = 'this is not valid javascript'
    await expect(node.run(makeNodeData(code), '', makeContext())).rejects.toThrow()
  })

  it('returns { value: undefined } when function has no return', async () => {
    const node = new CustomFunctionNode()
    const code = 'const x = 1'
    const result = await node.run(makeNodeData(code), '', makeContext())
    // No return → result is undefined, wrapped as { value: undefined }
    expect(result.output).toEqual({ value: undefined })
  })

  it('has correct static metadata', () => {
    const node = new CustomFunctionNode()
    expect(node.name).toBe('customFunctionAgentflow')
    expect(node.type).toBe('CustomFunction')
    expect(node.inputs).toHaveLength(2)
  })
})
