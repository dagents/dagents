'use client'

/**
 * OnboardingCompleteBanner — celebratory prompt shown once on the chat home
 * when all 4 onboarding steps are complete. Guides the user to send their
 * first message by focusing the chat composer input.
 *
 * Behavior:
 *   - Renders only when `complete` is true AND the user hasn't dismissed it.
 *   - The CTA focuses the composer's <textarea> via the documented selector
 *     `[aria-label="消息输入框"]` (see ChatComposer).
 *   - Dismissal persists to localStorage under ONBOARDING_DONE_DISMISS_KEY so
 *     the banner never re-surfaces — the existing OnboardingChecklist's
 *     completion badge still indicates "环境就绪".
 */
import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import '@/styles/onboarding-flow.css'

const ONBOARDING_DONE_DISMISS_KEY = 'dagents_onboarding_dismissed'

interface OnboardingCompleteBannerProps {
  /** True when all 4 onboarding steps are complete. */
  complete: boolean
}

function focusComposer(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="消息输入框"]',
  )
  if (textarea) {
    textarea.focus()
    // Place the caret at the end so typing starts fresh.
    const end = textarea.value.length
    textarea.setSelectionRange(end, end)
    // The composer auto-resizes on input; trigger a synthetic input so any
    // prefilled text (from suggestion cards) re-flows correctly.
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

export function OnboardingCompleteBanner({
  complete,
}: OnboardingCompleteBannerProps): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(true)

  // Read the dismiss flag once on mount (avoids SSR/hydration mismatch —
  // localStorage is only available in the browser).
  useEffect(() => {
    setDismissed(localStorage.getItem(ONBOARDING_DONE_DISMISS_KEY) === 'true')
  }, [])

  const handleStart = useCallback(() => {
    localStorage.setItem(ONBOARDING_DONE_DISMISS_KEY, 'true')
    setDismissed(true)
    focusComposer()
  }, [])

  const handleDismiss = useCallback(() => {
    localStorage.setItem(ONBOARDING_DONE_DISMISS_KEY, 'true')
    setDismissed(true)
  }, [])

  if (!complete || dismissed) return null

  return (
    <div
      className="onboarding-done-banner enter-rise"
      style={{ '--enter-i': 0 } as React.CSSProperties}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="onboarding-done-banner-dismiss"
        onClick={handleDismiss}
        aria-label="关闭"
      >
        ×
      </button>
      <div className="onboarding-done-banner-body">
        <div className="onboarding-done-banner-emoji" aria-hidden="true">🎉</div>
        <div className="onboarding-done-banner-text">
          <span className="onboarding-done-banner-title">
            一切就绪！试试发送你的第一条消息吧
          </span>
          <span className="onboarding-done-banner-sub">
            Agent 已就绪，输入指令即可开始对话。
          </span>
        </div>
      </div>
      <button
        type="button"
        className="onboarding-done-banner-cta"
        onClick={handleStart}
      >
        <Icon name="chat" style={{ width: 14, height: 14 }} />
        <span>开始对话</span>
      </button>
    </div>
  )
}
