/**
 * Browser-side chat message streaming.
 *
 * Sends a user message to `/api/chats/:id/messages` (which writes the message
 * + decides routing via gateway chat-execute). When the response is mode='stream',
 * subscribes to `/api/chats/:id/stream` to receive the assistant's reply as SSE
 * tokens. When mode='json' (e.g. @-command ack or routing error), returns the
 * payload directly without opening a stream.
 *
 * The split mirrors `/api/chat/route.ts`'s old SSE pipe but routes through the
 * new chat model so chat_messages are persisted with the correct chatId.
 */

import { consumeStream, type StreamEvent } from './sse'

export interface SendMessageResult {
  /** The persisted user message. */
  userMessage: {
    id: string
    role: 'user'
    content: string
    createdAt: string
  }
  /** 'stream' = caller should iterate `events`; 'json' = check `payload`/`error`. */
  mode: 'stream' | 'json'
  /** When mode='stream', an async iterator of decoded SSE events. */
  events?: AsyncGenerator<StreamEvent, void, unknown>
  /** When mode='json', the routing payload (e.g. @-command ack). */
  payload?: Record<string, unknown>
  /** When mode='json', an error string if routing failed. */
  error?: string
  /** When a system message was written (e.g. @-command ack), its id. */
  systemMessageId?: string | null
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

interface SendMessageResponse {
  message: {
    id: string
    role: string
    content: string
    createdAt: string
  }
  mode: 'stream' | 'json'
  chatRunId?: string | null
  payload?: Record<string, unknown>
  error?: string
  systemMessageId?: string | null
}

/**
 * Subscribe to a chat's SSE stream (`/api/chats/:id/stream`) and yield typed
 * events. Shared by `sendChatMessage` and the chat view's direct pump: after
 * POSTing a user message to a flow-bound chat, the gateway answers
 * mode='stream' and only executes the flow once this stream is pulled — the
 * chat view consumes it and translates frames into the same handlers the
 * WebSocket path uses.
 */
export async function subscribeChatStream(chatId: string): Promise<AsyncGenerator<StreamEvent, void, unknown>> {
  const streamRes = await fetch(`/api/chats/${encodeURIComponent(chatId)}/stream`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  })
  if (!streamRes.ok || !streamRes.body) {
    const detail = await streamRes.text().catch(() => '')
    throw new Error(`stream subscribe failed (${streamRes.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return consumeStream(streamRes)
}

/**
 * Send a chat message and either subscribe to the SSE stream or return the JSON payload.
 *
 * @param chatId target chat
 * @param content user message text
 * @param opts optional agent/flow overrides + abort signal
 */
export async function sendChatMessage(
  chatId: string,
  content: string,
  opts: { agentIdOverride?: string; flowIdOverride?: string; signal?: AbortSignal } = {},
): Promise<SendMessageResult> {
  const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      role: 'user',
      ...(opts.agentIdOverride ? { agentIdOverride: opts.agentIdOverride } : {}),
      ...(opts.flowIdOverride ? { flowIdOverride: opts.flowIdOverride } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`send message failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const body = (await res.json()) as Envelope<SendMessageResponse>
  if (!body.success || !body.data) {
    throw new Error(`send message failed: ${body.error ?? 'unknown error'}`)
  }

  const data = body.data
  const userMessage = {
    id: data.message.id,
    role: 'user' as const,
    content: data.message.content,
    createdAt: data.message.createdAt,
  }

  if (data.mode === 'stream') {
    // Subscribe to the SSE stream for assistant tokens.
    const events = await subscribeChatStream(chatId)
    return {
      userMessage,
      mode: 'stream',
      events,
    }
  }

  return {
    userMessage,
    mode: 'json',
    payload: data.payload,
    error: data.error,
    systemMessageId: data.systemMessageId ?? null,
  }
}
