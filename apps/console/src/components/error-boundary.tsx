'use client'

/**
 * ErrorBoundary —— 可复用的局部错误边界（稳定性专项 2026-10-04）。
 *
 * 背景：console 全仓此前没有任何 React 错误边界——画布 / 结果面板 / 轨迹
 * 视图任何一处渲染抛错就是整页白屏，只能刷新。本组件给关键区域一个
 * 「塌成错误卡、周围照常」的降级面。
 *
 * 样式走同目录 error-boundary.css（孤儿 CSS 护栏要求显式 import；内联
 * style 棘轮禁止新开内联样式口子），降级时仍有可见的卡片形态。
 */

import { Component, type ReactNode } from 'react'
import { useI18n } from '@/i18n'
import './error-boundary.css'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 客户端调用方的自定义兜底（拿到 error 与 reset）；省略 = 默认错误卡。 */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** 兜底卡标题（默认「此区域渲染出错」）。 */
  title?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
      return (
        <DefaultFallback error={this.state.error} reset={this.reset} title={this.props.title} />
      )
    }
    return this.props.children
  }
}

function DefaultFallback({
  error,
  reset,
  title,
}: {
  error: Error
  reset: () => void
  title?: string
}): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className="eb-card" role="alert">
      <div className="eb-title">{title ?? t('此区域渲染出错')}</div>
      <div className="eb-detail">{error.message || String(error)}</div>
      <div className="eb-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
          {t('重试')}
        </button>
      </div>
    </div>
  )
}
