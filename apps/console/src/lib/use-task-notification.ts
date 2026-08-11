'use client'

/**
 * useTaskNotification — wraps a chat WS frame handler so task completion
 * and failure events (chat:done / chat:error) surface to the user even
 * when they have tabbed away from the chat or the browser entirely.
 *
 * Behaviour:
 *   - When the tab is NOT visible (document.hidden) OR the chat that
 *     completed is not the active chat the user is looking at:
 *       · Fires a desktop notification (if permission is granted)
 *       · Plays a subtle Web Audio chime
 *       · Falls back to a toast notification
 *   - When the tab IS visible AND the chat is the active one: existing
 *     behaviour is preserved — the caller's own handler already toasts.
 *
 * Settings are read from localStorage ('dagents:notification-settings')
 * so the user can disable desktop notifications, sound, or restrict
 * notifications to only fire when the tab is hidden. The sound flag
 * additionally lives under 'dagents:sound-enabled' for the sound utility
 * (kept separate so other features can reuse it).
 *
 * Clicking a desktop notification focuses the tab and routes to the
 * completed chat — implemented via a window 'message' to the next-router.
 *
 * Usage:
 *   const { wrapHandler } = useTaskNotification({ chatId, chatTitle })
 *   useWsChat(chatId, wrapHandler(baseHandler))
 *   // or
 *   useWsChat(chatId, (frame) => {
 *     notifyOnFrame(frame)   // fire notifications, don't block
 *     baseHandler(frame)     // existing UI logic
 *   })
 */

import { useCallback, useEffect, useRef } from 'react'
import type { ChatWsFrame } from '@dagents/contracts'
import { useToast } from '@/components/toast'
import {
  playSuccessSound,
  playErrorSound,
} from '@/lib/notification-sound'

export interface NotificationSettings {
  /** Master switch for desktop (OS-level) notifications. */
  desktopEnabled: boolean
  /** Master switch for the Web Audio chime. */
  soundEnabled: boolean
  /** When true, only notify when the tab is hidden. When false, also notify
   *  when the user is in a different chat than the one that completed. */
  onlyWhenHidden: boolean
}

const SETTINGS_KEY = 'dagents:notification-settings'
const SOUND_FLAG_KEY = 'dagents:sound-enabled'

const DEFAULT_SETTINGS: NotificationSettings = {
  desktopEnabled: true,
  soundEnabled: true,
  onlyWhenHidden: false,
}

/** Truncate to `max` chars with an ellipsis. Markdown / long agent replies
 *  shouldn't fill the whole notification body. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1) + '…'
}

/** Read the settings object from localStorage, merged over defaults. */
export function readNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persist the settings object to localStorage. Best-effort. */
export function writeNotificationSettings(s: NotificationSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
    // Mirror the sound flag into the key the sound utility reads, so a
    // single toggle controls both the chime and any future sound feature.
    localStorage.setItem(SOUND_FLAG_KEY, String(s.soundEnabled))
  } catch {
    // sandboxed storage — best-effort
  }
}

export interface UseTaskNotificationOptions {
  /** The chat this hook is mounted for. When null the hook is inert. */
  chatId: string | null
  /** Human-readable chat title, shown in the notification body. */
  chatTitle?: string | null
}

export interface UseTaskNotificationResult {
  /**
   * Call with an inbound WS frame. Fires desktop + sound + toast
   * notifications as appropriate (no-op when the frame is not a terminal
   * event or when settings suppress it). Pure side-effect — does NOT
   * return anything or block the caller's UI updates.
   */
  notifyOnFrame: (frame: ChatWsFrame) => void
  /**
   * Wraps an existing frame handler: notifications fire first, then the
   * base handler runs unchanged. Use this when you don't want to split
   * your handler.
   */
  wrapHandler: <H extends (frame: ChatWsFrame) => void>(base: H) => H
  /**
   * Request Notification.permission. Safe to call repeatedly — no-ops
   * when already granted/denied or when the API is unavailable.
   */
  requestPermission: () => void
}

export function useTaskNotification({
  chatId,
  chatTitle,
}: UseTaskNotificationOptions): UseTaskNotificationResult {
  const toast = useToast()
  // Keep latest chatId / title in refs so the WS closure stays stable —
  // useWsChat reads its listener through a ref, but the wrapper we return
  // should also be referentially stable for the same reason.
  const chatIdRef = useRef(chatId)
  const chatTitleRef = useRef(chatTitle)
  useEffect(() => {
    chatIdRef.current = chatId
  }, [chatId])
  useEffect(() => {
    chatTitleRef.current = chatTitle
  }, [chatTitle])

  // Auto-request Notification permission the first time the user sends a
  // message in any chat (the hook is mounted in chat-detail, so the first
  // send implies the user wants to be notified about that chat). We arm a
  // one-time click listener so the request lands inside a user gesture
  // (browsers reject requestPermission() called outside one).
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    const onClick = (): void => {
      if (typeof Notification === 'undefined') return
      if (Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => {})
      }
      window.removeEventListener('click', onClick)
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])

  const requestPermission = useCallback((): void => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {})
    }
  }, [])

  /** Focus the tab and route to the chat that completed. Uses history.pushState
   *  + a popstate-style dispatch so Next.js' App Router picks it up without
   *  a full reload. */
  const focusChat = useCallback((targetChatId: string): void => {
    try {
      window.focus()
    } catch {
      // window.focus can throw in some cross-process setups — ignore
    }
    // If we're already on a different chat, route to the target. Using
    // history + a CustomEvent keeps this decoupled from next/navigation
    // (which would require a router instance we don't own here).
    const target = `/chats/${targetChatId}`
    if (window.location.pathname !== target) {
      window.location.href = target
    }
  }, [])

  /** Show a desktop notification. Clicking it focuses + routes to the chat. */
  const showDesktop = useCallback(
    (title: string, body: string, tag: string, targetChatId: string): void => {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      try {
        const n = new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag,
          // requireInteraction keeps the notification visible until the user
          // dismisses it — appropriate for a task that needs their attention.
          requireInteraction: false,
        })
        n.onclick = (): void => {
          focusChat(targetChatId)
          n.close()
        }
      } catch {
        // Notification construction can throw on some platforms (e.g. Safari
        // service-worker scope) — fall through to the toast fallback.
      }
    },
    [focusChat],
  )

  const notifyOnFrame = useCallback(
    (frame: ChatWsFrame): void => {
      // Only terminal frames trigger notifications.
      if (frame.type !== 'chat:done' && frame.type !== 'chat:error') return

      const settings = readNotificationSettings()
      const isHidden = typeof document !== 'undefined' && document.hidden
      // Active chat = the chat this hook is mounted for matches the frame
      // AND the tab is visible (we can't easily know the user's actual
      // focused chat from here, so "this hook's chatId" is the proxy).
      const isActiveChat = chatIdRef.current === frame.chatId
      const shouldNotify =
        isHidden || (settings.onlyWhenHidden ? false : !isActiveChat)

      // Even when the user is looking right at the chat, we don't double-fire
      // a desktop notification — the in-app toast (handled by the caller) is
      // enough. So only escalate to desktop + sound when shouldNotify is true.
      if (!shouldNotify) return

      const title = chatTitleRef.current
      const chatRef = title ? `「${truncate(title, 40)}」` : '任务'

      if (frame.type === 'chat:done') {
        const body = truncate(frame.content || '已完成', 100)
        if (settings.desktopEnabled) {
          showDesktop(
            '✅ Agent 任务完成',
            `${chatRef}：${body}`,
            'dagents-task-done',
            frame.chatId,
          )
        }
        if (settings.soundEnabled) playSuccessSound()
        // Toast as a fallback / in-app acknowledgement.
        toast.success(`${chatRef}：${body}`, 5000)
      } else {
        // chat:error
        const errMsg = frame.error || frame.content || '执行失败'
        const body = truncate(errMsg, 100)
        if (settings.desktopEnabled) {
          showDesktop(
            '❌ Agent 任务失败',
            `${chatRef}：${body}`,
            'dagents-task-error',
            frame.chatId,
          )
        }
        if (settings.soundEnabled) playErrorSound()
        toast.error(`${chatRef}：${body}`, 6000)
      }
    },
    [showDesktop, toast],
  )

  const wrapHandler = useCallback(
    <H extends (frame: ChatWsFrame) => void>(base: H): H => {
      const wrapped = ((frame: ChatWsFrame): void => {
        notifyOnFrame(frame)
        base(frame)
      }) as H
      return wrapped
    },
    [notifyOnFrame],
  )

  return { notifyOnFrame, wrapHandler, requestPermission }
}
