'use client'

/**
 * Toast notification system — global feedback layer.
 *
 * Provides a ToastProvider context + useToast() hook. Any component can
 * call `toast.success('...')` / `toast.error('...')` to surface a
 * transient notification in the bottom-right corner.
 *
 * Features:
 *   - Auto-dismiss after 4s (configurable)
 *   - Manual dismiss via × button
 *   - Stacked layout (max 5 visible)
 *   - Slide-in/out animation with reduced-motion fallback
 *   - ARIA live region for screen readers
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@/components/icon'
import '@/styles/toast.css'
import { useI18n } from '@/i18n'

type ToastKind = 'success' | 'error' | 'info' | 'warning'

/** 可选动作按钮（如 @workflow 生成完成的「去画布」直达）。 */
export interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  duration: number
  action?: ToastAction
}

interface ToastAPI {
  show: (message: string, kind?: ToastKind, duration?: number, action?: ToastAction) => void
  success: (message: string, opts?: { duration?: number; action?: ToastAction }) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  warning: (message: string, duration?: number) => void
}

const ToastContext = createContext<ToastAPI | null>(null)

export function useToast(): ToastAPI {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Return a no-op API when used outside provider — prevents crashes
    return {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    }
  }
  return ctx
}

const MAX_VISIBLE = 5

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const { t } = useI18n()
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((message: string, kind: ToastKind = 'info', duration = 4000, action?: ToastAction) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => {
      const next = [...prev, { id, kind, message, duration, action }]
      // Keep only the most recent MAX_VISIBLE toasts
      return next.slice(-MAX_VISIBLE)
    })
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration)
    }
  }, [dismiss])

  // Stable identity across renders — consumers that put `toast.x` in effect
  // deps (e.g. first-reply celebration) would otherwise re-run every frame.
  // success 的第二参为对象形状（带 action 时 duration 也要更长，捆绑传递）。
  const api: ToastAPI = useMemo(() => ({
    show,
    success: (msg: string, opts?: { duration?: number; action?: ToastAction }) =>
      show(msg, 'success', opts?.duration ?? (opts?.action ? 8000 : 4000), opts?.action),
    error: (msg: string, d?: number) => show(msg, 'error', d ?? 6000),
    info: (msg: string, d?: number) => show(msg, 'info', d),
    warning: (msg: string, d?: number) => show(msg, 'warning', d),
  }), [show])

  const iconMap: Record<ToastKind, 'check' | 'alertTriangle' | 'info' | 'alertCircle'> = {
    success: 'check',
    error: 'alertTriangle',
    info: 'info',
    warning: 'alertCircle',
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Toast container — fixed bottom-right, above all other content */}
      <div className="toast-container" role="region" aria-label={t('通知')} aria-live="polite">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`toast-item toast-${item.kind} toast-enter${item.duration > 0 ? ' has-progress' : ''}`}
            style={item.duration > 0 ? ({ '--toast-dur': `${item.duration}ms` } as React.CSSProperties) : undefined}
          >
            <div className="toast-icon">
              <Icon name={iconMap[item.kind]} style={{ width: 14, height: 14 }} />
            </div>
            <span className="toast-message">{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className="btn btn-primary btn-sm toast-action"
                onClick={() => {
                  item.action?.onClick()
                  dismiss(item.id)
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismiss(item.id)}
              aria-label={t('关闭通知')}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
