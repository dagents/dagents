'use client'

import { useEffect, useState, useCallback } from 'react'
import { useI18n } from '@/i18n'

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
  const { t } = useI18n()
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

  // Click flips the RENDERED appearance (resolved = stored theme, or the
  // system preference in auto mode), so every click visibly changes the
  // page. The old auto→light→dark→auto cycle had a blind step: an explicit
  // dark with a dark system preference cycling to auto changed nothing
  // visually — the "first click does nothing" report. Auto stays reachable
  // via Shift+click.
  const cycle = useCallback((restoreAuto: boolean) => {
    if (restoreAuto) {
      localStorage.removeItem(THEME_KEY)
      applyTheme('auto')
      setTheme('auto')
      return
    }
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const resolved: 'light' | 'dark' = theme === 'auto' ? (systemDark ? 'dark' : 'light') : theme
    const next = resolved === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
    setTheme(next)
  }, [theme])

  const systemDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved: 'light' | 'dark' = theme === 'auto' ? (systemDark ? 'dark' : 'light') : theme
  const icon = resolved === 'light' ? '☀️' : '🌙'
  const label = theme === 'auto' ? t('跟随系统') : resolved === 'light' ? t('浅色') : t('深色')

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={(e) => cycle(e.shiftKey)}
      title={t('主题：{label}（点击切换 · Shift+点击跟随系统）', { label })}
      aria-label={t('切换主题，当前：{label}', { label })}
      suppressHydrationWarning
    >
      <span className="theme-toggle-icon">{mounted ? icon : '🖥️'}</span>
    </button>
  )
}
