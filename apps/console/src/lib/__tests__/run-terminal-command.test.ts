import { describe, expect, it } from 'vitest'
import { spanToTerminalSection } from '../run-terminal-format'
import type { RunNodeSpan } from '../node-spans'

/** `$` 提示行归一（2026-09-22 单源修复的钉子）：
 *  span.node_type 三种存量形态都要映射到同一语义提示 ——
 *  1. 引擎注册名（'llmAgentflow'，gateway resolveNodeType 单源后的新数据）
 *  2. 旧类型名（'llm'，直存类型的 flow / AI 生成形）
 *  3. 画布渲染类型（'customNode'，旧 run 的 node_type 列）—— 兜底原样
 *  事故背景：gateway 曾直接写画布类型，画布保存的 flow 恒为 'customNode'，
 *  终端三段全是 "$ customNode"，用户读不出每段在跑什么。 */
const spanOf = (nodeType: string | null, input?: RunNodeSpan['input'], nodeLabel?: string | null): RunNodeSpan =>
  ({
    nodeId: 'n1',
    nodeLabel: nodeLabel === undefined ? '节点一' : nodeLabel,
    nodeType,
    status: 'done',
    startedAt: '2026-09-22T00:00:00Z',
    finishedAt: null,
    durationMs: 1200,
    tokens: null,
    input: input ?? null,
    output: null,
    error: null,
  }) as unknown as RunNodeSpan

describe('终端 $ 提示行（commandOf 归一）', () => {
  it('引擎注册名：去 Agentflow 后缀映射语义名', () => {
    expect(spanToTerminalSection(spanOf('llmAgentflow', { model: 'claude' } as RunNodeSpan['input'])).command)
      .toBe('$ llm · claude')
    expect(spanToTerminalSection(spanOf('humanInputAgentflow')).command).toBe('$ input')
    expect(spanToTerminalSection(spanOf('startAgentflow')).command).toBe('$ start')
    expect(spanToTerminalSection(spanOf('platformAgentAgentflow')).command).toBe('$ agent')
  })

  it('旧类型名：直接映射', () => {
    expect(spanToTerminalSection(spanOf('llm')).command).toBe('$ llm')
    expect(spanToTerminalSection(spanOf('directReply')).command).toBe('$ reply')
    expect(spanToTerminalSection(spanOf('customFunction')).command).toBe('$ fn')
  })

  it('画布渲染类型与其他未知值：兜底用节点名（label），无 label 才退类型名', () => {
    // 旧 run 存量 node_type='customNode' + nodeLabel —— 用 label 保区分度
    expect(spanToTerminalSection(spanOf('customNode')).command).toBe('$ 节点一')
    expect(spanToTerminalSection(spanOf(null)).command).toBe('$ 节点一')
    // 连 label 都没有的极端形状才退到类型名/占位
    expect(spanToTerminalSection(spanOf('customNode', undefined, null)).command).toBe('$ customNode')
    expect(spanToTerminalSection(spanOf(null, undefined, null)).command).toBe('$ node')
  })
})
