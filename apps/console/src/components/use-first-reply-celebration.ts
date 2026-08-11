'use client'

/**
 * useFirstReplyCelebration — fires a one-time toast when the FIRST assistant
 * reply arrives in a chat. The toast text is "🚀 第一个 Agent 回复已收到！".
 *
 * Detection rule: trigger exactly once per browser when `assistantCount`
 * transitions from 0 → 1. The persistence key guarantees the celebration
 * never re-fires (e.g. on navigation, refresh, StrictMode remount).
 *
 * Usage:
 *   const toast = useToast()
 *   useFirstReplyCelebration(assistantCount, toast.success)
 *
 * The component owns the assistant-count counter (the chat-detail renderer
 * already derives it from its `messages` array).
 */
import { useEffect, useRef } from 'react'

const FIRST_REPLY_CELEBRATED_KEY = 'dagents_first_reply_celebrated'
const CELEBRATION_MESSAGE = '🚀 第一个 Agent 回复已收到！'

export function useFirstReplyCelebration(
  assistantCount: number,
  show: (message: string) => void,
): void {
  // Track whether this exact effect instance already fired, so a single mount
  // can never double-toast (e.g. if the count jumps 0 → 2 via a batch append).
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    if (assistantCount < 1) return

    let alreadyCelebrated = false
    try {
      alreadyCelebrated =
        localStorage.getItem(FIRST_REPLY_CELEBRATED_KEY) === 'true'
    } catch {
      // localStorage may be unavailable (private mode / SSR) — treat as not
      // celebrated, but skip persistence on the write path below.
    }

    if (!alreadyCelebrated) {
      show(CELEBRATION_MESSAGE)
      try {
        localStorage.setItem(FIRST_REPLY_CELEBRATED_KEY, 'true')
      } catch {
        // best-effort — don't crash on a sandboxed storage
      }
    }

    firedRef.current = true
  }, [assistantCount, show])
}
