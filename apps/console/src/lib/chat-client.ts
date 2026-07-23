/**
 * Browser-side chat client (P1.10.T2).
 *
 * Sends a user message to the console's own `/api/chat` route proxy (which
 * forwards to the gateway → Flowise with `streaming: true`) and yields the
 * parsed SSE events as they arrive. Keeping this in a small module (rather
 * than inline in the component) makes the streaming logic testable and lets
 * the component focus on rendering.
 *
 * The run id is generated client-side (crypto.randomUUID) and sent as a header
 * so it is available before the first token; the gateway also generates one
 * if absent, but sending it here means the same id appears in the chat
 * inspector and in gateway/Flowise traces.
 */

import { consumeStream, type StreamEvent } from './sse'

export interface SendChatParams {
  flowId: string
  question: string
  /** Flowise session id — pass the chat's sessionId to continue a conversation. */
  sessionId?: string
  /** Optional caller-supplied run id; generated if absent. */
  runId?: string
  /** Bearer token forwarded to the gateway (caller's sk- key), if authed. */
  authorization?: string
  /**
   * Abort the in-flight request. When aborted, the returned promise rejects
   * with a `DOMException` (name `'AbortError'`) and the event generator stops
   * — the caller should treat that as a user-initiated stop, not an error.
   */
  signal?: AbortSignal
}

export interface ChatStreamResult {
  runId: string
  events: AsyncGenerator<StreamEvent, void, unknown>
}

/**
 * POST a prediction and return an async iterator of decoded events. Throws on
 * a non-2xx from the proxy (the proxy itself collapses upstream 5xx to 502).
 */
export async function streamChat(params: SendChatParams): Promise<ChatStreamResult> {
  const runId = params.runId ?? crypto.randomUUID()

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-run-id': runId,
      ...(params.authorization ? { authorization: `Bearer ${params.authorization}` } : {}),
    },
    body: JSON.stringify({
      flowId: params.flowId,
      question: params.question,
      sessionId: params.sessionId,
      streaming: true,
    }),
    // Forward the caller's AbortSignal so a user-initiated stop actually tears
    // down the fetch — without it, the reader keeps pulling tokens after the
    // UI has flipped back to "send".
    ...(params.signal ? { signal: params.signal } : {}),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`chat request failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  return { runId, events: consumeStream(res) }
}
