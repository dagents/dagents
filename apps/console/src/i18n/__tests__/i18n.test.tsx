import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { I18nProvider, useI18n, LOCALE_STORAGE_KEY } from '@/i18n'
import { en } from '@/i18n/en'

/** 探针组件：把 t 的行为暴露到 DOM 里断言。 */
function Probe(): React.ReactElement {
  const { t, locale, setLocale } = useI18n()
  return (
    <div>
      <span data-testid="plain">{t('新建对话')}</span>
      <span data-testid="missing">{t('词典里没有的句子')}</span>
      <span data-testid="params">{t('{n} 步骤', { n: 42 })}</span>
      <span data-testid="locale">{locale}</span>
      <button type="button" onClick={() => setLocale('en')}>switch</button>
    </div>
  )
}

describe('useI18n / I18nProvider', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.lang = 'zh-CN'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    window.localStorage.clear()
  })

  it('zh 默认：t() 返回 key 本身（与迁移前 UI 零差异）', () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(screen.getByTestId('plain').textContent).toBe('新建对话')
    expect(screen.getByTestId('missing').textContent).toBe('词典里没有的句子')
    expect(screen.getByTestId('params').textContent).toBe('42 步骤')
    expect(screen.getByTestId('locale').textContent).toBe('zh-CN')
  })

  it('切换到 en：t() 查词典，缺项回退中文', async () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    await act(async () => {
      screen.getByText('switch').click()
    })
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('plain').textContent).toBe(en['新建对话'])
    // 缺项回退 key（中文），不出现 key 泄漏占位符
    expect(screen.getByTestId('missing').textContent).toBe('词典里没有的句子')
    // 参数插值在英文词条下同样生效
    expect(screen.getByTestId('params').textContent).toBe('42 steps')
    // 偏好持久化 + <html lang> 同步
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('挂载时读取 localStorage 里保存的偏好', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    render(<I18nProvider><Probe /></I18nProvider>)
    // 首帧仍 zh（SSR 一致），effect 后切 en
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('plain').textContent).toBe(en['新建对话'])
  })
})

describe('词典健康检查', () => {
  it('所有词条 value 均为非空字符串', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, `key=${k}`).toBe('string')
      expect(v.length, `key=${k}`).toBeGreaterThan(0)
    }
  })

  it('带占位符的 key 与译文占位符一致', () => {
    const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',')
    for (const [k, v] of Object.entries(en)) {
      if (/{[a-zA-Z]+\}/.test(k)) {
        expect(ph(v), `key=${k}`).toBe(ph(k))
      }
    }
  })
})
