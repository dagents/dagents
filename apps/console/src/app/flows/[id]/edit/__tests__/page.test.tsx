/**
 * FlowEditorFrame + edit page tests (M2.3, audit §1.5).
 *
 * 验收（issue 描述）：iframe src 含 `/canvas/<id>`；`?external=1` 渲染
 * 「在新标签打开」降级态。这里覆盖纯函数 `flowiseCanvasUrl`（src 拼接 +
 * FLOWISE_EDITOR_URL 覆盖 + 尾斜杠归一）与组件渲染（iframe title/src、
 * external 降级 `<a target="_blank">`），再渲染 async 路由 page 验证端到端
 * src 含 `/canvas/<id>`。
 *
 * 不启动 Next / 不打网络：`flowiseEditorUrl()` 读 `process.env.FLOWISE_EDITOR_URL`
 * （M0.3），测试里直接改 env 并在 afterEach 还原，与 config.test.ts 同款。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FlowEditorFrame, flowiseCanvasUrl } from '@/components/flow-editor-frame'
import EditFlowPage from '@/app/flows/[id]/edit/page'

describe('flowiseCanvasUrl', () => {
  const orig = process.env.FLOWISE_EDITOR_URL

  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWISE_EDITOR_URL
    else process.env.FLOWISE_EDITOR_URL = orig
  })

  it('builds <base>/canvas/<id> from the default :3100 base', () => {
    delete process.env.FLOWISE_EDITOR_URL
    const url = flowiseCanvasUrl('abc-123')
    expect(url).toBe('http://localhost:3100/canvas/abc-123')
    // 验收：src 含 /canvas/<id>
    expect(url).toContain('/canvas/abc-123')
  })

  it('reads FLOWISE_EDITOR_URL override', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://flowise.local:3101'
    expect(flowiseCanvasUrl('f-9')).toBe('http://flowise.local:3101/canvas/f-9')
  })

  it('strips a trailing slash on the base before appending /canvas/', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://localhost:3100/'
    expect(flowiseCanvasUrl('x')).toBe('http://localhost:3100/canvas/x')
  })

  it('preserves a base path when the env includes one', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://localhost:3100/flowise/'
    expect(flowiseCanvasUrl('x')).toBe('http://localhost:3100/flowise/canvas/x')
  })
})

describe('FlowEditorFrame', () => {
  const orig = process.env.FLOWISE_EDITOR_URL

  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWISE_EDITOR_URL
    else process.env.FLOWISE_EDITOR_URL = orig
  })

  it('renders an iframe whose src contains /canvas/<id> with an accessible title', () => {
    delete process.env.FLOWISE_EDITOR_URL
    render(<FlowEditorFrame chatflowId="flow-xyz" />)

    const frame = screen.getByTitle('Flowise 画布编辑器')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('http://localhost:3100/canvas/flow-xyz')
    expect(frame.getAttribute('src')).toContain('/canvas/flow-xyz')
  })

  it('does not render the iframe in external fallback mode', () => {
    delete process.env.FLOWISE_EDITOR_URL
    render(<FlowEditorFrame chatflowId="flow-xyz" external />)

    expect(screen.queryByTitle('Flowise 画布编辑器')).toBeNull()
  })

  it('renders a new-tab link pointing at /canvas/<id> in external fallback mode', () => {
    delete process.env.FLOWISE_EDITOR_URL
    render(<FlowEditorFrame chatflowId="flow-xyz" external />)

    const link = screen.getByRole('link', { name: /打开 Flowise 画布/ })
    expect(link.getAttribute('href')).toBe('http://localhost:3100/canvas/flow-xyz')
    expect(link.getAttribute('href')).toContain('/canvas/flow-xyz')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('EditFlowPage (/flows/[id]/edit)', () => {
  const orig = process.env.FLOWISE_EDITOR_URL

  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWISE_EDITOR_URL
    else process.env.FLOWISE_EDITOR_URL = orig
  })

  it('renders the embedded iframe with src containing /canvas/<id> (default embed)', async () => {
    delete process.env.FLOWISE_EDITOR_URL
    const tree = await EditFlowPage({
      params: Promise.resolve({ id: 'flow-xyz' }),
      searchParams: Promise.resolve({}),
    })
    render(tree)

    const frame = screen.getByTitle('Flowise 画布编辑器')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toContain('/canvas/flow-xyz')
  })

  it('renders the new-tab fallback (no iframe) when ?external=1', async () => {
    delete process.env.FLOWISE_EDITOR_URL
    const tree = await EditFlowPage({
      params: Promise.resolve({ id: 'flow-xyz' }),
      searchParams: Promise.resolve({ external: '1' }),
    })
    render(tree)

    expect(screen.queryByTitle('Flowise 画布编辑器')).toBeNull()
    const link = screen.getByRole('link', { name: /打开 Flowise 画布/ })
    expect(link.getAttribute('href')).toContain('/canvas/flow-xyz')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('respects FLOWISE_EDITOR_URL override in the rendered iframe src', async () => {
    process.env.FLOWISE_EDITOR_URL = 'http://flowise.local:3101'
    const tree = await EditFlowPage({
      params: Promise.resolve({ id: 'f-9' }),
      searchParams: Promise.resolve({}),
    })
    render(tree)

    const frame = screen.getByTitle('Flowise 画布编辑器')
    expect(frame.getAttribute('src')).toBe('http://flowise.local:3101/canvas/f-9')
  })
})
