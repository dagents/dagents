'use client'

/**
 * useFirstReplyCelebration — fires a one-time toast when the FIRST assistant
 * reply arrives in a chat. The toast text is "🚀 第一个 Agent 回复已收到！".
 *
 * Detection rule: fire only when the session this hook is mounted on STARTED
 * with zero assistant messages and gained its first one while mounted (i.e.
 * the user actually watched the reply stream in). Merely opening an OLD chat
 * that already has replies must not burn the one-shot flag. The persisted key
 * guarantees the celebration never re-fires (navigation, refresh, remount).
 *
 * Usage:
 *   const toast = useToast()
 *   useFirstReplyCelebration(assistantCount, toast.success)
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n'

const FIRST_REPLY_CELEBRATED_KEY = 'dagents_first_reply_celebrated'

export function useFirstReplyCelebration(
  assistantCount: number,
  show: (message: string) => void,
): void {
  const { t } = useI18n()
  // Count observed on first mount of this session — anything above zero means
  // we opened a chat that already had replies (not a first-reply moment).
  const initialCountRef = useRef<number | null>(null)
  if (initialCountRef.current === null) initialCountRef.current = assistantCount
  // Track whether this exact effect instance already fired, so a single mount
  // can never double-toast (e.g. if the count jumps 0 → 2 via a batch append).
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    if (initialCountRef.current !== 0) return // session started with history
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
      show(t('🚀 第一个 Agent 回复已收到！'))
      try {
        localStorage.setItem(FIRST_REPLY_CELEBRATED_KEY, 'true')
      } catch {
        // best-effort — don't crash on a sandboxed storage
      }
    }

    firedRef.current = true
  }, [assistantCount, show, t])
}
