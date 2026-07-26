# Chat-First 范式重构修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有"贴在旧 9 屏架构上"的 chat 页面重构为 design-redo-open-webui 的 Chat-First 范式，使全局布局、sidebar 结构、路由表、页面组件全部符合架构设计文档。

**Architecture:** 改造 AppShell 为 OpenWebUI 单侧边栏范式（sidebar + main，无 topbar grid）；sidebar 重构为双维度折叠列表（目录→对话）；路由表砍掉 dashboard/lab/launcher/chat/workspace 旧路由，新增 daemons；Chat Home 加建议卡 + agent selector；Chat Detail 加面包屑 + 右栏上下文面板；消息发送接入 SSE 流式。

**Tech Stack:** Next.js 15 App Router, React 19, Hono, TypeORM, PostgreSQL, 现有 CSS token 系统（tokens.css）

---

## 文件结构

### 新建文件
```
apps/console/src/components/chat-layout.tsx          # Chat-First 全局布局（替代 AppShell）
apps/console/src/components/chat-nav-sidebar.tsx     # OpenWebUI 范式 sidebar（双维度折叠）
apps/console/src/components/chat-composer.tsx        # 统一 composer 组件（agent selector + @ 提示 + 发送）
apps/console/src/components/suggestion-cards.tsx     # Chat Home 2×2 建议卡
apps/console/src/components/chat-context-panel.tsx   # 对话详情右栏上下文
apps/console/src/components/chat-breadcrumb.tsx      # 对话详情面包屑
apps/console/src/styles/chat-layout.css              # 新布局样式
apps/console/src/styles/chat-nav-sidebar.css         # 新 sidebar 样式
apps/console/src/styles/chat-composer.css            # composer 样式
apps/console/src/styles/suggestion-cards.css         # 建议卡样式
apps/console/src/styles/chat-context-panel.css       # 右栏样式
apps/console/src/app/daemons/page.tsx                # Daemons 页面
```

### 修改文件
```
apps/console/src/app/layout.tsx                      # 替换 AppShell → ChatLayout
apps/console/src/components/chat-home.tsx            # 重写：建议卡 + 新 composer
apps/console/src/components/chat-detail.tsx          # 重写：面包屑 + 右栏 + 新 composer
apps/console/src/components/nav.ts                   # 重构 NAV 为 Chat-First 导航
apps/console/src/components/icon.tsx                 # 新增 lucide 风格图标
apps/console/src/lib/chats.ts                       # 新增 streamMessage 函数
```

### 废弃文件（不删除，仅从导航移除）
```
apps/console/src/app/dashboard/page.tsx              # 砍掉
apps/console/src/app/lab/page.tsx                    # 砍掉
apps/console/src/app/chat/page.tsx                   # 砍掉
apps/console/src/app/workspace/page.tsx              # 砍掉
apps/console/src/components/app-shell.tsx            # 不再使用（保留文件）
apps/console/src/components/chat-sidebar.tsx         # 被新组件替代（保留文件）
```

---

## Task 1: 重构全局布局 — ChatLayout 替代 AppShell

**目标:** 创建 design-redo 的 OpenWebUI 单侧边栏布局，替换旧的三栏 grid（sidebar + topbar + main）。

**Files:**
- Create: `apps/console/src/components/chat-layout.tsx`
- Create: `apps/console/src/styles/chat-layout.css`
- Modify: `apps/console/src/app/layout.tsx`

### Step 1: 创建 chat-layout.css

Create `apps/console/src/styles/chat-layout.css`:

```css
/* Chat-First layout: sidebar + main (OpenWebUI paradigm).
   Replaces the old 3-grid AppShell (sidebar + topbar + main). */

.chat-layout {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.chat-layout-sidebar {
  width: 260px;
  min-width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--surface-warm);
  border-right: 1px solid var(--border-soft);
  transition: width var(--motion-base) var(--ease-standard),
              min-width var(--motion-base) var(--ease-standard);
}

.chat-layout-sidebar.collapsed {
  width: 60px;
  min-width: 60px;
}

.chat-layout-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
}

/* Topbar replaced by a slim navbar inside main */
.chat-layout-navbar {
  height: 56px;
  min-height: 56px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-4);
  background: linear-gradient(to bottom, rgba(255,255,255,0.92), rgba(255,255,255,0.5), transparent);
  z-index: 10;
}

.chat-layout-navbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.chat-layout-navbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.chat-layout-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}

.chat-layout-toggle:hover {
  background: var(--surface);
}

.chat-layout-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: 创建 chat-layout.tsx**

Create `apps/console/src/components/chat-layout.tsx`:

```tsx
'use client'

/**
 * Chat-First global layout (OpenWebUI paradigm).
 *
 * Replaces the old AppShell (3-grid: sidebar + topbar + main) with a
 * 2-pane layout: sidebar + main. The sidebar is the new ChatNavSidebar
 * (dual-dimension: directories → chats). The main pane has a slim navbar
 * (sidebar toggle + breadcrumb + user avatar) and the page content.
 *
 * Based on design-redo-open-webui/pages/main.html `.app-shell` layout.
 */

import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ChatNavSidebar } from '@/components/chat-nav-sidebar'
import { Icon } from '@/components/icon'
import { useSession } from '@/lib/auth-client'
import '@/styles/chat-layout.css'

const COLLAPSE_KEY = 'od:chat-sidebar'

export function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/'
  const { user, logout } = useSession()
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
  }, [])

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'open')
      return next
    })
  }, [])

  return (
    <div className="chat-layout">
      <aside className={`chat-layout-sidebar${collapsed ? ' collapsed' : ''}`}>
        <ChatNavSidebar collapsed={collapsed} />
      </aside>
      <div className="chat-layout-main">
        <header className="chat-layout-navbar">
          <div className="chat-layout-navbar-left">
            <button
              type="button"
              className="chat-layout-toggle"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
              title={collapsed ? '展开侧栏' : '折叠侧栏'}
            >
              <Icon name="collapse" style={{ transform: collapsed ? 'rotate(180deg)' : '', transition: 'transform var(--motion-fast)' }} />
            </button>
          </div>
          <div className="chat-layout-navbar-right">
            <div className="account-menu-wrap" style={{ position: 'relative' }}>
              <button
                type="button"
                className="avatar"
                style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-xs)', fontWeight: 600, color: '#fff', background: 'linear-gradient(135deg, var(--fg), var(--accent))', border: 'none', cursor: 'pointer' }}
                aria-label="账户"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {user ? user.name.slice(0, 2).toUpperCase() : 'RZ'}
              </button>
              {menuOpen ? (
                <div className="account-menu" role="menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 'var(--space-1)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-dropdown)', minWidth: 160, zIndex: 100 }}>
                  <div className="account-menu-name" style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>{user?.name ?? '未登录'}</div>
                  <button type="button" role="menuitem" className="account-menu-item" style={{ display: 'block', width: '100%', padding: 'var(--space-2) var(--space-3)', border: 'none', background: 'transparent', textAlign: 'left', fontSize: 'var(--text-sm)', color: 'var(--fg)', cursor: 'pointer' }} onClick={() => { setMenuOpen(false); void logout() }}>
                    登出
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="chat-layout-content">
          {children}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 修改 layout.tsx 使用 ChatLayout**

Modify `apps/console/src/app/layout.tsx`:

Replace `RootGate` wrapping (which wraps AppShell) with ChatLayout. Read the current file first, then replace:

```tsx
import type { Metadata } from 'next'
import { RootGate } from '@/components/root-gate'
import { ChatLayout } from '@/components/chat-layout'
import '@/styles/tokens.css'
import '@/styles/shell.css'

export const metadata: Metadata = {
  title: 'DAgent Console',
  description: 'Dagents 编排平台 — 控制台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <RootGate>
          <ChatLayout>{children}</ChatLayout>
        </RootGate>
      </body>
    </html>
  )
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @dagents/console build`
Expected: Build fails because `ChatNavSidebar` doesn't exist yet — that's expected, we'll create it in Task 2. For now just verify the CSS + layout files compile.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/components/chat-layout.tsx apps/console/src/styles/chat-layout.css apps/console/src/app/layout.tsx
git commit -m "feat(console): chat-first global layout (ChatLayout replaces AppShell)"
```

---

## Task 2: 重构 Sidebar — ChatNavSidebar 双维度折叠列表

**目标:** 创建 design-redo 的 OpenWebUI sidebar，包含：品牌头 + New Chat + 导航 + 按目录折叠的对话历史 + 用户底栏。

**Files:**
- Create: `apps/console/src/components/chat-nav-sidebar.tsx`
- Create: `apps/console/src/styles/chat-nav-sidebar.css`
- Modify: `apps/console/src/components/nav.ts`
- Modify: `apps/console/src/components/icon.tsx`

### Step 1: 更新 nav.ts — Chat-First 导航

Modify `apps/console/src/components/nav.ts`. Replace the entire NAV array with the new Chat-First navigation:

```typescript
export const NAV: readonly NavSection[] = [
  {
    section: '',
    items: [
      { id: 'chat', label: 'Chat', href: '/', icon: 'chat' },
      { id: 'agents', label: 'Agents', href: '/agents', icon: 'agents' },
      { id: 'flows', label: 'AgentFlows', href: '/flows', icon: 'flows' },
      { id: 'daemons', label: 'Daemons', href: '/daemons', icon: 'daemons' },
      { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
    ],
  },
] as const
```

Also update CRUMBS to add `/daemons` and `/chats/` and remove old entries:

```typescript
const CRUMBS: readonly { match: string; segments: readonly CrumbSegment[] }[] = [
  { match: '/chats/', segments: [{ label: 'Chat' }] },
  { match: '/agents/', segments: [{ label: 'Agents', href: '/agents' }, { label: '详情' }] },
  { match: '/agents', segments: [{ label: 'Agents' }] },
  { match: '/flows', segments: [{ label: 'AgentFlows' }] },
  { match: '/daemons', segments: [{ label: 'Daemons' }] },
  { match: '/directories', segments: [{ label: '项目目录' }] },
  { match: '/settings', segments: [{ label: 'Settings' }] },
  { match: '/', segments: [] },
]
```

- [ ] **Step 2: 新增图标到 icon.tsx**

Add these icons to the ICONS object in `apps/console/src/components/icon.tsx`:

```typescript
  chat:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  daemons:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 3v6M15 3v6M9 15v6M15 15v6M3 9h6M3 15h6M15 9h6M15 15h6"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  send:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  bot:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
  zap:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  chevronRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  panelLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>',
```

- [ ] **Step 3: 创建 chat-nav-sidebar.css**

Create `apps/console/src/styles/chat-nav-sidebar.css`:

```css
/* OpenWebUI-style sidebar: brand + new chat + nav + directory-folded chat history + user footer */

.chat-nav-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Brand header */
.chat-nav-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  min-height: 56px;
}

.chat-nav-brand-mark {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink:: 0;
}

.chat-nav-brand-name {
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--fg);
  margin-left: var(--space-2);
}

.chat-nav-brand.collapsed .chat-nav-brand-name,
.chat-nav-brand.collapsed .chat-nav-brand-sub {
  display: none;
}

/* New Chat + Search */
.chat-nav-actions {
  padding: 0 var(--space-3) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.chat-nav-action-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: 500;
  border: 1px solid var(--border-soft);
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}

.chat-nav-action-btn:hover {
  background: var(--sidebar-hover, var(--surface));
}

.chat-nav-action-btn.ghost {
  border: none;
  background: transparent;
  color: var(--muted);
}

.chat-nav-action-btn.ghost:hover {
  background: var(--surface);
}

/* Navigation */
.chat-nav-nav {
  padding: 0 var(--space-3) var(--space-2);
}

.chat-nav-link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--muted);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
  text-decoration: none;
}

.chat-nav-link:hover {
  background: var(--surface);
}

.chat-nav-link[aria-current="page"] {
  background: var(--bg);
  color: var(--fg);
  font-weight: 500;
}

.chat-nav-link[aria-current="page"] .nav-icon {
  color: var(--accent);
}

/* Chat history — directory fold groups */
.chat-nav-history {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--space-3) var(--space-2);
  position: relative;
}

.chat-nav-history::-webkit-scrollbar { display: none; }
.chat-nav-history { scrollbar-width: none; }

.chat-nav-dir-group {
  margin-bottom: var(--space-3);
}

.chat-nav-dir-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--meta);
  cursor: pointer;
  transition: background var(--motion-fast);
}

.chat-nav-dir-header:hover {
  background: var(--surface);
}

.chat-nav-dir-count {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--meta);
  font-variant-numeric: tabular-nums;
}

.chat-nav-dir-items {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.chat-nav-chat-item {
  display: flex;
  align-items: center;
  gap: 0;
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--muted);
  cursor: pointer;
  transition: background var(--motion-fast);
  text-decoration: none;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}

.chat-nav-chat-item:hover {
  background: var(--surface);
}

.chat-nav-chat-item[aria-selected="true"] {
  background: var(--bg);
  color: var(--fg);
}

.chat-nav-chat-item-bar {
  width: 3px;
  height: 24px;
  border-radius: 0 2px 2px 0;
  flex-shrink: 0;
  background: transparent;
}

.chat-nav-chat-item[aria-selected="true"] .chat-nav-chat-item-bar {
  background: var(--accent);
}

.chat-nav-chat-item-title {
  padding-left: var(--space-2);
  padding-right: var(--space-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Status dots */
.chat-nav-chat-status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-right: var(--space-2);
}

.chat-nav-chat-status.running { background: var(--success); }
.chat-nav-chat-status.idle { background: var(--meta); }
.chat-nav-chat-status.done { background: var(--border); }
.chat-nav-chat-status.failed { background: var(--danger); }

/* Add directory button */
.chat-nav-add-dir {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--meta);
  cursor: pointer;
  transition: background var(--motion-fast);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}

.chat-nav-add-dir:hover {
  background: var(--surface);
  color: var(--fg);
}

/* User footer */
.chat-nav-footer {
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-top: 1px solid var(--border-soft);
}

.chat-nav-user {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--motion-fast);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}

.chat-nav-user:hover {
  background: var(--surface);
}

.chat-nav-user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--fg), var(--accent));
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: 600;
  flex-shrink: 0;
  position: relative;
}

.chat-nav-user-avatar::after {
  content: '';
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--success);
  border: 2px solid var(--surface-warm);
}

.chat-nav-user-info {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-nav-user-name {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-nav-user-plan {
  font-size: var(--text-xs);
  color: var(--meta);
}

/* Collapsed state */
.chat-layout-sidebar.collapsed .chat-nav-brand-name,
.chat-layout-sidebar.collapsed .chat-nav-action-btn span,
.chat-layout-sidebar.collapsed .chat-nav-link span,
.chat-layout-sidebar.collapsed .chat-nav-dir-header span,
.chat-layout-sidebar.collapsed .chat-nav-chat-item-title,
.chat-layout-sidebar.collapsed .chat-nav-user-info,
.chat-layout-sidebar.collapsed .chat-nav-add-dir span {
  display: none;
}

.chat-layout-sidebar.collapsed .chat-nav-brand,
.chat-layout-sidebar.collapsed .chat-nav-action-btn,
.chat-layout-sidebar.collapsed .chat-nav-link,
.chat-layout-sidebar.collapsed .chat-nav-user {
  justify-content: center;
}
```

- [ ] **Step 4: 创建 chat-nav-sidebar.tsx**

Create `apps/console/src/components/chat-nav-sidebar.tsx`:

```tsx
'use client'

/**
 * Chat-First navigation sidebar (OpenWebUI paradigm).
 *
 * Dual-dimension structure:
 *   - Brand + New Chat + Search
 *   - Primary nav (Chat / Agents / AgentFlows / Daemons / Settings)
 *   - Chat history grouped by project directory (collapsible)
 *   - User footer
 *
 * Replaces the old ChatSidebar (flat list + dropdown).
 */

import { useEffect, useState, useMemo, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { NAV } from '@/components/nav'
import { useSession } from '@/lib/auth-client'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { fetchChats, type Chat } from '@/lib/chats'
import '@/styles/chat-nav-sidebar.css'

interface ChatNavSidebarProps {
  collapsed?: boolean
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function ChatNavSidebar({ collapsed }: ChatNavSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { user } = useSession()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [chatsByDir, setChatsByDir] = useState<Record<string, Chat[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Extract active chat id from pathname /chats/:id
  useEffect(() => {
    const match = pathname.match(/^\/chats\/([^/]+)/)
    setActiveChatId(match?.[1] ?? null)
  }, [pathname])

  // Fetch directories
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        // Expand the first directory by default
        if (dirs.length > 0) {
          setExpandedDirs(new Set([dirs[0]!.id]))
        }
      } catch {
        // silent — sidebar shows empty state
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Fetch chats for all directories (lightweight — directories are few)
  useEffect(() => {
    if (directories.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        directories.map(async (dir) => {
          try {
            const chats = await fetchChats(dir.id)
            return [dir.id, chats] as const
          } catch {
            return [dir.id, []] as const
          }
        }),
      )
      if (cancelled) return
      const map: Record<string, Chat[]> = {}
      for (const [id, chats] of entries) map[id] = chats
      setChatsByDir(map)
    })()
    return () => { cancelled = true }
  }, [directories])

  const toggleDir = useCallback((dirId: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirId)) next.delete(dirId)
      else next.add(dirId)
      return next
    })
  }, [])

  const handleNewChat = useCallback(() => {
    router.push('/')
  }, [router])

  return (
    <div className="chat-nav-sidebar">
      {/* Brand */}
      <div className={`chat-nav-brand${collapsed ? ' collapsed' : ''}`}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <div className="chat-nav-brand-mark">
            <Icon name="bot" className="nav-icon" style={{ width: 16, height: 16 }} />
          </div>
          <span className="chat-nav-brand-name">DAgent Console</span>
        </Link>
      </div>

      {/* New Chat + Search */}
      <div className="chat-nav-actions">
        <button type="button" className="chat-nav-action-btn" onClick={handleNewChat}>
          <Icon name="pencil" className="nav-icon" style={{ width: 16, height: 16 }} />
          <span>New Chat</span>
        </button>
      </div>

      {/* Primary nav */}
      <nav className="chat-nav-nav">
        {NAV.flatMap((group) => group.items).map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className="chat-nav-link"
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            <Icon name={item.icon} className="nav-icon" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Chat history grouped by directory */}
      <div className="chat-nav-history">
        {loading ? (
          <div style={{ padding: 'var(--space-3)', color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>Loading…</div>
        ) : directories.length === 0 ? (
          <Link href="/directories" className="chat-nav-add-dir">
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>添加项目目录</span>
          </Link>
        ) : (
          directories.map((dir) => {
            const chats = chatsByDir[dir.id] ?? []
            const expanded = expandedDirs.has(dir.id)
            return (
              <div key={dir.id} className="chat-nav-dir-group">
                <button
                  type="button"
                  className="chat-nav-dir-header"
                  onClick={() => toggleDir(dir.id)}
                >
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} style={{ width: 12, height: 12 }} />
                  <Icon name="folder" style={{ width: 14, height: 14 }} />
                  <span>{dir.name}</span>
                  <span className="chat-nav-dir-count">{chats.length}</span>
                </button>
                {expanded && (
                  <div className="chat-nav-dir-items">
                    {chats.map((chat) => (
                      <Link
                        key={chat.id}
                        href={`/chats/${chat.id}`}
                        className="chat-nav-chat-item"
                        aria-selected={activeChatId === chat.id}
                      >
                        <span className={`chat-nav-chat-status ${chat.status}`} />
                        <span className="chat-nav-chat-item-title">{chat.title}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
        {directories.length > 0 && (
          <Link href="/directories" className="chat-nav-add-dir">
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>添加项目目录</span>
          </Link>
        )}
      </div>

      {/* User footer */}
      <div className="chat-nav-footer">
        <Link href="/settings" className="chat-nav-user">
          <div className="chat-nav-user-avatar">
            {user ? user.name.slice(0, 1).toUpperCase() : 'R'}
          </div>
          <div className="chat-nav-user-info">
            <span className="chat-nav-user-name">{user?.name ?? '未登录'}</span>
            <span className="chat-nav-user-plan">Pro Plan</span>
          </div>
        </Link>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 构建验证**

Run: `pnpm --filter @dagents/console build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/components/chat-nav-sidebar.tsx apps/console/src/styles/chat-nav-sidebar.css apps/console/src/components/nav.ts apps/console/src/components/icon.tsx
git commit -m "feat(console): chat-nav sidebar with dual-dimension directory fold"
```

---

## Task 3: 重构 Chat Home — 建议卡 + Agent Selector + 新 Composer

**目标:** 按 design-redo 原型重写 Chat Home：bot 头像 + 欢迎文案 + 2×2 建议卡 + 统一 composer（agent selector + @ 提示 + 发送）。

**Files:**
- Create: `apps/console/src/components/suggestion-cards.tsx`
- Create: `apps/console/src/styles/suggestion-cards.css`
- Create: `apps/console/src/components/chat-composer.tsx`
- Create: `apps/console/src/styles/chat-composer.css`
- Modify: `apps/console/src/components/chat-home.tsx`

### Step 1: 创建 suggestion-cards 组件

Create `apps/console/src/components/suggestion-cards.tsx`:

```tsx
'use client'

import { Icon } from '@/components/icon'
import '@/styles/suggestion-cards.css'

interface SuggestionCardsProps {
  onPick?: (text: string) => void
}

const SUGGESTIONS = [
  { icon: 'zap', text: '帮我创建一个批量推理的 AgentFlow' },
  { icon: 'agents', text: '查看当前资源看板的 agent 状态' },
  { icon: 'flows', text: '设计一个多步骤的 Workspace 任务' },
  { icon: 'lab', text: '测试新的 Agent prompt 模板' },
] as const

export function SuggestionCards({ onPick }: SuggestionCardsProps): React.ReactElement {
  return (
    <div className="suggestion-grid">
      {SUGGESTIONS.map((s) => (
        <button
          key={s.text}
          type="button"
          className="suggestion-card"
          onClick={() => onPick?.(s.text)}
        >
          <div className="suggestion-card-icon">
            <Icon name={s.icon} style={{ width: 14, height: 14 }} />
          </div>
          <span className="suggestion-card-text">{s.text}</span>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 创建 suggestion-cards.css**

Create `apps/console/src/styles/suggestion-cards.css`:

```css
.suggestion-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  width: 100%;
  max-width: 640px;
}

.suggestion-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  background: var(--bg);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
              border-color var(--motion-fast) var(--ease-standard);
  text-align: left;
}

.suggestion-card:hover {
  background: var(--surface-warm);
  border-color: var(--border);
}

.suggestion-card-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.suggestion-card-text {
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--fg);
}
```

- [ ] **Step 3: 创建 chat-composer 组件**

Create `apps/console/src/components/chat-composer.tsx`:

```tsx
'use client'

import { useRef, useState, useCallback } from 'react'
import { Icon } from '@/components/icon'
import '@/styles/chat-composer.css'

interface ChatComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  placeholder?: string
  agentSelector?: boolean
}

export function ChatComposer({
  onSend,
  disabled,
  placeholder = 'Send a message…',
  agentSelector = true,
}: ChatComposerProps): React.ReactElement {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setInput('')
  }, [input, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const canSend = input.trim().length > 0 && !disabled

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer-card">
        <div className="chat-composer-top">
          <button type="button" className="chat-composer-attach" title="Attach file">
            <Icon name="plus" style={{ width: 18, height: 18 }} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="chat-composer-textarea"
            rows={1}
            disabled={disabled}
          />
        </div>
        <div className="chat-composer-bottom">
          {agentSelector && (
            <button type="button" className="chat-composer-agent" title="Select agent">
              <Icon name="bot" style={{ width: 14, height: 14, color: 'var(--accent)' }} />
              <span>Agent</span>
              <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
            </button>
          )}
          <span className="chat-composer-hint">
            ⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令
          </span>
          <button
            type="button"
            className="chat-composer-send"
            onClick={handleSend}
            disabled={!canSend}
            title="Send message"
          >
            <Icon name="send" style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 chat-composer.css**

Create `apps/console/src/styles/chat-composer.css`:

```css
.chat-composer-wrap {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  justify-content: center;
}

.chat-composer-card {
  width: 100%;
  max-width: 768px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-soft);
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(8px);
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.04);
  transition: border-color var(--motion-fast) var(--ease-standard);
}

.chat-composer-card:focus-within {
  border-color: var(--border);
}

.chat-composer-top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) 0;
}

.chat-composer-attach {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--meta);
  cursor: pointer;
  flex-shrink: 0;
  margin-top: 2px;
  transition: background var(--motion-fast);
}

.chat-composer-attach:hover {
  background: var(--surface);
}

.chat-composer-textarea {
  flex: 1;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--fg);
  font-family: var(--font-body);
  min-height: 44px;
  max-height: 200px;
}

.chat-composer-textarea::placeholder {
  color: var(--meta);
}

.chat-composer-bottom {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-2);
}

.chat-composer-agent {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}

.chat-composer-agent:hover {
  background: var(--surface);
  color: var(--fg);
}

.chat-composer-hint {
  font-size: var(--text-xs);
  color: var(--meta);
  margin-left: auto;
  margin-right: var(--space-2);
}

.chat-composer-send {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--surface);
  color: var(--meta);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
  flex-shrink: 0;
}

.chat-composer-send:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.chat-composer-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 5: 重写 chat-home.tsx**

Replace `apps/console/src/components/chat-home.tsx` entirely:

```tsx
'use client'

/**
 * Chat Home (/) — Chat-First landing page.
 *
 * Layout (design-redo paradigm):
 *   - Centered placeholder: bot avatar + welcome + 2×2 suggestion cards
 *   - Bottom: unified composer (agent selector + @ hints + send)
 *
 * No sidebar here — the sidebar is global (ChatNavSidebar in ChatLayout).
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { SuggestionCards } from '@/components/suggestion-cards'
import { ChatComposer } from '@/components/chat-composer'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { createChat, createMessage } from '@/lib/chats'

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        if (dirs.length > 0) setSelectedDirId(dirs[0]!.id)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSend = useCallback(async (text: string) => {
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      setError('请先添加项目目录')
      return
    }
    setSending(true)
    setError(null)
    try {
      const chat = await createChat({
        directoryId,
        title: text.slice(0, 50),
      })
      await createMessage(chat.id, { content: text, role: 'user' })
      router.push(`/chats/${chat.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }, [selectedDirId, directories, router])

  return (
    <div className="chat-home-body">
      {/* Placeholder (centered when no active chat) */}
      <div className="chat-home-placeholder">
        <div className="chat-home-placeholder-inner">
          <div className="chat-home-bot-avatar">
            <Icon name="bot" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
          </div>
          <h1 className="chat-home-welcome-title">DAgent Console</h1>
          <p className="chat-home-welcome-desc">
            Multi-agent orchestration with reasoning, tool use, and parallel execution support.
          </p>
          <SuggestionCards onPick={(text) => void handleSend(text)} />
        </div>
      </div>

      {/* Composer */}
      <ChatComposer onSend={handleSend} disabled={sending} />
      {error && (
        <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--text-sm)', paddingBottom: 'var(--space-4)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
```

Add these styles to `apps/console/src/styles/chat-home.css` (replace existing content):

```css
.chat-home-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-home-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}

.chat-home-placeholder-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 640px;
}

.chat-home-bot-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-4);
}

.chat-home-welcome-title {
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--fg);
  margin-bottom: var(--space-1);
}

.chat-home-welcome-desc {
  font-size: var(--text-sm);
  color: var(--muted);
  text-align: center;
  line-height: 1.6;
  margin-bottom: var(--space-8);
}
```

- [ ] **Step 6: 构建验证**

Run: `pnpm --filter @dagents/console build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/console/src/components/suggestion-cards.tsx apps/console/src/styles/suggestion-cards.css apps/console/src/components/chat-composer.tsx apps/console/src/styles/chat-composer.css apps/console/src/components/chat-home.tsx apps/console/src/styles/chat-home.css
git commit -m "feat(console): chat home with suggestion cards + unified composer"
```

---

## Task 4: 重构 Chat Detail — 面包屑 + 右栏上下文 + 新 Composer

**目标:** 按 design-redo 原型重写对话详情：面包屑 + 双栏（左对话流 + 右上下文面板）+ 统一 composer。

**Files:**
- Create: `apps/console/src/components/chat-context-panel.tsx`
- Create: `apps/console/src/styles/chat-context-panel.css`
- Modify: `apps/console/src/components/chat-detail.tsx`
- Modify: `apps/console/src/styles/chat-detail.css`

### Step 1: 创建 chat-context-panel 组件

Create `apps/console/src/components/chat-context-panel.tsx`:

```tsx
'use client'

import type { Chat, ChatMessage } from '@/lib/chats'
import type { Directory } from '@/lib/directories'
import { Icon } from '@/components/icon'
import '@/styles/chat-context-panel.css'

interface ChatContextPanelProps {
  chat: Chat | null
  directory: Directory | null
  messages: ChatMessage[]
}

export function ChatContextPanel({ chat, directory, messages }: ChatContextPanelProps): React.ReactElement {
  return (
    <div className="chat-context-panel">
      {/* Directory */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">所属目录</div>
        {directory ? (
          <div className="chat-context-item">
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
          </div>
        ) : (
          <div className="muted">—</div>
        )}
      </div>

      {/* Agent */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">绑定 Agent</div>
        <div className="chat-context-item">
          <Icon name="bot" style={{ width: 14, height: 14 }} />
          <span>{chat?.agentId ?? 'auto'}</span>
        </div>
      </div>

      {/* Flow */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">绑定 Flow</div>
        <div className="chat-context-item">
          <Icon name="flows" style={{ width: 14, height: 14 }} />
          <span>{chat?.flowId ?? '—'}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">统计</div>
        <div className="chat-context-stats">
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">消息数</span>
            <span className="chat-context-stat-value">{chat?.messageCount ?? 0}</span>
          </div>
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">状态</span>
            <span className={`chat-context-stat-value status-${chat?.status ?? 'idle'}`}>
              {chat?.status ?? 'idle'}
            </span>
          </div>
        </div>
      </div>

      {/* Recent runs (from messages with runId) */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">执行记录</div>
        {messages.filter((m) => m.runId).length === 0 ? (
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>暂无执行记录</div>
        ) : (
          <div className="chat-context-runs">
            {messages
              .filter((m) => m.runId)
              .slice(-5)
              .map((m) => (
                <div key={m.id} className="chat-context-run">
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
                    {m.runId?.slice(0, 8)}
                  </span>
                  <span className="chat-context-run-role">{m.role}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 chat-context-panel.css**

Create `apps/console/src/styles/chat-context-panel.css`:

```css
.chat-context-panel {
  width: 280px;
  min-width: 280px;
  border-left: 1px solid var(--border-soft);
  background: var(--surface-warm);
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.chat-context-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chat-context-section-title {
  font-size: var(--text-xs);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--meta);
}

.chat-context-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg);
}

.chat-context-stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chat-context-stat {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-sm);
}

.chat-context-stat-label {
  color: var(--muted);
}

.chat-context-stat-value {
  color: var(--fg);
  font-weight: 500;
}

.chat-context-stat-value.status-running { color: var(--success); }
.chat-context-stat-value.status-failed { color: var(--danger); }
.chat-context-stat-value.status-done { color: var(--meta); }

.chat-context-runs {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.chat-context-run {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-1) 0;
}

.chat-context-run-role {
  font-size: var(--text-xs);
  color: var(--muted);
  text-transform: capitalize;
}
```

- [ ] **Step 3: 重写 chat-detail.tsx**

Replace `apps/console/src/components/chat-detail.tsx` entirely:

```tsx
'use client'

/**
 * Chat Detail (/chats/:id) — conversation view.
 *
 * Layout (design-redo paradigm):
 *   - Breadcrumb: 📁 directory / chat title [status]
 *   - Left: message stream + composer
 *   - Right: context panel (directory, agent, flow, stats, runs)
 *
 * The sidebar is global (ChatNavSidebar in ChatLayout) — not rendered here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { ChatContextPanel } from '@/components/chat-context-panel'
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  createMessage,
} from '@/lib/chats'
import { fetchDirectory, type Directory } from '@/lib/directories'
import '@/styles/chat-detail.css'

interface ChatDetailProps {
  chatId: string
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
}

export function ChatDetail({ chatId }: ChatDetailProps): React.ReactElement {
  const router = useRouter()
  const [chat, setChat] = useState<Chat | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setChat(null)
    setDirectory(null)
    setMessages([])

    const ac = new AbortController()

    Promise.all([
      fetchChat(chatId, ac.signal).then((c) => {
        if (!cancelled) setChat(c)
        // Fetch directory after chat loads
        return fetchDirectory(c.directoryId, ac.signal).then((d) => {
          if (!cancelled) setDirectory(d)
        }).catch(() => {})
      }),
      fetchMessages(chatId, ac.signal).then((m) => {
        if (!cancelled) setMessages(m)
      }),
    ]).catch((err: unknown) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [chatId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(async (text: string) => {
    if (sending) return
    setSending(true)
    setError(null)

    const optimisticId = `opt-${Date.now()}`
    const optimisticMsg: ChatMessage = {
      id: optimisticId,
      chatId,
      role: 'user',
      content: text,
      runId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimisticMsg])

    try {
      const message = await createMessage(chatId, { content: text, role: 'user' })
      setMessages((prev) => prev.map((m) => (m.id === optimisticId ? message : m)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
    } finally {
      setSending(false)
    }
  }, [chatId, sending])

  return (
    <div className="chat-detail-body">
      {/* Breadcrumb */}
      <div className="chat-detail-breadcrumb">
        {directory && (
          <Link href="/directories" className="chat-detail-breadcrumb-dir">
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
          </Link>
        )}
        <span className="chat-detail-breadcrumb-sep">/</span>
        <span className="chat-detail-breadcrumb-title">
          {loading ? 'Loading…' : chat?.title ?? 'Chat'}
        </span>
        {chat && (
          <span className={`chat-detail-breadcrumb-status status-${chat.status}`}>
            {STATUS_LABEL[chat.status]}
          </span>
        )}
      </div>

      {/* Main split: messages + context */}
      <div className="chat-detail-split">
        {/* Left: messages + composer */}
        <div className="chat-detail-conversation">
          <div className="chat-detail-messages">
            {loading ? (
              <div className="chat-detail-empty">Loading chat…</div>
            ) : error && messages.length === 0 ? (
              <div className="chat-detail-empty" style={{ color: 'var(--danger)' }}>
                Failed to load: {error}
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-detail-empty">No messages yet. Send a message to start.</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                  <div className="chat-msg-content">{m.content}</div>
                  <div className="chat-msg-meta">{formatTime(m.createdAt)}</div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
          <ChatComposer onSend={handleSend} disabled={sending || loading} />
        </div>

        {/* Right: context panel */}
        <ChatContextPanel chat={chat} directory={directory} messages={messages} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 重写 chat-detail.css**

Replace `apps/console/src/styles/chat-detail.css` entirely:

```css
.chat-detail-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Breadcrumb */
.chat-detail-breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--text-sm);
  flex-shrink: 0;
}

.chat-detail-breadcrumb-dir {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--muted);
  text-decoration: none;
  transition: color var(--motion-fast);
}

.chat-detail-breadcrumb-dir:hover {
  color: var(--fg);
}

.chat-detail-breadcrumb-sep {
  color: var(--meta);
}

.chat-detail-breadcrumb-title {
  color: var(--fg);
  font-weight: 500;
}

.chat-detail-breadcrumb-status {
  margin-left: var(--space-2);
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: 500;
}

.chat-detail-breadcrumb-status.status-running {
  background: var(--success-soft);
  color: var(--success);
}

.chat-detail-breadcrumb-status.status-idle {
  background: var(--surface);
  color: var(--muted);
}

.chat-detail-breadcrumb-status.status-done {
  background: var(--surface);
  color: var(--meta);
}

.chat-detail-breadcrumb-status.status-failed {
  background: var(--danger-soft);
  color: var(--danger);
}

/* Split layout */
.chat-detail-split {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.chat-detail-conversation {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* Messages */
.chat-detail-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 768px;
  width: 100%;
  margin: 0 auto;
}

.chat-detail-empty {
  margin: auto;
  color: var(--muted);
  font-size: var(--text-sm);
  text-align: center;
}

/* Message bubbles */
.chat-msg {
  max-width: 70%;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-break: break-word;
}

.chat-msg-user {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
}

.chat-msg-assistant {
  align-self: flex-start;
  background: var(--surface);
  color: var(--fg);
}

.chat-msg-system {
  align-self: center;
  background: var(--warn-soft);
  color: var(--fg);
  font-size: var(--text-xs);
  text-align: center;
  max-width: 90%;
}

.chat-msg-tool {
  align-self: flex-start;
  background: var(--info-soft);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.chat-msg-meta {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  opacity: 0.7;
}

.chat-msg-user .chat-msg-meta {
  color: rgba(255, 255, 255, 0.8);
}
```

- [ ] **Step 5: 构建验证**

Run: `pnpm --filter @dagents/console build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/components/chat-context-panel.tsx apps/console/src/styles/chat-context-panel.css apps/console/src/components/chat-detail.tsx apps/console/src/styles/chat-detail.css
git commit -m "feat(console): chat detail with breadcrumb + context panel + new composer"
```

---

## Task 5: 新增 Daemons 页面 + 清理旧路由

**目标:** 创建 `/daemons` 页面占位，确保导航链接不 404。旧路由（dashboard/lab/chat/workspace）的页面文件保留但从导航中移除（nav.ts 已在 Task 2 更新）。

**Files:**
- Create: `apps/console/src/app/daemons/page.tsx`

### Step 1: 创建 daemons 页面

Create `apps/console/src/app/daemons/page.tsx`:

```tsx
import { PageShell } from '@/components/page-shell'

/**
 * Daemons route — task queue + execution timeline + stats.
 *
 * Placeholder page; full implementation will use design/daemon-execution.html
 * three-column layout (task queue / execution timeline / statistics).
 */

export default function DaemonsPage(): React.ReactElement {
  return (
    <PageShell
      title="Daemons"
      subtitle="任务队列 · 执行时间线 · 统计"
    >
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--muted)' }}>
        Daemons 模块开发中
      </div>
    </PageShell>
  )
}
```

- [ ] **Step 2: 构建验证**

Run: `pnpm --filter @dagents/console build`
Expected: PASS — `/daemons` route appears in build output

- [ ] **Step 3: Commit**

```bash
git add apps/console/src/app/daemons/page.tsx
git commit -m "feat(console): add daemons page placeholder"
```

---

## Task 6: 最终构建验证 + 浏览器验证

**目标:** 确保所有改动后构建通过，旧路由仍可访问（文件保留），新路由正常工作。

### Step 1: 全量构建

Run: `pnpm --filter @dagents/console build`
Expected: PASS — all routes present

### Step 2: 启动 dev 服务器

Run: `pnpm dev`
Expected: Console on :3000, Gateway on :8080

### Step 3: 浏览器验证清单

Open browser and verify:
- [ ] `/` — Chat Home with bot avatar + suggestion cards + composer
- [ ] Sidebar shows: brand + New Chat + nav (Chat/Agents/AgentFlows/Daemons/Settings) + directory-folded chat history + user footer
- [ ] `/directories` — directory management still works
- [ ] `/chats/:id` — breadcrumb + messages + context panel + composer
- [ ] `/daemons` — placeholder page loads
- [ ] `/agents` — existing agents page still works
- [ ] `/flows` — existing flows page still works
- [ ] Sidebar collapse toggle works

### Step 4: Commit if any fixes needed

```bash
git add -A
git commit -m "fix: post-verification adjustments"
```
