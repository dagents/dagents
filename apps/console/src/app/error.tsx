'use client'

/**
 * 根路由段错误边界（稳定性专项 2026-10-04）：App Router 约定文件——任何
 * 没有自己的 error.tsx 的路由段渲染抛错都会落到这里。根布局（含
 * I18nProvider / ToastProvider）仍然包裹本组件，i18n 可用；样式与
 * error-boundary 组件共用一份 css（显式 import，孤儿 CSS 护栏合规）。
 */

import { useI18n } from '@/i18n'
import '@/components/error-boundary.css'

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className="eb-page" role="alert">
      <h1>{t('页面出了点问题')}</h1>
      <p>{t('渲染这个页面时发生错误。其余界面不受影响，可重试或返回首页。')}</p>
      {error.message ? (
        <pre className="eb-pre">
          {error.message}
          {error.digest ? `\n(digest: ${error.digest})` : ''}
        </pre>
      ) : null}
      <div className="eb-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={reset}>
          {t('重试')}
        </button>
        <a className="btn btn-secondary btn-sm" href="/">
          {t('回到首页')}
        </a>
      </div>
    </div>
  )
}
