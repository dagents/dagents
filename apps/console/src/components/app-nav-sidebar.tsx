'use client'

/**
 * AppNavSidebar — Workflow-First IA 的主导航（PRD F2，docs/prd-workflow-first.md）。
 *
 * 取代 ChatNavSidebar（目录→会话树）成为工作流主场的信息架构：
 *   工作流 / 智能体 / 技能 / 守护进程 主导航 + 会话历史树。
 *   模板不占导航位（入口在工作流工具栏「从模板创建」）；运行历史同理
 *   （2026-08-30 用户裁决：/runs 页已删，历史在 flow 卡片展开区 ——
 *   FlowRunsPanel）。
 *
 * 会话历史：2026-08-29 用户裁决恢复「项目目录为第一维度」的树
 * （ChatHistoryTree，与 Chat-First 回滚壳共用同一实现 —— 含搜索、目录
 * 重命名/删除、每目录新建、会话重命名/删除、HoverCard 预览），取代此前
 * 的扁平「最近对话」列表。
 *
 * DOM 类名沿用 chat-nav-* 体系（chat-nav-sidebar.css），仅新增 nav 段样式
 * （app-nav.css）——双主题 token 自动生效。
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@/components/icon'
import { LocaleToggle } from '@/components/locale-toggle'
import { ThemeToggle } from '@/components/theme-toggle'
import { ChatHistoryTree } from '@/components/chat-history-tree'
import { useI18n } from '@/i18n'
import '@/styles/app-nav.css'

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

      {/* 会话历史树（项目目录为第一维度，与 Chat-First 壳共用实现）。
       * chat-nav-browser 自带 flex:1 + min-height:0，填满主导航与页脚之间。 */}
      <ChatHistoryTree />

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
