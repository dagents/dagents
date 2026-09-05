'use client'

import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/app-nav.css'

/**
 * 中英语言切换（侧栏底部，与主题切换并排）。
 * 点击在 zh-CN / en 间切换；偏好持久化由 I18nProvider 负责。
 * PX-GL07：线性 globe 图标 16px 与 ThemeToggle 同族；切换瞬间给 <html>
 * 挂 .locale-switching（app-nav.css：body 100ms 透明微过渡）掩住全站
 * 文案跳变，~160ms 后摘除。
 */
export function LocaleToggle({ className }: { className?: string }): React.ReactElement {
  const { locale, setLocale } = useI18n()
  const next = locale === 'en' ? 'zh-CN' : 'en'
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (typeof document !== 'undefined') {
          const root = document.documentElement
          root.classList.add('locale-switching')
          window.setTimeout(() => root.classList.remove('locale-switching'), 160)
        }
        setLocale(next)
      }}
      title={locale === 'en' ? '切换到中文' : 'Switch to English'}
      aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}
      data-locale={locale}
    >
      <Icon name="globe" style={{ width: 16, height: 16 }} />
      {locale === 'en' ? '中' : 'EN'}
    </button>
  )
}
