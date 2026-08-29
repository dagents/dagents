/**
 * PlatformAgentNode — 节点级任务指令（systemPrompt）回归。
 *
 * 背景：流程里多个节点常绑同一个 Agent（如 @workflow 生成的
 * 规划/开发/验证链）。没有节点级指令时，节点 label 只是显示文案，
 * 模型完全不知道自己这一步的职责 —— 所以 inputs.systemPrompt 会
 * 追加在 Agent 自身 instructions 之后进入 system prompt。
 */
import { describe, it, expect } from 'vitest'
import { PlatformAgentNode } from './platform-agent.node.js'
import type { IExecutionContext } from '../../types/execution.js'

interface Capture {
  system: string
  user: string
}

function makeContext(capture: Capture): IExecutionContext {
  return {
    state: {},
    agentFetcher: async () => ({
      id: 'agent-1',
      name: 'claude',
      instructions: '你是平台 Agent。',
      model: '',
      kind: 'claude',
      skills: [],
    }),
    llmClient: {
      // Capture what the node actually sends — the whole point of the test.
      chat: async (params: { messages: { role: string; content: string }[] }) => {
        capture.system = params.messages.find((m) => m.role === 'system')?.content ?? ''
        capture.user = params.messages.find((m) => m.role === 'user')?.content ?? ''
        return { text: 'ok' }
      },
    },
  } as unknown as IExecutionContext
}

describe('PlatformAgentNode — 节点级任务指令', () => {
  it('appends the node task after the agent instructions', async () => {
    const capture: Capture = { system: '', user: '' }
    const node = new PlatformAgentNode()
    await node.run(
      {
        id: 'n1',
        name: 'platformAgentAgentflow',
        inputs: {
          agentId: 'agent-1',
          systemPrompt: '你是需求规划角色：根据输入产出结构化 PRD。',
        },
      },
      '用户的原始需求',
      makeContext(capture),
    )
    expect(capture.system).toContain('你是平台 Agent。')
    expect(capture.system).toContain('你是需求规划角色：根据输入产出结构化 PRD。')
    // Agent instructions come first — persona before task.
    expect(capture.system.indexOf('你是平台 Agent。')).toBeLessThan(
      capture.system.indexOf('你是需求规划角色'),
    )
    expect(capture.user).toBe('用户的原始需求')
  })

  it('degrades cleanly when the node carries no task instruction', async () => {
    const capture: Capture = { system: '', user: '' }
    const node = new PlatformAgentNode()
    await node.run(
      {
        id: 'n2',
        name: 'platformAgentAgentflow',
        inputs: { agentId: 'agent-1' },
      },
      '输入',
      makeContext(capture),
    )
    expect(capture.system).toContain('你是平台 Agent。')
    expect(capture.system).not.toContain('需求规划')
  })

  it('throws on an empty final answer instead of returning an empty success', async () => {
    // 空产出守卫（2026-08-27）：真实复跑中 Agent 一轮跑完 0 字正文仍标
    // done —— 与 llm.node 同款诚实失败。
    const ctx = makeContext({ system: '', user: '' })
    ctx.llmClient = {
      chat: async () => ({ text: '' }),
    }
    const node = new PlatformAgentNode()
    await expect(
      node.run(
        {
          id: 'n3',
          name: 'platformAgentAgentflow',
          inputs: { agentId: 'agent-1' },
        },
        '输入',
        ctx,
      ),
    ).rejects.toThrow(/返回空内容/)
  })
})
