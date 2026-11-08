/**
 * RunTerminal 的 cached 段渲染（AC-R2-2 分句「终端视图不出现假 CLI 提示行」
 * 的断言面，2026-10-08 修复验收）：cached 段的提示行改显「⚡ 来自缓存」
 * （黄系）——不冒充真实 CLI 进程（`$ llm · model` 是假提示行）；对照：
 * 真实执行段照常渲染 `$` 提示行。默认 i18n zh-CN（t(key)=key）。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RunTerminal } from '@/components/run-terminal'
import type { TerminalSection } from '@/lib/run-terminal-format'

function section(status: string, overrides: Partial<TerminalSection> = {}): TerminalSection {
  return {
    id: `n-${status}`,
    title: `节点 ${status}`,
    status,
    durationMs: status === 'cached' ? 0 : 1200,
    tokensBadge: null,
    nodeType: 'llmAgentflow',
    command: '$ llm · some-model',
    lines: [],
    lineSource: 'events',
    output: '正文',
    rawJson: '',
    error: null,
    hasText: true,
    ...overrides,
  }
}

describe('AC-R2-2：cached 段不渲染假 CLI 提示行（改显「来自缓存」）', () => {
  it('cached 段：无 $ 提示行、显示「⚡ 来自缓存」；真实段照常 $ command', () => {
    render(
      <RunTerminal
        sections={[section('cached'), section('done')]}
        running={false}
      />,
    )
    // cached 段：来自缓存标注在（默认 zh 词典 t=key）
    expect(screen.getByText(/⚡ 来自缓存/)).toBeTruthy()
    // 真实执行段的 $ 提示行照常（对照——不该被全局去掉）
    expect(screen.getByText('$ llm · some-model')).toBeTruthy()
    // 假提示行计数恰 1（只有 done 段；cached 段不再产出）
    expect(screen.getAllByText('$ llm · some-model')).toHaveLength(1)
  })
})
