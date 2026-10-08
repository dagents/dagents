import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeliverableItem } from '@dagents/contracts'
import type { RunNodeSpan } from '@/lib/node-spans'
import {
  DeliverablesCard,
  groupDeliverables,
  sumTokensBadge,
} from '@/components/canvas/canvas-results-panel'

/**
 * R6 渐进产物 · 聚合区组件与纯逻辑测试（design-artifacts.md §④/§⑥）。
 *
 * 覆盖上一批（2026-10-08 实现）只由 e2e 兜底的 UI 层逻辑：
 *  - groupDeliverables：服务端按实例键序（node_id, ordinal）返回 → console
 *    拓扑序重排（拓扑知识天然在画布侧）、迭代多 ordinal 聚合一行、未知
 *    节点垫底、label 回退 nodeId；
 *  - sumTokensBadge：多 ordinal 项用量合并；
 *  - DeliverablesCard 渲染：单行预览/继承 chip/子流程 chip/未完成显式标注
 *    （未执行 ≠ 失败——failed span 不进灰行）/迭代「第 k/n 项」/复制回执/
 *    终端锚点回调；
 *  - runState/awaiting 联动：挂起节点标「等待输入」。
 *
 * useI18n 有 context 默认值（zh-CN，t() 直回中文键）——无需 Provider。
 */

/** DeliverableItem 桩工厂。 */
function item(over: Partial<DeliverableItem> & { nodeId: string }): DeliverableItem {
  return {
    nodeLabel: null,
    nodeType: 'llmAgentflow',
    ordinal: 0,
    status: 'done',
    tokens: null,
    output: null,
    inheritedFromRunId: null,
    subflowName: null,
    ...over,
  }
}

/** 最小 RunNodeSpan 桩（聚合卡只读 nodeId/status）。 */
function spanOf(nodeId: string, status: string): RunNodeSpan {
  return {
    nodeId,
    nodeLabel: null,
    nodeType: null,
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

describe('groupDeliverables（纯逻辑：实例键序 → 拓扑序）', () => {
  // 拓扑：start(0) → a(1) → b(2) → iterBody(3)；'unknown-node' 不在图里
  const topo = new Map([
    ['start', 0],
    ['a', 1],
    ['b', 2],
    ['iterBody', 3],
  ])

  it('服务端 node_id 字典序 ≠ 拓扑序时按 topoOrder 重排，未知节点垫底', () => {
    // 服务端 ORDER BY node_id：b < iterBody < start < a(单字符)…构造乱序输入
    const ids = groupDeliverables(
      [item({ nodeId: 'b' }), item({ nodeId: 'unknown-node' }), item({ nodeId: 'start' })],
      topo,
    ).map((g) => g.nodeId)
    expect(ids).toEqual(['start', 'b', 'unknown-node'])
  })

  it('迭代多 ordinal 聚合一组、组内按 ordinal 升序（与返回序无关）', () => {
    const groups = groupDeliverables(
      [
        item({ nodeId: 'iterBody', ordinal: 2, output: { text: '第2项' } }),
        item({ nodeId: 'iterBody', ordinal: 0, output: { text: '第0项' } }),
        item({ nodeId: 'iterBody', ordinal: 1, output: { text: '第1项' } }),
      ],
      topo,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items.map((i) => i.ordinal)).toEqual([0, 1, 2])
  })

  it('label 取组内首个非空 nodeLabel；全空回退 nodeId；空输入得空数组', () => {
    const groups = groupDeliverables(
      [
        item({ nodeId: 'a', nodeLabel: null, output: { text: 'x' } }),
        item({ nodeId: 'a', nodeLabel: '翻译', output: { text: 'y' } }),
        item({ nodeId: 'b', nodeLabel: null }),
      ],
      topo,
    )
    expect(groups.find((g) => g.nodeId === 'a')!.label).toBe('翻译')
    expect(groups.find((g) => g.nodeId === 'b')!.label).toBe('b')
    expect(groupDeliverables([], topo)).toEqual([])
  })
})

describe('sumTokensBadge（纯逻辑：组内用量合并）', () => {
  it('多 ordinal 项 inputTokens/outputTokens 求和成单一徽章', () => {
    const badge = sumTokensBadge([
      item({ nodeId: 'x', tokens: { inputTokens: 10, outputTokens: 20 } }),
      item({ nodeId: 'x', ordinal: 1, tokens: { inputTokens: 1, outputTokens: 2 } }),
    ])
    expect(badge).toBe('↑11 ↓22')
  })

  it('非对象 / 缺字段的 tokens 忽略；全无量返回 null', () => {
    expect(
      sumTokensBadge([
        item({ nodeId: 'x', tokens: null }),
        item({ nodeId: 'x', ordinal: 1, tokens: 'weird' }),
      ]),
    ).toBeNull()
    expect(sumTokensBadge([])).toBeNull()
    // 只有 outputTokens 也成徽章（input 缺省按 0 呈现）
    expect(sumTokensBadge([item({ nodeId: 'x', tokens: { outputTokens: 5 } })])).toBe('↑0 ↓5')
  })
})

describe('DeliverablesCard（渲染）', () => {
  const jumpSpy = vi.fn()

  function renderCard(over: {
    deliverables?: DeliverableItem[]
    flowNodes?: Array<{ id: string; label: string }>
    spans?: RunNodeSpan[]
    runState?: 'idle' | 'running' | 'done' | 'failed' | 'awaiting'
    awaitingNodeId?: string | null
  }) {
    return render(
      <DeliverablesCard
        runId="9ca52a4b-e365-49e6-89a7-9fcc08743c64"
        deliverables={over.deliverables ?? []}
        flowNodes={over.flowNodes ?? []}
        spans={over.spans ?? []}
        topoOrder={
          new Map([
            ['start', 0],
            ['a', 1],
            ['iter', 2],
            ['hi', 3],
            ['dead', 4],
          ])
        }
        runState={over.runState ?? 'failed'}
        awaitingInfo={
          over.awaitingNodeId
            ? { nodeId: over.awaitingNodeId, prompt: '确认方案', inputType: 'text', options: [] }
            : null
        }
        onJumpToTerminal={jumpSpy}
      />,
    )
  }

  it('产出行：节点名 + text 单行预览 + tokens 徽章；「终端」入口回调带 nodeId', async () => {
    const user = userEvent.setup()
    renderCard({
      deliverables: [
        item({
          nodeId: 'a',
          nodeLabel: '翻译',
          output: { text: 'LLM 产出的多行\n正文第二行' },
          tokens: { inputTokens: 12, outputTokens: 34 },
        }),
      ],
      flowNodes: [{ id: 'a', label: '翻译' }],
    })
    expect(screen.getByTitle('a')).toHaveTextContent('翻译')
    // 单行预览：多行正文压平为一行（oneLine）
    expect(screen.getByTitle('a').closest('summary')).toHaveTextContent('LLM 产出的多行 正文第二行')
    expect(screen.getByText('↑12 ↓34')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '终端' }))
    expect(jumpSpy).toHaveBeenCalledWith('a')
  })

  it('迭代组：一行聚合 + 展开「第 k/n 项」逐项编号与正文', () => {
    renderCard({
      deliverables: [
        item({ nodeId: 'iter', ordinal: 0, output: { text: '项零产出' } }),
        item({ nodeId: 'iter', ordinal: 1, output: { text: '项一产出' } }),
      ],
      flowNodes: [{ id: 'iter', label: '遍历' }],
    })
    const row = screen.getByTitle('iter').closest('details') as HTMLElement
    expect(row).not.toBeNull()
    // 行头携带项数提示；展开后逐项编号（k 是组内序位，非 ordinal 原值）
    expect(within(row).getByText('2 项')).toBeInTheDocument()
    expect(within(row).getAllByText(/第 [12]\/2 项/)).toHaveLength(2)
    expect(within(row).getByText(/项零产出/)).toBeInTheDocument()
    expect(within(row).getByText(/项一产出/)).toBeInTheDocument()
  })

  it('继承与子流程归属 chip（AC-R6-3 展示侧 / AC-R6-5 归属标注）', () => {
    renderCard({
      deliverables: [
        item({
          nodeId: 'a',
          nodeLabel: '种子节点',
          status: 'cached',
          inheritedFromRunId: '11111111-2222-4333-8444-555555555555',
        }),
        item({ nodeId: 'iter', nodeLabel: '子图节点', subflowName: '子流程甲' }),
      ],
      flowNodes: [
        { id: 'a', label: '种子节点' },
        { id: 'iter', label: '子图节点' },
      ],
    })
    expect(screen.getByText(/继承自前次运行 11111111/)).toBeInTheDocument()
    expect(screen.getByText('子流程 · 子流程甲')).toBeInTheDocument()
  })

  it('未完成显式标注（≠失败）：未执行灰行 / running 执行中 / 挂起等待输入；failed 节点不进灰行', () => {
    renderCard({
      deliverables: [item({ nodeId: 'start', output: { text: '入口产出' } })],
      flowNodes: [
        { id: 'start', label: '开始' },
        { id: 'a', label: '没跑到的节点' },
        { id: 'iter', label: '正在跑的节点' },
        { id: 'hi', label: '挂起节点' },
        { id: 'dead', label: '失败节点' },
      ],
      spans: [
        spanOf('iter', 'running'),
        spanOf('dead', 'failed'), // 执行过且失败 → 不标「未执行」
      ],
      runState: 'awaiting',
      awaitingNodeId: 'hi',
    })
    const card = screen.getByText('产出清单').closest('details') as HTMLElement
    expect(within(card).getByText('未执行')).toBeInTheDocument()
    expect(within(card).getAllByText('执行中')).toHaveLength(1)
    expect(within(card).getAllByText('等待输入')).toHaveLength(1)
    // 失败节点既不在清单也不在灰行（失败态由逐节点行呈现）
    expect(within(card).queryByText('失败节点')).not.toBeInTheDocument()
    expect(within(card).queryByText('没跑到的节点')).toBeInTheDocument()
  })

  it('零产出 + 有未跑节点：清单计数隐藏、复制/下载禁用', () => {
    renderCard({
      deliverables: [],
      flowNodes: [{ id: 'a', label: '节点' }],
    })
    expect(screen.getByText('产出清单')).toBeInTheDocument()
    expect(screen.queryByText(/项产出/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制产出清单' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载产出' })).toBeDisabled()
  })

  it('零产出且零未完成 → 整卡不渲染', () => {
    const { container } = renderCard({ deliverables: [], flowNodes: [] })
    expect(container.querySelector('.canvas-deliverables-card')).toBeNull()
  })

  describe('复制回执（clipboard 桩）', () => {
    const writeText = vi.fn(async () => {})
    beforeEach(() => {
      // jsdom 的 navigator.clipboard 是 getter-only——defineProperty 覆写
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      writeText.mockClear()
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('复制成功 → 剪贴板收 transcript + 「已复制」回执', async () => {
      // 不用 userEvent：其 setup() 会自装 clipboard stub 覆写本用例的桩
      renderCard({
        deliverables: [item({ nodeId: 'a', nodeLabel: '翻译', output: { text: '正文' } })],
        flowNodes: [{ id: 'a', label: '翻译' }],
      })
      fireEvent.click(screen.getByRole('button', { name: '复制产出清单' }))
      expect(writeText).toHaveBeenCalledTimes(1)
      // transcript 内容来自 buildDeliverablesTranscript（其内容另有 lib 单测钉）
      expect(String(writeText.mock.calls[0])).toContain('翻译')
      expect(await screen.findByText(/已复制/)).toBeInTheDocument()
    })
  })
})
