/**
 * AssistantContent markdown renderer contract tests (PX-C03/C04).
 *
 *   §1 Nested lists render as real nested <ul>/<ol> (one level of <ul> per
 *      indentation step) — the CSS indents each level by --space-6.
 *   §2 GFM pipe tables render inside the horizontal-scroll shell
 *      (.prose-table-shell > .prose-table-wrap > table).
 *   §3 Blockquote stays a <blockquote> (styled with the violet 2px left
 *      line + warm surface in assistant-content.css).
 *   §4 Code fences render via CodeBlock with the language banner.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssistantContent } from '@/components/assistant-content'

describe('AssistantContent — markdown renderer (PX-C03)', () => {
  it('§1: nested bullet lists render as nested <ul> levels', () => {
    render(
      <AssistantContent
        content={'- 一级\n  - 二级\n    - 三级\n- 又一个一级'}
      />,
    )
    const root = document.querySelector('.assistant-content')
    const topUl = root?.querySelector('ul')
    expect(topUl).not.toBeNull()
    // 一级 has a nested 二级 ul, which itself has a nested 三级 ul.
    const level2 = topUl?.querySelector('li > ul')
    const level3 = level2?.querySelector('li > ul')
    expect(level2).not.toBeNull()
    expect(level3).not.toBeNull()
    expect(screen.getByText('三级')).toBeInTheDocument()
  })

  it('§1b: numbered lists render as <ol>, mixing with bullets', () => {
    render(<AssistantContent content={'1. first\n2. second\n- bullet'} />)
    expect(document.querySelector('.assistant-content ol')).not.toBeNull()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('§2: GFM pipe tables render inside the scroll shell', () => {
    render(
      <AssistantContent
        content={'| 节点 | 状态 |\n| --- | --- |\n| 规划 | 完成 |\n| 执行 | 进行中 |'}
      />,
    )
    const shell = document.querySelector('.prose-table-shell')
    expect(shell).not.toBeNull()
    const table = shell?.querySelector('.prose-table-wrap table')
    expect(table).not.toBeNull()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    // Header cells are <th>, body cells <td>.
    expect(table?.querySelectorAll('th')).toHaveLength(2)
    expect(table?.querySelectorAll('tbody td')).toHaveLength(4)
  })

  it('§3: blockquotes render as <blockquote>', () => {
    render(<AssistantContent content={'> 引用内容'} />)
    expect(document.querySelector('.assistant-content blockquote')).not.toBeNull()
    expect(screen.getByText('引用内容')).toBeInTheDocument()
  })

  it('§4: code fences render CodeBlock with the language banner', () => {
    render(<AssistantContent content={'```ts\nconst x = 1\n```'} />)
    expect(document.querySelector('.code-block')).not.toBeNull()
    expect(screen.getByText('ts')).toBeInTheDocument()
  })
})
