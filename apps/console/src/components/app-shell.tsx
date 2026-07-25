'use client'

/**
 * App shell (M5a.1, P1.10.T1).
 *
 * Client component wrapping the sidebar + topbar + main grid from
 * design/css/shell.css (`.app`, `.app-sidebar`, `.app-topbar`, `.app-main`).
 * It owns the interactive shell state the design's `app.js` owned:
 *   - sidebar collapse (persisted to localStorage, key `od:sidebar`)
 *   - mobile nav drawer (`data-mobile-nav`)
 *   - ⌘K focus on the topbar search
 *
 * `nav.ts` drives the sidebar links; `usePathname` marks the active one via
 * `aria-current="page"` so the `.nav-link[aria-current]` styles apply. The
 * shell renders children (the route's page) inside `.app-main > .page`.
 */

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { NAV, crumbsFor } from './nav'
import { Icon } from './icon'
import { useSession } from '@/lib/auth-client'

const COLLAPSE_KEY = 'od:sidebar'

function isActive(pathname: string, href: string): boolean {
  // The launcher root is its own route now (M6.1) — no sidebar link points
  // at `/`, so a bare `/` never highlights a nav item (the brand mark links
  // home instead). Every other link is exact-or-prefix.
  if (href === '/') return false
  return pathname === href || pathname.startsWith(href + '/')
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { user, logout } = useSession()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Hydrate the persisted collapse preference once on mount. Reading during
  // SSR would mismatch (server has no localStorage), so the initial state is
  // the default and we sync after mount.
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'open')
      return next
    })
  }, [])

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  // Close the account menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // ⌘K / Ctrl+K focuses the global search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const input = document.querySelector<HTMLInputElement>('.topbar-search input')
        input?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Close the account menu on an outside click / Escape so it doesn't linger.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return
      if (!document.querySelector('.account-menu-wrap')?.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const onLogout = useCallback(async () => {
    setMenuOpen(false)
    await logout()
    // The SessionProvider flips to `unauthed`; the gate's redirect sends the
    // browser to /login. Push explicitly so the back button doesn't return
    // into the authed shell.
    router.replace('/login')
  }, [logout, router])

  return (
    <div
      className="app"
      id="app"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-nav={mobileNavOpen ? 'open' : 'closed'}
    >
      <aside className="app-sidebar">
        <Link
          href="/"
          className="brand"
          aria-label="返回概览"
          title="返回概览"
        >
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">DAgent</div>
            <div className="brand-sub">控制台 · v0.2</div>
          </div>
        </Link>
        <nav className="nav" aria-label="主导航">
          {NAV.map((group) => (
            <div key={group.section}>
              <div className="nav-section-head">
                <div className="nav-section-label">{group.section}</div>
                {/* 协作 section gets a 「新增 Task」 plus button linking to
                    /tasks/new (design app.js:69-76 renders this in the
                    sidebar's Workspace section head). The plus button sits in
                    the section head beside the label, matching the design's
                    `nav-section-head` placement. */}
                {group.section === '协作' ? (
                  <Link
                    href="/tasks/new"
                    className={`nav-add-task${isActive(pathname, '/tasks/new') ? ' is-active' : ''}`}
                    aria-label="新增 Task"
                    title="新增 Task"
                  >
                    <Icon name="plus" />
                  </Link>
                ) : null}
              </div>
              {group.items.map((it) => (
                <Link
                  key={it.id}
                  href={it.href}
                  className="nav-link"
                  aria-current={isActive(pathname, it.href) ? 'page' : undefined}
                >
                  <Icon name={it.icon} className="nav-icon" />
                  <span className="nav-label">{it.label}</span>
                  {it.badge ? <span className="nav-badge">{it.badge}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="collapse-btn"
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={toggleCollapsed}
          >
            <Icon
              name="collapse"
              style={{ transform: collapsed ? 'rotate(180deg)' : '', transition: 'transform var(--motion-fast)' }}
            />
            <span>{collapsed ? '展开' : '折叠'}</span>
          </button>
        </div>
      </aside>

      <header className="app-topbar">
        <button
          type="button"
          className="icon-btn mobile-menu-btn"
          aria-label="菜单"
          onClick={() => setMobileNavOpen((v) => !v)}
        >
          <Icon name="menu" />
        </button>
        <div className="crumbs">
          {crumbsFor(pathname).map((seg, i, arr) => {
            const isLast = i === arr.length - 1
            const node =
              seg.href && !isLast ? <Link href={seg.href}>{seg.label}</Link> : <>{seg.label}</>
            return (
              <span key={i}>
                {i > 0 && <span className="sep">/</span>}
                {isLast ? (
                  <span className="crumb-current">{node}</span>
                ) : (
                  <span className="crumb">{node}</span>
                )}
              </span>
            )
          })}
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-search">
          <Icon name="search" className="search-icon" />
          <input type="search" placeholder="搜索 agents / flows / runs…" aria-label="全局搜索" />
          <kbd>⌘K</kbd>
        </div>
        <div className="topbar-actions">
          <button type="button" className="icon-btn" aria-label="通知">
            <Icon name="bell" />
            <span className="dot" />
          </button>
          {/* M5b.4: account menu — shows the SSO user's initials when authed
              (falls back to the design's placeholder) and exposes the logout
              action wired through the session context. */}
          <div className="account-menu-wrap">
            <button
              type="button"
              className="avatar"
              aria-label="账户"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={user?.name}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {user ? user.name.slice(0, 2).toUpperCase() : 'RZ'}
            </button>
            {menuOpen ? (
              <div className="account-menu" role="menu">
                <div className="account-menu-name">{user?.name ?? '未登录'}</div>
                <button type="button" role="menuitem" className="account-menu-item" onClick={onLogout}>
                  登出
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="app-main">{children}</main>
    </div>
  )
}
