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

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Icon } from '@/components/icon'
import '@/styles/toast.css'

type ToastKind = 'success' | 'error' | 'info' | 'warning'

interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  duration: number
}

interface ToastAPI {
  show: (message: string, kind?: ToastKind, duration?: number) => void
  success: (message: string, duration?: number) => void
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
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((message: string, kind: ToastKind = 'info', duration = 4000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => {
      const next = [...prev, { id, kind, message, duration }]
      // Keep only the most recent MAX_VISIBLE toasts
      return next.slice(-MAX_VISIBLE)
    })
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration)
    }
  }, [dismiss])

  const api: ToastAPI = {
    show,
    success: (msg, d) => show(msg, 'success', d),
    error: (msg, d) => show(msg, 'error', d ?? 6000),
    info: (msg, d) => show(msg, 'info', d),
    warning: (msg, d) => show(msg, 'warning', d),
  }

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
      <div className="toast-container" role="region" aria-label="通知" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast-item toast-${t.kind} toast-enter`}>
            <div className="toast-icon">
              <Icon name={iconMap[t.kind]} style={{ width: 14, height: 14 }} />
            </div>
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismiss(t.id)}
              aria-label="关闭通知"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
