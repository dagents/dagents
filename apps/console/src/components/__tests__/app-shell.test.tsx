/**
 * AppShell interactions (M1.1).
 *
 * Aligns the shell chrome with design/js/app.js: sidebar collapse (persisted
 * to `od:sidebar`), mobile drawer (`data-mobile-nav`), ⌘K search focus, avatar
 * menu, and — the actual M1.1 delta — per-route breadcrumbs matching each
 * design screen's `.crumbs` trail (e.g. agents → `编排 / Agents`, agent detail
 * → `编排 / Agents / 详情`).
 *
 * Mocks: `next/navigation` (usePathname/useRouter) and `@/lib/auth-client`
 * (useSession) so the client component renders under jsdom without the Next
 * app-router or a live `/api/auth/session`. `next/link` is stubbed to a plain
 * `<a>` so nav links render without a router context.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { AppShell } from '@/components/app-shell'

const state = vi.hoisted(() => ({
  pathname: '/',
  router: { replace: vi.fn(), push: vi.fn() },
  session: {
    user: null as { sub: string; name: string } | null,
    status: 'unauthed' as 'loading' | 'authed' | 'unauthed' | 'error',
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => state.router,
}))

vi.mock('@/lib/auth-client', () => ({
  useSession: () => state.session,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

function renderShell(pathname = '/') {
  state.pathname = pathname
  return render(
    <AppShell>
      <div>page</div>
    </AppShell>,
  )
}

function crumbs(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.crumbs')
  if (!el) throw new Error('.crumbs not rendered')
  return el as HTMLElement
}

describe('AppShell — sidebar collapse (od:sidebar persistence)', () => {
  beforeEach(() => {
    localStorage.clear()
    state.session.user = null
    state.session.status = 'unauthed'
    state.router.replace.mockClear()
  })

  it('defaults to expanded and toggles to collapsed, persisting od:sidebar', async () => {
    const { container } = renderShell('/')
    const app = container.querySelector('.app')!
    expect(app.getAttribute('data-collapsed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '折叠侧栏' }))

    await waitFor(() => {
      expect(app.getAttribute('data-collapsed')).toBe('true')
    })
    expect(localStorage.getItem('od:sidebar')).toBe('collapsed')

    fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }))
    await waitFor(() => {
      expect(app.getAttribute('data-collapsed')).toBe('false')
    })
    expect(localStorage.getItem('od:sidebar')).toBe('open')
  })

  it('hydrates the collapsed state from od:sidebar on mount', () => {
    localStorage.setItem('od:sidebar', 'collapsed')
    const { container } = renderShell('/')
    const app = container.querySelector('.app')!
    expect(app.getAttribute('data-collapsed')).toBe('true')
  })
})

describe('AppShell — mobile drawer (data-mobile-nav)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('toggles data-mobile-nav between open and closed', () => {
    const { container } = renderShell('/')
    const app = container.querySelector('.app')!
    expect(app.getAttribute('data-mobile-nav')).toBe('closed')

    fireEvent.click(screen.getByRole('button', { name: '菜单' }))
    expect(app.getAttribute('data-mobile-nav')).toBe('open')

    fireEvent.click(screen.getByRole('button', { name: '菜单' }))
    expect(app.getAttribute('data-mobile-nav')).toBe('closed')
  })
})

describe('AppShell — ⌘K focuses the topbar search', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('focuses the global search on Cmd/Ctrl+K', () => {
    renderShell('/')
    const input = screen.getByLabelText('全局搜索')
    expect(input).not.toHaveFocus()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })

    expect(input).toHaveFocus()
  })
})

describe('AppShell — avatar menu', () => {
  beforeEach(() => {
    localStorage.clear()
    state.session.user = null
    state.session.status = 'unauthed'
    state.router.replace.mockClear()
    state.session.logout.mockClear()
  })

  it('opens the account menu and logs out', async () => {
    renderShell('/')
    fireEvent.click(screen.getByRole('button', { name: '账户' }))

    const logoutItem = await screen.findByRole('menuitem', { name: '登出' })
    fireEvent.click(logoutItem)

    await waitFor(() => expect(state.session.logout).toHaveBeenCalled())
    expect(state.router.replace).toHaveBeenCalledWith('/login')
  })
})

describe('AppShell — breadcrumbs per route (design app.js crumbs)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows 运维 / 资源看板 on /dashboard', () => {
    const { container } = renderShell('/dashboard')
    const c = crumbs(container)
    expect(within(c).getByText('运维')).toBeInTheDocument()
    expect(within(c).getByText('资源看板')).toBeInTheDocument()
  })

  it('shows 编排 / Agents on /agents', () => {
    const { container } = renderShell('/agents')
    const c = crumbs(container)
    expect(within(c).getByText('编排')).toBeInTheDocument()
    expect(within(c).getByText('Agents')).toBeInTheDocument()
  })

  it('shows 编排 / Agents / 详情 on /agents/:id (detail trail)', () => {
    const { container } = renderShell('/agents/agent_01HFK')
    const c = crumbs(container)
    expect(within(c).getByText('编排')).toBeInTheDocument()
    expect(within(c).getByText('详情')).toBeInTheDocument()
    // middle Agents crumb is a link back to /agents (design agent-detail.html)
    const link = c.querySelector('a[href="/agents"]')
    expect(link).not.toBeNull()
    expect(link!.textContent).toBe('Agents')
  })

  it('shows 编排 / AgentFlows on /flows', () => {
    const { container } = renderShell('/flows')
    const c = crumbs(container)
    expect(within(c).getByText('编排')).toBeInTheDocument()
    expect(within(c).getByText('AgentFlows')).toBeInTheDocument()
  })

  it('shows 编排 / Lab on /lab', () => {
    const { container } = renderShell('/lab')
    const c = crumbs(container)
    expect(within(c).getByText('编排')).toBeInTheDocument()
    expect(within(c).getByText('Lab')).toBeInTheDocument()
  })

  it('shows 协作 / Workspace on /workspace', () => {
    const { container } = renderShell('/workspace')
    const c = crumbs(container)
    expect(within(c).getByText('协作')).toBeInTheDocument()
    expect(within(c).getByText('Workspace')).toBeInTheDocument()
  })

  it('shows 系统 / 设置 on /settings', () => {
    const { container } = renderShell('/settings')
    const c = crumbs(container)
    expect(within(c).getByText('系统')).toBeInTheDocument()
    expect(within(c).getByText('设置')).toBeInTheDocument()
  })

  it('shows 概览 on the launcher root / (M6.1 launcher)', () => {
    const { container } = renderShell('/')
    const c = crumbs(container)
    expect(within(c).getByText('概览')).toBeInTheDocument()
  })

  it('shows 编排 / 对话 on /chat (M6.1 — chat moved off the root)', () => {
    const { container } = renderShell('/chat')
    const c = crumbs(container)
    expect(within(c).getByText('编排')).toBeInTheDocument()
    expect(within(c).getByText('对话')).toBeInTheDocument()
  })
})
