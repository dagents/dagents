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
 * PX-C08 containment contract:
 *   - The celebration is a corner toast (never a full-screen canvas/particle
 *     overlay) and runs for 1.5s — a nod, not a show.
 *   - prefers-reduced-motion: skipped ENTIRELY on the JS side. There is no
 *     JS-driven particle/canvas animation today, but this guard also keeps
 *     any future one honest — under reduce we celebrate nothing, we only
 *     persist the one-shot flag so reduced-motion users never see it later
 *     either.
 *
 * Usage:
 *   const toast = useToast()
 *   useFirstReplyCelebration(assistantCount, toast.success)
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n'

const FIRST_REPLY_CELEBRATED_KEY = 'dagents_first_reply_celebrated'

/** Celebration duration (PX-C08): 1.5s — brief by design. */
const CELEBRATION_DURATION_MS = 1500

export function useFirstReplyCelebration(
  assistantCount: number,
  show: (message: string, opts?: { duration?: number }) => void,
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
      // JS-side reduced-motion gate (PX-C08): the celebration is skipped
      // outright — the toast itself is static information, but "celebrate"
      // is inherently motion-flavoured; under reduce we stay quiet.
      const prefersReduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!prefersReduced) {
        show(t('🚀 第一个 Agent 回复已收到！'), { duration: CELEBRATION_DURATION_MS })
      }
      try {
        localStorage.setItem(FIRST_REPLY_CELEBRATED_KEY, 'true')
      } catch {
        // best-effort — don't crash on a sandboxed storage
      }
    }

    firedRef.current = true
  }, [assistantCount, show, t])
}
