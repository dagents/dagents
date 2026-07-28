/**
 * useWsChat — subscribe to chat:* frames for a specific chatId.
 *
 * Wraps the singleton `useWsFrame` from `./ws-client` with a chat-scoped
 * filter + lifecycle. Mounting this hook with a non-null `chatId`:
 *   1. Tells the WS hub to start sending frames for that chatId (refcounted
 *      so multiple hooks on the same chatId coalesce into one server frame).
 *   2. Forwards any `chat:message` / `chat:done` / `chat:error` frame to
 *      the supplied `onFrame` callback.
 *   3. On unmount (or chatId change), unsubscribes so the server stops
 *      pushing frames the consumer no longer wants.
 *
 * The hook is intentionally agnostic about how the consumer patches its
 * message list — different views (floating chat vs full-page chat-detail)
 * accumulate tokens differently, so we just hand them the frame and let
 * them decide.
 *
 * Reconnect safety: `useWsFrame` re-arms all subscriptions on socket
 * reopen, so a transient drop while a chat is running recovers without
 * the consumer re-subscribing.
 */
'use client'

import { useEffect } from 'react'
import { useWsFrame, subscribeChat, unsubscribeChat } from './ws-client'
import { isChatFrame, type ChatWsFrame, type ConsoleWsFrame } from '@dagents/contracts'

export interface UseWsChatResult {
  /** True while the underlying socket is OPEN. Consumers should fall back
   *  to polling (e.g. refetch messages) when this is false. */
  connected: boolean
}

/**
 * Subscribe to chat:* frames for `chatId`. Pass `null` to skip subscription
 * (e.g. while the chat is still being created) — the hook becomes inert.
 */
export function useWsChat(
  chatId: string | null,
  onFrame: (frame: ChatWsFrame) => void,
): UseWsChatResult {
  // `useWsFrame` reads its listener through a ref internally, so passing a
  // fresh closure each render is safe — we don't need our own ref dance.
  const handle = (frame: ConsoleWsFrame) => {
    if (!isChatFrame(frame)) return
    if (chatId == null) return
    if (frame.chatId !== chatId) return
    onFrame(frame)
  }

  const { connected } = useWsFrame(handle)

  // Subscribe / unsubscribe on chatId change. The ws-client module owns
  // the actual socket writes + refcount; this effect just registers
  // intent so reconnects know what to re-arm.
  useEffect(() => {
    if (chatId == null) return
    subscribeChat(chatId)
    return () => {
      unsubscribeChat(chatId)
    }
  }, [chatId])

  return { connected }
}
