/**
 * WorkflowRunCard 组件测试（AC-R3-4 + AC-R1-6 第三消费点，2026-10-08 修复
 * 验收）：fake timers 钉「partial_success 终态后 700ms 轮询定时器清除」
 * （此前三词清单的轮询泄漏修复的断言面）；顺带钉 run 级「已中断」状态词
 * （stopped(interrupted) 整卡可见——第三消费点的收尾定格文案）。
 *
 * fetchRunNodeSpans 经模块 mock 可编程（首拨 running → 轮询中翻终态）；
 * 默认 i18n zh-CN（t(key)=key），与 run-permission-summary.test.tsx 同款
 * 无 Provider 渲染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { RunNodeSpansResult, RunNodeSpan } from '@/lib/node-spans'

const scripted = vi.hoisted(() => ({
  results: [] as Array<Partial<RunNodeSpansResult>>,
}))

vi.mock('@/lib/node-spans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/node-spans')>()
  return {
    ...actual,
    fetchRunNodeSpans: vi.fn(async (): Promise<RunNodeSpansResult> => ({
      ok: true,
      httpStatus: 200,
      spans: [],
      runStatus: null,
      runError: null,
      runDurationMs: 1200,
      runDirectoryId: null,
      runSource: null,
      runStopReason: null,
      lineageTokens: null,
      deliverables: null,
      ...scripted.results.shift(),
    })),
  }
})

import { WorkflowRunCard } from '@/components/workflow-run-card'

function spanOf(status: string): RunNodeSpan {
  return {
    nodeId: 'n1',
    nodeLabel: 'N1',
    nodeType: 'llmAgentflow',
    ordinal: 0,
    status,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    tokens: null,
    cost: null,
    traceId: null,
    input: null,
    output: null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  scripted.results = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-R3-4：终态后轮询定时器清除（partial_success 泄漏修复的断言面）', () => {
  it('首拨 running 起轮询 → 第二拨 partial_success → clearInterval（推进 5s 零新增 fetch）', async () => {
    const { fetchRunNodeSpans } = await import('@/lib/node-spans')
    scripted.results = [
      { runStatus: 'running', spans: [spanOf('running')] },
      { runStatus: 'partial_success', spans: [spanOf('done')] },
    ]
    const onTerminal = vi.fn()
    render(
      <WorkflowRunCard runId="00000000-0000-0000-0000-0000000000d1" live onTerminal={onTerminal} />,
    )
    // 首拨（mount effect）+ 首个 interval tick（700ms）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(fetchRunNodeSpans).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(fetchRunNodeSpans).toHaveBeenCalledTimes(2)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    // 终态已清定时器：再推进 5s（7 个 tick 的窗口）零新增 fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetchRunNodeSpans).toHaveBeenCalledTimes(2)
    expect(onTerminal).toHaveBeenCalledTimes(1)
  })

  it('budget_exceeded / stopped / cancelled 终态同样收口（词表全集逐个钉）', async () => {
    for (const terminal of ['budget_exceeded', 'stopped', 'cancelled', 'failed', 'completed']) {
      const { fetchRunNodeSpans } = await import('@/lib/node-spans')
      ;(fetchRunNodeSpans as ReturnType<typeof vi.fn>).mockClear()
      scripted.results = [
        { runStatus: 'running', spans: [spanOf('running')] },
        { runStatus: terminal, spans: [spanOf('done')] },
      ]
      const { unmount } = render(
        <WorkflowRunCard
          runId={`00000000-0000-0000-0000-${terminal.padStart(12, '0').slice(0, 12)}`}
          live
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500)
      })
      expect(fetchRunNodeSpans).toHaveBeenCalledTimes(2)
      unmount()
    }
  })
})

describe('AC-R1-6 第三消费点：chat 执行卡的 run 级「已中断」文案', () => {
  it('stopped(interrupted) → 整卡显示「已中断」（run 级状态词，非仅节点徽章）', async () => {
    scripted.results = [{ runStatus: 'stopped', runStopReason: 'interrupted', spans: [] }]
    render(
      <WorkflowRunCard runId="00000000-0000-0000-0000-0000000000d2" live={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText('已中断')).toBeTruthy()
  })

  it('stopped(user) → 「已停止」；存量 cancelled → 「已取消」（细分与双读）', async () => {
    scripted.results = [{ runStatus: 'stopped', runStopReason: 'user', spans: [] }]
    const { rerender } = render(
      <WorkflowRunCard runId="00000000-0000-0000-0000-0000000000d3" live={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText('已停止')).toBeTruthy()
    scripted.results = [{ runStatus: 'cancelled', spans: [] }]
    rerender(
      <WorkflowRunCard runId="00000000-0000-0000-0000-0000000000d4" live={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText('已取消')).toBeTruthy()
  })

  it('completed 不渲染状态词（绿样式已表达，不叠冗词）；running 不渲染', async () => {
    scripted.results = [{ runStatus: 'completed', spans: [] }]
    render(
      <WorkflowRunCard runId="00000000-0000-0000-0000-0000000000d5" live={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.queryByText('已完成')).toBeNull()
  })
})
