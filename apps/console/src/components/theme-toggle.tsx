'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import '@/styles/settings.css'

/**
 * 主题设置（2026-09-06 裁决：明暗切换从侧栏底部移入设置页）。
 * 三态分段控件：浅色 / 深色 / 跟随系统 —— 替代原侧栏按钮的「点击翻转 +
 * Shift 跟随系统」隐式循环（设置页形态下三态显式可选，不再需要 Shift 暗道）。
 * 持久化与 <html data-theme> 应用逻辑不变（dagents-theme，layout.tsx 启动
 * 前置应用），设置页只改写存储并即时 applyTheme。
 */

type Theme = 'light' | 'dark' | 'auto'

const THEME_KEY = 'dagents-theme'

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'auto'
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'auto'
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'auto') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

export function ThemeSettingControl(): React.ReactElement {
  const { t } = useI18n()
  const [theme, setTheme] = useState<Theme>('auto')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setTheme(getStoredTheme())
    setMounted(true)
  }, [])

  const pick = (next: Theme) => {
    if (next === 'auto') {
      localStorage.removeItem(THEME_KEY)
    } else {
      localStorage.setItem(THEME_KEY, next)
    }
    applyTheme(next)
    setTheme(next)
  }

  const options: Array<{ id: Theme; label: string }> = [
    { id: 'light', label: t('浅色') },
    { id: 'dark', label: t('深色') },
    { id: 'auto', label: t('跟随系统') },
  ]

  return (
    <div className="settings-seg" role="radiogroup" aria-label={t('主题')} suppressHydrationWarning>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={mounted && theme === o.id}
          className={`settings-seg-btn${mounted && theme === o.id ? ' active' : ''}`}
          onClick={() => pick(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
