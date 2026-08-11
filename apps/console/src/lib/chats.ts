export type ChatStatus = 'idle' | 'running' | 'done' | 'failed'
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface Chat {
  id: string
  directoryId: string
  title: string
  status: ChatStatus
  agentId: string | null
  flowId: string | null
  lastMessage: string | null
  messageCount: number
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  chatId: string
  role: ChatMessageRole
  content: string
  runId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

export async function fetchChats(directoryId: string, signal?: AbortSignal): Promise<Chat[]> {
  const data = await unwrap<{ items: Chat[] }>(
    await fetch(`/api/chats?directory_id=${encodeURIComponent(directoryId)}`, {
      cache: 'no-store',
      signal,
    }),
    'chat list',
  )
  return data.items
}

export async function fetchChat(id: string, signal?: AbortSignal): Promise<Chat> {
  const data = await unwrap<{ chat: Chat }>(
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { cache: 'no-store', signal }),
    'chat detail',
  )
  return data.chat
}

export async function createChat(body: {
  directoryId: string
  title: string
  agentId?: string
  flowId?: string
}): Promise<Chat> {
  const data = await unwrap<{ chat: Chat }>(
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'create chat',
  )
  return data.chat
}

export async function updateChat(
  id: string,
  body: { title?: string; status?: ChatStatus; agentId?: string | null; flowId?: string | null },
): Promise<Chat> {
  const data = await unwrap<{ chat: Chat }>(
    await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'update chat',
  )
  return data.chat
}

/**
 * Reset a failed chat back to 'idle'. Used by the error-recovery flow
 * before retrying an agent run — clears the `failed` status so the
 * breadcrumb + context panel reflect a clean slate. Idempotent: calling
 * on a non-failed chat is a no-op that still returns the updated chat.
 */
export async function resetChat(chatId: string): Promise<Chat> {
  const data = await unwrap<{ chat: Chat }>(
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/reset`, {
      method: 'POST',
    }),
    'reset chat',
  )
  return data.chat
}

export async function deleteChat(id: string): Promise<{ deleted: boolean; id: string }> {
  return unwrap<{ deleted: boolean; id: string }>(
    await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
    'delete chat',
  )
}

export async function fetchMessages(chatId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  const data = await unwrap<{ items: ChatMessage[] }>(
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      cache: 'no-store',
      signal,
    }),
    'message list',
  )
  return data.items
}

export async function createMessage(
  chatId: string,
  body: {
    role?: ChatMessageRole
    content: string
    runId?: string
    metadata?: Record<string, unknown>
    /** Optional agent id — overrides chat.agentId for this message only. */
    agentIdOverride?: string
    /** Optional flow id — overrides chat.flowId for this message only. */
    flowIdOverride?: string
  },
): Promise<ChatMessage> {
  const data = await unwrap<{ message: ChatMessage }>(
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'create message',
  )
  return data.message
}

export interface ChatRun {
  id: string
  status: string
  createdAt: string
  finishedAt: string | null
}

export async function fetchChatRuns(chatId: string, signal?: AbortSignal): Promise<ChatRun[]> {
  const data = await unwrap<{ items: ChatRun[] }>(
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/runs`, {
      cache: 'no-store',
      signal,
    }),
    'chat runs',
  )
  return data.items
}

/**
 * A single full-text search hit returned by GET /api/v1/chats/search.
 *
 * - snippet: HTML-safe string with the matched substring wrapped in
 *   <mark>…</mark>; safe to render via dangerouslySetInnerHTML.
 * - matchType: whether the hit was in the chat title or a message body.
 * - directoryName: display name of the owning directory (for the dropdown
 *   subtitle); included by the gateway so the client doesn't have to join.
 */
export interface ChatSearchResult {
  chatId: string
  chatTitle: string
  snippet: string
  matchType: 'title' | 'content'
  directoryId: string
  directoryName: string
  createdAt: string
}

/**
 * Full-text search across chat titles and message content.
 *
 * @param query non-empty search string (gateway rejects empty with 400)
 * @param directoryId optional scope — if provided, only chats in this
 *   directory are searched; otherwise all directories are searched.
 * @param signal optional AbortSignal to cancel the in-flight request
 *   (used by the debounced search dropdown so stale queries don't land).
 */
export async function searchChats(
  query: string,
  directoryId?: string,
  signal?: AbortSignal,
): Promise<ChatSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: '20' })
  if (directoryId) params.set('directory_id', directoryId)
  const data = await unwrap<{ items: ChatSearchResult[] }>(
    await fetch(`/api/chats/search?${params.toString()}`, {
      cache: 'no-store',
      signal,
    }),
    'chat search',
  )
  return data.items
}
