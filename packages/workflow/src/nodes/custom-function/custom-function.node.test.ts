import { describe, it, expect, vi } from 'vitest'
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
    const a = await node.run(
      makeNodeData('return { t: $inputText }', { text: 'T', content: 'C' }),
      '',
      makeContext(),
    )
    expect(a.output.t).toBe('C')
    const b = await node.run(
      makeNodeData('return { t: $inputText }', { matched: 'true' }),
      '',
      makeContext(),
    )
    expect(b.output.t).toBe('{"matched":"true"}')
    const c = await node.run(
      makeNodeData('return { t: $inputText }', '裸字符串'),
      '',
      makeContext(),
    )
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

  // ── R4 受控命令通道 · 节点层（2026-10-08 测试补齐，AC-R4-2 节点面）─────
  // worker RPC 与白名单裁决的底层行为在 user-code-exec.test.ts；这里钉
  // 节点层的四件事：$exec 缺席翻译、invalid 全拒、活动行、未列命令。

  it('无 allowedCommands 调 $exec → TypeError 翻译成结构化指引（带节点 id 与「命令白名单」指引）', async () => {
    const node = new CustomFunctionNode()
    await expect(
      node.run(makeNodeData('return $exec("git", []).then(() => 1)'), '', makeContext()),
    ).rejects.toThrow(
      /customFunction 节点 n1：\$exec 不可用——本节点未声明 allowedCommands；在节点配置「命令白名单」声明后方可调用命令/,
    )
  })

  it('invalid allowedCommands → 节点 fail-closed 全拒（合法代码也不跑）', async () => {
    const node = new CustomFunctionNode()
    await expect(
      node.run(
        {
          id: 'n1',
          name: 'customFunctionAgentflow',
          inputs: { functionCode: 'return 1', allowedCommands: 'oops' },
        },
        '',
        makeContext(),
      ),
    ).rejects.toThrow(
      /allowedCommands 声明非法（应为字符串数组.*）——修复格式；修复前 \$exec 全部被拒/s,
    )
  })

  it('declared + execRunner 注入 → 结果回流且 onNodeDelta 收到 tool/tool_result 两行活动', async () => {
    const deltas: Array<{ type: string; kind: string; label: string }> = []
    const ctx = makeContext()
    ctx.onNodeDelta = (chunk) =>
      deltas.push({
        type: chunk.type,
        kind: (chunk as { kind: string }).kind,
        label: (chunk as { label: string }).label,
      })
    ctx.execRunner = async (req) => {
      // 二次复核面：节点把声明白名单原样带给宿主（纵深防御契约）
      expect(req.allowedCommands).toEqual(['git'])
      return { code: 0, stdout: 'M file.ts', stderr: '', truncated: false }
    }
    const node = new CustomFunctionNode()
    const result = await node.run(
      {
        id: 'n1',
        name: 'customFunctionAgentflow',
        inputs: {
          functionCode:
            'return $exec("git", ["status"]).then((r) => ({ code: r.code, out: r.stdout }))',
          allowedCommands: ['git'],
        },
      },
      '',
      ctx,
    )
    expect(result.output).toEqual({ code: 0, out: 'M file.ts' })
    expect(deltas).toEqual([
      { type: 'activity', kind: 'tool', label: 'git' },
      { type: 'activity', kind: 'tool_result', label: 'git' },
    ])
    // tool_result detail 保全文（采集层契约）：argv JSON + stdout + 退出码
  })

  it('declared + 未列命令 → 节点失败且错误带「已声明」清单（RPC 裁决路径经节点层）', async () => {
    const execRunner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', truncated: false }))
    const ctx = makeContext()
    ctx.execRunner = execRunner
    const node = new CustomFunctionNode()
    await expect(
      node.run(
        {
          id: 'n1',
          name: 'customFunctionAgentflow',
          inputs: {
            functionCode: 'return $exec("sh", ["-c", "echo pwned"]).then((r) => r.stdout)',
            allowedCommands: ['git'],
          },
        },
        '',
        ctx,
      ),
    ).rejects.toThrow(/sh 未在 allowedCommands 声明（已声明：git）/)
    expect(execRunner).not.toHaveBeenCalled()
  })

  it('has correct static metadata', () => {
    const node = new CustomFunctionNode()
    expect(node.name).toBe('customFunctionAgentflow')
    expect(node.type).toBe('CustomFunction')
    // 3 = functionCode / functionInput / allowedCommands（R4 命令白名单输入）
    expect(node.inputs.map((i) => i.name)).toEqual([
      'functionCode',
      'functionInput',
      'allowedCommands',
    ])
  })
})
