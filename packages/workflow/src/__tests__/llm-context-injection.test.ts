import { describe, it, expect, beforeEach } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import { StartNode } from '../nodes/start/start.node.js'
import { LLMNode } from '../nodes/llm/llm.node.js'
import type { IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

/**
 * P1b/P2a 注入语义：LLM 节点收「摘要块 + 近期原文块 + flow 上下文块 +
 * 节点 system」，各块独立成 system 消息且顺序稳定；contextBudget 对账
 * 挂进输出（span 可查）。
 */

function makeCaptureClient() {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const client = {
    chat: async (params: { messages: Array<{ role: string; content: string }> }) => {
      calls.push({ messages: params.messages })
      return { text: '回复正文', usage: { total_tokens: 3 } }
    },
  }
  return { calls, client }
}

const node = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'customNode',
  position: { x: 0, y: 0 },
  data: { name, label: id, ...extra },
})

describe('LLM 节点上下文注入（P1b 两级历史 + P2a flow 上下文）', () => {
  let registry: NodeRegistry
  let cap: ReturnType<typeof makeCaptureClient>
  beforeEach(() => {
    registry = new NodeRegistry()
    registry.register(new StartNode())
    registry.register(new LLMNode())
    cap = makeCaptureClient()
  })

  const flow = (extra: Record<string, unknown>): FlowData => ({
    nodes: [
      node('s', 'startAgentflow'),
      node('l', 'llmAgentflow', { model: 'm', prompt: '做事', ...extra }),
    ],
    edges: [{ id: 'e1', source: 's', target: 'l' }],
  })

  it('摘要块 + 原文块 + flow 上下文块 + 节点 system 依次注入', async () => {
    const result = await new DagExecutor(registry).execute(
      flow({ includeChatHistory: 5 }),
      '上游产出',
      {
        chatId: 'c',
        runId: 'r',
        state: {},
        isLastNode: true,
        llmClient: cap.client as unknown as IExecutionContext['llmClient'],
        flowContext: 'FLOW-CTX-BODY',
        historyRetriever: async () => ({
          summary: '早期会话的滚动摘要',
          messages: [{ role: 'user', content: '近期原文' }],
        }),
      },
    )
    expect(result.status).toBe('success')
    const msgs = cap.calls[0]!.messages
    const contents = msgs.map((m) => m.content)
    expect(contents.some((c) => c.includes('早期会话的滚动摘要'))).toBe(true)
    expect(contents.some((c) => c.includes('近期原文'))).toBe(true)
    expect(contents.some((c) => c.includes('【流程上下文】') && c.includes('FLOW-CTX-BODY'))).toBe(
      true,
    )
    // 顺序：摘要块最先，flow 上下文 + system 随后，user 最后
    const summaryIdx = contents.findIndex((c) => c.includes('滚动摘要'))
    const flowIdx = contents.findIndex((c) => c.includes('FLOW-CTX-BODY'))
    const userIdx = contents.findIndex((c) => c.includes('做事'))
    expect(summaryIdx).toBeLessThan(flowIdx)
    expect(flowIdx).toBeLessThan(userIdx)
    // user 正文带上游输入
    expect(cap.calls[0]!.messages[msgs.length - 1]!.content).toContain('上游产出')
    // 对账账目在输出上
    const out = result.finalOutput as Record<string, unknown>
    expect((out.contextBudget as { inputChars: number }).inputChars).toBeGreaterThan(0)
  })

  it('检索器契约：无摘要时只注原文块', async () => {
    await new DagExecutor(registry).execute(flow({ includeChatHistory: 3 }), 'in', {
      chatId: 'c',
      runId: 'r',
      state: {},
      isLastNode: true,
      llmClient: cap.client as unknown as IExecutionContext['llmClient'],
      historyRetriever: async () => ({
        summary: null,
        messages: [{ role: 'user', content: '原文' }],
      }),
    })
    const contents = cap.calls[0]!.messages.map((m) => m.content)
    expect(contents.some((c) => c.includes('原文'))).toBe(true)
    expect(contents.some((c) => c.includes('先前上下文摘要'))).toBe(false)
  })

  it('contextCap 生效：上游输入被裁且对账留痕', async () => {
    const big = 'X'.repeat(5000)
    const result = await new DagExecutor(registry).execute(flow({ contextCap: 300 }), big, {
      chatId: 'c',
      runId: 'r',
      state: {},
      isLastNode: true,
      llmClient: cap.client as unknown as IExecutionContext['llmClient'],
    })
    expect(result.status).toBe('success')
    const out = result.finalOutput as { contextBudget: { capChars: number; inputChars: number } }
    expect(out.contextBudget.capChars).toBe(300)
    expect(out.contextBudget.inputChars).toBeLessThan(big.length)
    const userMsg = cap.calls[0]!.messages[cap.calls[0]!.messages.length - 1]!.content
    expect(userMsg).toContain('截断')
  })
})
