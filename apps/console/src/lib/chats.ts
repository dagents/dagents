
import { apiFetch } from '@/lib/api'


export type ChatStatus = 'idle' | 'running' | 'done' | 'failed'
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** 中文状态词条（单一来源）—— t() 的 key，en 词典负责翻译。
 *  此前在 chat-detail / chat-context-panel / chat-nav-sidebar 各有一份拷贝。 */
export const CHAT_STATUS_LABEL: Record<ChatStatus, string> = {
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
}

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


export async function fetchChats(directoryId: string, signal?: AbortSignal): Promise<Chat[]> {
  const data = await apiFetch<{ items: Chat[] }>(`/api/chats?directory_id=${encodeURIComponent(directoryId)}`, { signal }, 'chat list')
  return data.items
}

export async function fetchChat(id: string, signal?: AbortSignal): Promise<Chat> {
  const data = await apiFetch<{ chat: Chat }>(`/api/chats/${encodeURIComponent(id)}`, { signal }, 'chat detail')
  return data.chat
}

export async function createChat(body: {
  directoryId: string
  title: string
  agentId?: string
  flowId?: string
}): Promise<Chat> {
  const data = await apiFetch<{ chat: Chat }>('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'create chat')
  return data.chat
}

export async function updateChat(
  id: string,
  body: { title?: string; status?: ChatStatus; agentId?: string | null; flowId?: string | null },
): Promise<Chat> {
  const data = await apiFetch<{ chat: Chat }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'update chat')
  return data.chat
}

/**
 * Reset a failed chat back to 'idle'. Used by the error-recovery flow
 * before retrying an agent run — clears the `failed` status so the
 * breadcrumb + context panel reflect a clean slate. Idempotent: calling
 * on a non-failed chat is a no-op that still returns the updated chat.
 */
export async function resetChat(chatId: string): Promise<Chat> {
  const data = await apiFetch<{ chat: Chat }>(`/api/chats/${encodeURIComponent(chatId)}/reset`, { method: 'POST' }, 'reset chat')
  return data.chat
}

export async function deleteChat(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch<{ deleted: boolean; id: string }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'delete chat')
}

export async function fetchMessages(chatId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  const data = await apiFetch<{ items: ChatMessage[] }>(`/api/chats/${encodeURIComponent(chatId)}/messages`, { signal }, 'message list')
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
  const data = await apiFetch<{ message: ChatMessage }>(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'create message')
  return data.message
}

/**
 * POST a user message and keep the routing envelope, not just the persisted
 * message. `mode='stream'` means the gateway executes the bound flow only
 * once the caller pulls `GET /api/chats/:id/stream` — the chat view uses this
 * to know it must open the SSE pump (assistant tokens arrive there, not over
 * the WebSocket, for flow-bound chats). `mode='json'` carries @-command acks
 * or routing errors in `payload`/`error`.
 */
export interface RoutedSendResult {
  message: ChatMessage
  mode: 'stream' | 'json'
  chatRunId?: string | null
  payload?: Record<string, unknown>
  error?: string
  systemMessageId?: string | null
}

export async function sendMessageRouted(
  chatId: string,
  body: {
    content: string
    role?: ChatMessageRole
    agentIdOverride?: string
    flowIdOverride?: string
  },
): Promise<RoutedSendResult> {
  const data = await apiFetch<RoutedSendResult>(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', ...body }) }, 'create message')
  return data
}

export interface ChatRun {
  id: string
  status: string
  createdAt: string
  finishedAt: string | null
  durationMs?: number | null
  flowId?: string | null
  flowName?: string | null
}

export async function fetchChatRuns(chatId: string, signal?: AbortSignal): Promise<ChatRun[]> {
  const data = await apiFetch<{ items: ChatRun[] }>(`/api/chats/${encodeURIComponent(chatId)}/runs`, { signal }, 'chat runs')
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
  const data = await apiFetch<{ items: ChatSearchResult[] }>(`/api/chats/search?${params.toString()}`, { signal }, 'chat search')
  return data.items
}
