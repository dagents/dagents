'use client'

/**
 * KeyboardShortcuts — modal overlay showing all keyboard shortcuts.
 *
 * Opens when the user presses `?` (Shift+/) anywhere in the app.
 * Also accessible via a button in the navbar's search hint.
 *
 * Shortcuts:
 *   ⌘K  — Command Palette (search + navigate)
 *   ?   — This help dialog
 *   N   — New chat (when not in an input)
 *   G A — Go to Agents
 *   G F — Go to Flows
 *   G D — Go to Daemons
 *   G S — Go to Settings
 *   G H — Go to Home
 */

import { useEffect, useState } from 'react'
import '@/styles/shortcuts.css'

interface ShortcutDef {
  keys: string
  action: string
  group: string
}

const SHORTCUTS: readonly ShortcutDef[] = [
  { keys: '⌘K', action: '搜索和导航（命令面板）', group: '全局' },
  { keys: '?', action: '显示快捷键帮助', group: '全局' },
  { keys: 'Esc', action: '关闭弹窗 / 菜单', group: '全局' },
  { keys: 'N', action: '新建对话', group: '操作' },
  { keys: '⏎', action: '发送消息', group: '对话' },
  { keys: '⇧⏎', action: '换行（不发送）', group: '对话' },
  { keys: '@', action: '触发命令菜单', group: '对话' },
  { keys: 'G H', action: '前往首页', group: '导航' },
  { keys: 'G A', action: '前往 Agent', group: '导航' },
  { keys: 'G F', action: '前往 Flow', group: '导航' },
  { keys: 'G D', action: '前往 Daemon', group: '导航' },
  { keys: 'G S', action: '前往设置', group: '导航' },
] as const

const GROUPS = ['全局', '操作', '对话', '导航'] as const

export function KeyboardShortcuts(): React.ReactElement | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Open on `?` (Shift+/)
      if (e.key === '?' && !isInputFocused(e.target)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
      // Close on Escape
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div
      className="shortcuts-overlay"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-label="键盘快捷键"
    >
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <span className="shortcuts-title">键盘快捷键</span>
          <button type="button" className="shortcuts-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <div key={group} className="shortcuts-group">
              <div className="shortcuts-group-title">{group}</div>
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.keys} className="shortcuts-row">
                  <span className="shortcuts-action">{s.action}</span>
                  <kbd className="shortcuts-key">{s.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcuts-footer">
          按 <kbd className="shortcuts-key">?</kbd> 随时打开此面板
        </div>
      </div>
    </div>
  )
}

function isInputFocused(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}
