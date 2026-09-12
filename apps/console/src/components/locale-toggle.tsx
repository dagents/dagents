'use client'

import { useI18n } from '@/i18n'
import '@/styles/settings.css'

/**
 * 语言设置（2026-09-06 裁决：语言切换从侧栏底部移入设置页）。
 * 分段控件：中文 / English —— 切换逻辑与偏好持久化（I18nProvider 的
 * dagents.locale）不变；切换瞬间给 <html> 挂 .locale-switching（100ms
 * 透明微过渡）掩住全站文案跳变。
 */
export function LocaleSettingControl(): React.ReactElement {
  const { locale, setLocale } = useI18n()
  const options: Array<{ id: 'zh-CN' | 'en'; label: string }> = [
    { id: 'zh-CN', label: '中文' },
    { id: 'en', label: 'English' },
  ]

  return (
    <div className="settings-seg" role="radiogroup" aria-label={locale === 'en' ? 'Language' : '语言'}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={locale === o.id}
          className={`settings-seg-btn${locale === o.id ? ' active' : ''}`}
          onClick={() => {
            if (locale === o.id) return
            if (typeof document !== 'undefined') {
              const root = document.documentElement
              root.classList.add('locale-switching')
              window.setTimeout(() => root.classList.remove('locale-switching'), 160)
            }
            setLocale(o.id)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
