'use client'

/**
 * 轻量级中英双语 i18n（自然键方案）。
 *
 * 设计：以现有中文文案作为词典 key（gettext 风格），`en` 词典提供
 * 中文 → 英文映射。t('新建对话') 在 zh-CN 下返回 key 本身（与迁移前
 * 完全一致），在 en 下查词典；词典缺项自动回退中文 —— 部分迁移不会
 * 让页面出现 key 泄漏。参数用 {name} 占位符。
 *
 * 语言偏好持久化在 localStorage（dagents.locale），初始渲染固定
 * zh-CN 与 SSR 一致，挂载后再切换，避免 hydration mismatch。
 * 本组件是本机模式工作台（无 SEO诉求），故不做 /[locale] 路由段。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { en } from './en'
import { zh } from './zh'

export type Locale = 'zh-CN' | 'en'

export const LOCALE_STORAGE_KEY = 'dagents.locale'

type Dict = Record<string, string>

// zh-CN 词典只收录英文源词条（Agent/Flow/Daemon 等）；中文源文案的 key
// 即译文，直接回退 key 本身。
const DICTS: Record<Locale, Dict> = { 'zh-CN': zh, en }

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  setLocale: () => {},
})

export function I18nProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [locale, setLocaleState] = useState<Locale>('zh-CN')

  // 挂载后读偏好（SSR/首帧仍为 zh-CN，与服务端渲染一致）
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      if (saved === 'en' || saved === 'zh-CN') setLocaleState(saved)
    } catch {
      // localStorage 不可用（隐私模式等）— 保持默认
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // 持久化失败不影响本次会话
    }
    document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'
  }, [])

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue & {
  t: (key: string, params?: Record<string, string | number>) => string
} {
  const { locale, setLocale } = useContext(I18nContext)
  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let s = DICTS[locale][key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.replaceAll(`{${k}}`, String(v))
        }
      }
      return s
    },
    [locale],
  )
  return { t, locale, setLocale }
}
