'use client'

import { useEffect, useState, useCallback } from 'react'

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

export function ThemeToggle(): React.ReactElement {
  const [theme, setTheme] = useState<Theme>('auto')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = getStoredTheme()
    setTheme(stored)
    applyTheme(stored)
    setMounted(true)

    // Listen for system changes when in auto mode
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (getStoredTheme() === 'auto') applyTheme('auto')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'auto' ? 'light' : prev === 'light' ? 'dark' : 'auto'
      if (next === 'auto') {
        localStorage.removeItem(THEME_KEY)
      } else {
        localStorage.setItem(THEME_KEY, next)
      }
      applyTheme(next)
      return next
    })
  }, [])

  const icon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️'
  const label = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      title={`主题：${label}（点击切换）`}
      aria-label={`切换主题，当前：${label}`}
      suppressHydrationWarning
    >
      <span className="theme-toggle-icon">{mounted ? icon : '🖥️'}</span>
    </button>
  )
}
