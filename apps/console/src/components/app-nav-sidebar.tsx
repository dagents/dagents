'use client'

/**
 * AppNavSidebar — Workflow-First IA 的主导航（PRD F2，docs/prd-workflow-first.md）。
 *
 * 取代 ChatNavSidebar（目录→会话树）成为工作流主场的信息架构：
 *   工作流 / 运行历史 / 智能体 / 技能 / 守护进程 + 底部「最近对话」
 *   折叠区（默认收起，D3 决议）——旧会话经 FAB 抽屉与本折叠区保持可达。
 *   （模板不占导航位：入口在工作流工具栏「从模板创建」，2026-08-29 用户裁决）
 *
 * DOM 类名沿用 chat-nav-* 体系（chat-layout.css），仅新增 nav 段样式
 * （app-nav.css）——双主题 token 自动生效。
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@/components/icon'
import { LocaleToggle } from '@/components/locale-toggle'
import { ThemeToggle } from '@/components/theme-toggle'
import { fetchChats, CHAT_STATUS_LABEL, type Chat } from '@/lib/chats'
import { fetchDirectories } from '@/lib/directories'
import { truncateTitle } from '@/lib/format'
import { useI18n } from '@/i18n'
import '@/styles/app-nav.css'

const RECENT_KEY = 'dagents.sidebar.recentChats'

type IconName = React.ComponentProps<typeof Icon>['name']

interface NavItem {
  href: string
  label: string
  icon: IconName
  /** 精确匹配（`/` 会前缀误判所有路由）。 */
  exact?: boolean
}

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact || href === '/') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppNavSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const { t } = useI18n()

  const navItems: NavItem[] = [
    { href: '/', label: t('工作流'), icon: 'flows', exact: true },
    { href: '/runs', label: t('运行历史'), icon: 'terminal' },
    { href: '/agents', label: t('智能体'), icon: 'agents' },
    { href: '/skills', label: t('技能'), icon: 'zap' },
    { href: '/daemons', label: t('守护进程'), icon: 'daemons' },
  ]

  return (
    <div className="chat-nav-sidebar">
      {/* Brand row — 与 ChatNavSidebar 同几何（60px 行、rail 折叠态）。 */}
      <div className={`chat-nav-brand${collapsed ? ' collapsed' : ''}`}>
        {collapsed ? (
          <button
            type="button"
            className="chat-nav-brand-rail"
            onClick={onToggle}
            aria-label={t('展开侧栏')}
            title={t('展开侧栏')}
          >
            <span className="chat-nav-brand-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
                <circle cx="18" cy="6" r="2.5" />
                <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
                <path d="M7.5 7.5 L10.5 16" />
                <path d="M16.5 7.5 L13.5 16" />
                <path d="M8.5 6 L15.5 6" />
              </svg>
            </span>
            <span className="chat-nav-brand-expand-icon" aria-hidden="true">
              <Icon name="panelLeft" style={{ width: 16, height: 16 }} />
            </span>
          </button>
        ) : (
          <>
            <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
              <span className="chat-nav-brand-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                  <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
                  <circle cx="18" cy="6" r="2.5" />
                  <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
                  <path d="M7.5 7.5 L10.5 16" />
                  <path d="M16.5 7.5 L13.5 16" />
                  <path d="M8.5 6 L15.5 6" />
                </svg>
              </span>
              <span className="chat-nav-brand-name">Dagents</span>
            </Link>
            <button
              type="button"
              className="chat-nav-collapse-btn"
              onClick={onToggle}
              aria-label={t('折叠侧栏')}
              title={t('折叠侧栏')}
            >
              <Icon name="panelLeft" style={{ width: 15, height: 15 }} />
            </button>
          </>
        )}
      </div>

      {/* 主导航 */}
      <nav className="app-nav-section" aria-label={t('主导航')}>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`app-nav-item${isActive(pathname, item.href, item.exact) ? ' active' : ''}`}
            aria-current={isActive(pathname, item.href, item.exact) ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
          >
            <Icon name={item.icon} className="nav-icon" style={{ width: 16, height: 16 }} />
            {!collapsed ? <span className="app-nav-item-label">{item.label}</span> : null}
          </Link>
        ))}
      </nav>

      <RecentChats collapsed={collapsed} />

      <div className="chat-nav-footer">
        <Link
          href="/settings"
          className="chat-nav-settings-btn"
          aria-label={t('设置')}
          title={t('设置')}
          aria-current={isActive(pathname, '/settings') ? 'page' : undefined}
        >
          <Icon name="settings" className="nav-icon" style={{ width: 15, height: 15 }} />
        </Link>
        <LocaleToggle className="chat-nav-locale-btn" />
        <ThemeToggle />
      </div>
    </div>
  )
}

/** 底部「最近对话」折叠区 —— 旧会话可达性保底（默认收起，D3）。 */
function RecentChats({ collapsed }: { collapsed: boolean }): React.ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [chats, setChats] = useState<Chat[]>([])

  useEffect(() => {
    setOpen(localStorage.getItem(RECENT_KEY) === 'open')
  }, [])

  // 收起态不拉数据；展开时取各目录第一页合并取最近 5 条（目录数小，N 次
  // 请求可接受；跨目录「最近会话」聚合接口留待后端演进）。
  useEffect(() => {
    if (!open || collapsed) return
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        const pages = await Promise.all(
          dirs.map((d) => fetchChats(d.id).catch(() => [] as Chat[])),
        )
        if (cancelled) return
        const merged = pages
          .flat()
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, 5)
        setChats(merged)
      } catch {
        // 静默 —— 折叠区是可达性保底，失败不阻塞导航
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, collapsed])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      localStorage.setItem(RECENT_KEY, next ? 'open' : 'closed')
      return next
    })
  }, [])

  if (collapsed) return null

  return (
    <div className="app-nav-recent">
      <button type="button" className="app-nav-recent-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name="chat" className="nav-icon" style={{ width: 14, height: 14 }} />
        <span>{t('最近对话')}</span>
        <span className={`app-nav-chev${open ? ' open' : ''}`} aria-hidden>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="app-nav-recent-list" role="list">
          {chats.length === 0 ? (
            <span className="app-nav-recent-empty">{t('暂无最近对话')}</span>
          ) : (
            chats.map((c) => (
              <Link
                key={c.id}
                href={`/chats/${c.id}`}
                className="app-nav-recent-item"
                title={c.title}
              >
                <span className={`status-dot ${c.status === 'running' ? 'dot-running' : 'dot-done'}`} />
                <span className="app-nav-recent-title">{truncateTitle(c.title, 16)}</span>
                <span className="app-nav-recent-status">{t(CHAT_STATUS_LABEL[c.status] ?? c.status)}</span>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
