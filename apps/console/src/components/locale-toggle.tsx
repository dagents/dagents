'use client'

import { useI18n } from '@/i18n'

/**
 * 中英语言切换（侧栏底部，与主题切换并排）。
 * 点击在 zh-CN / en 间切换；偏好持久化由 I18nProvider 负责。
 */
export function LocaleToggle({ className }: { className?: string }): React.ReactElement {
  const { locale, setLocale } = useI18n()
  const next = locale === 'en' ? 'zh-CN' : 'en'
  return (
    <button
      type="button"
      className={className}
      onClick={() => setLocale(next)}
      title={locale === 'en' ? '切换到中文' : 'Switch to English'}
      aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}
      data-locale={locale}
    >
      {locale === 'en' ? '中' : 'EN'}
    </button>
  )
}
