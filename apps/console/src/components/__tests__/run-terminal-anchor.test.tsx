import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RunTerminal } from '@/components/run-terminal'
import { spanToTerminalSection } from '@/lib/run-terminal-format'
import { normalizeRunNodeSpan } from '@/lib/node-spans'

/**
 * R6 渐进产物 · 终端锚点属性（design-artifacts.md §④-6，AC-R6-5 载体）：
 * SectionView 根元素带 `data-terminal-section={section.id}`（section id =
 * nodeId）——聚合区行内「终端」入口靠它 scrollIntoView 到目标段。纯属性
 * 零行为变化，chat 面（assistant-content 共用 RunTerminal）无感；本测试
 * 钉住属性存在且取 nodeId 值，防止后续重构悄悄丢锚点。
 */

describe('RunTerminal 段锚点（data-terminal-section）', () => {
  it('每个节点段根元素带 data-terminal-section={nodeId}', () => {
    const sections = [
      spanToTerminalSection(
        normalizeRunNodeSpan({
          nodeId: 'n1',
          nodeLabel: '翻译',
          status: 'done',
          output: { text: 'a' },
        }),
      ),
      spanToTerminalSection(
        normalizeRunNodeSpan({ nodeId: 'n2', nodeLabel: '审校', status: 'failed', error: 'boom' }),
      ),
    ]
    const { container } = render(<RunTerminal sections={sections} running={false} />)
    expect(container.querySelector('[data-terminal-section="n1"]')).not.toBeNull()
    expect(container.querySelector('[data-terminal-section="n2"]')).not.toBeNull()
    // 锚点段就是 section 根（段头/正文都在锚点子树内——scrollIntoView 落段首）
    const anchored = container.querySelector('[data-terminal-section="n1"]') as HTMLElement
    expect(anchored.className).toContain('rtl-section')
    expect(anchored.textContent).toContain('翻译')
  })

  it('live builder 产出的段同键（id = nodeId，两路数据源同锚）', async () => {
    const { createLiveSectionBuilder } = await import('@/lib/run-terminal-format')
    const builder = createLiveSectionBuilder()
    builder.push({
      type: 'nodeStart',
      nodeId: 'live1',
      nodeName: '直播段',
      nodeType: 'llmAgentflow',
      at: '2026-10-08T00:00:00Z',
    })
    const { container } = render(<RunTerminal sections={builder.sections()} running={false} />)
    expect(container.querySelector('[data-terminal-section="live1"]')).not.toBeNull()
  })
})
