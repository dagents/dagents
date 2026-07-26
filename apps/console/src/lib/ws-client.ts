/**
 * Console WebSocket client — `useWsFrame` hook (v0.3-M4.2, architecture §6.8).
 *
 * A single lazily-created `WebSocket` per browser tab fans frames out to every
 * subscribed view. Views subscribe with a callback:
 *
 *   const { connected } = useWsFrame((frame) => { …patch local model… })
 *
 * The hook returns `{ connected }` (a live read of the socket state) so a view
 * can fall back to polling while the socket is down — that is the
 * architecture's "WS 断线回退轮询 fetch" requirement.
 *
 * ## Why a module singleton + `useSyncExternalStore`
 *
 * `useSyncExternalStore` is the React-blessed way to read a value that changes
 * outside React's render cycle (here, the socket's `connected` flag flipping on
 * `open`/`close`). It avoids tearing and the stale-closure trap that a
 * `useState` + `useEffect` pair falls into when the effect's closure captures
 * an old `connected`. The subscription list is a plain module-level array; the
 * store's "version" bumps on every connect/disconnect so React re-renders
 * subscribers, and the `getSnapshot` returns the cached boolean (referentially
 * stable between bumps) so there is no infinite-loop.
 *
 * ## SSR / jsdom safety
 *
 * `new WebSocket` is not available on the server (Next RSC) or under jsdom
 * unless a test installs one. `ensureSocket` guards on `typeof WebSocket`; if
 * absent, the store stays `connected=false` forever and views poll — exactly
 * the WS-down path. The `__testing` export lets a test drive frames + the
 * connected flag without a real socket.
 *
 * ## Reconnect
 *
 * On `close`, a backoff timer (1s → 2s → 4s, capped 4s, reset on a clean
 * `open`) retries. Unbounded reconnect is intentional: agent-detail should
 * recover live status without a page reload. The next `useEffect` re-subscribe
 * (React 18 strict-mode double-invoke, route change) does NOT open a second
 * socket — the singleton dedupes by refcount.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ConsoleWsFrame } from '@dagents/contracts'

/** Public handle returned by `useWsFrame`. */
export interface UseWsFrameResult {
  /** True while the WS socket is OPEN. Views poll while this is false. */
  connected: boolean
}

type FrameListener = (frame: ConsoleWsFrame) => void

// --- module-level singleton store -----------------------------------------

let socket: WebSocket | null = null
let connected = false
let connectVersion = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let refCount = 0

const frameListeners = new Set<FrameListener>()
const storeListeners = new Set<() => void>()

/** WS hub URL. `NEXT_PUBLIC_WS_URL` is inlined by Next at build so the browser
 *  can dial the hub directly (the hub is a platform endpoint, not behind the
 *  Next API route). Defaults to the local gateway's WS surface on :8080. */
function wsUrl(): string {
  return (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080/ws').replace(/\/+$/, '')
}

function notifyStore(): void {
  connectVersion += 1
  for (const l of storeListeners) l()
}

function emitFrame(frame: ConsoleWsFrame): void {
  for (const l of frameListeners) {
    try {
      l(frame)
    } catch {
      // A listener throwing must not break sibling listeners or the socket.
    }
  }
}

function clearReconnect(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(): void {
  clearReconnect()
  // 1s → 2s → 4s, capped at 4s. Reset to 1s on a clean open.
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 4000)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureSocket()
  }, delay)
}

/** Lazily open the singleton socket if one is not already open/connecting. */
function ensureSocket(): void {
  if (socket != null) return
  if (typeof WebSocket === 'undefined') return // SSR / jsdom without a stub
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws
  ws.onopen = () => {
    reconnectAttempt = 0
    connected = true
    notifyStore()
  }
  ws.onclose = () => {
    connected = false
    socket = null
    notifyStore()
    scheduleReconnect()
  }
  ws.onerror = () => {
    // The browser fires `close` after `error`; nothing to do here except let
    // the close handler tear down + schedule a reconnect.
  }
  ws.onmessage = (ev: MessageEvent) => {
    const parsed = parseFrame(ev.data)
    if (parsed != null) emitFrame(parsed)
  }
}

/** Best-effort JSON parse into a `ConsoleWsFrame`; unknown shapes → null. */
function parseFrame(data: unknown): ConsoleWsFrame | null {
  if (typeof data !== 'string') return null
  let obj: unknown
  try {
    obj = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const f = obj as Record<string, unknown>
  if (typeof f.type !== 'string') return null
  // Forward-compat: unknown `type`s are dropped — clients must ignore them.
  return f as unknown as ConsoleWsFrame
}

// --- public store API ------------------------------------------------------

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener)
  return () => storeListeners.delete(listener)
}

function getConnectedSnapshot(): boolean {
  return connected
}

/** Subscribe to every WS frame. The hook keeps the singleton socket alive for
 *  as long as at least one subscriber is mounted. Pass `undefined` to read
 *  `{ connected }` only (e.g. the polling-fallback effect). Returns
 *  `{ connected }` so a view can both react to frames and decide whether to
 *  poll. */
export function useWsFrame(listener?: FrameListener): UseWsFrameResult {
  const ref = useRef(listener)
  ref.current = listener

  useEffect(() => {
    if (ref.current == null) return
    const handler: FrameListener = (frame) => ref.current?.(frame)
    frameListeners.add(handler)
    refCount += 1
    ensureSocket()
    return () => {
      frameListeners.delete(handler)
      refCount -= 1
      if (refCount <= 0) {
        refCount = 0
        clearReconnect()
        if (socket != null) {
          socket.onclose = null
          socket.onopen = null
          socket.onmessage = null
          socket.onerror = null
          try {
            socket.close()
          } catch {
            // already closed
          }
          socket = null
        }
        connected = false
        notifyStore()
      }
    }
  }, [])

  const liveConnected = useSyncExternalStore(
    subscribeStore,
    getConnectedSnapshot,
    getConnectedSnapshot, // SSR snapshot — disconnected, views poll.
  )
  return { connected: liveConnected }
}

// --- test seam -------------------------------------------------------------

/** @internal Test-only entry: push a frame as if the socket delivered it. */
export const __testing = {
  emitFrame(frame: ConsoleWsFrame): void {
    emitFrame(frame)
  },
  setConnected(value: boolean): void {
    connected = value
    notifyStore()
  },
  reset(): void {
    frameListeners.clear()
    storeListeners.clear()
    refCount = 0
    socket = null
    connected = false
    reconnectAttempt = 0
    clearReconnect()
  },
}
