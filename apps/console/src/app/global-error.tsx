'use client'

/**
 * 全局错误边界（稳定性专项 2026-10-04）：App Router 约定文件——根布局
 * 自身抛错时的最后防线。本组件替换整个 html 树（含 I18nProvider 等
 * 全局 providers），因此必须自带 <html>/<body>、不得依赖任何 provider；
 * 双语直排。样式 import 自带的 error-boundary.css（随本模块独立打包，
 * 不赌全局样式系统还活着）。
 */

import '@/components/error-boundary.css'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body className="eb-global-body">
        <div className="eb-global-card" role="alert">
          <h1>应用发生严重错误 · A fatal error occurred</h1>
          <p>
            渲染崩溃已到达最外层边界。可尝试重试；若持续出现请刷新页面或查看网关日志。
            <br />
            The render crash reached the outermost boundary. Retry, or reload the page if it
            persists.
          </p>
          {error.message ? (
            <pre className="eb-pre">
              {error.message}
              {error.digest ? `\n(digest: ${error.digest})` : ''}
            </pre>
          ) : null}
          <div className="eb-actions">
            <button type="button" className="eb-btn" onClick={reset}>
              重试 · Retry
            </button>
            <a className="eb-btn" href="/">
              回到首页 · Home
            </a>
          </div>
        </div>
      </body>
    </html>
  )
}
