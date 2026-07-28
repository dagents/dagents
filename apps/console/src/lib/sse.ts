/**
 * SSE stream parsing for prediction streams.
 *
 * The gateway streams predictions as Server-Sent Events. Each frame is:
 *
 *   message:\n
 *   data:<json>\n\n
 *
 * where `<json>` is `{"event": "<type>", "data": <payload>}`. This module
 * turns that byte stream into a typed async iterator of `StreamEvent`s so
 * the chat view (and any future consumer) doesn't reimplement the framing.
 *
 * Non-normative frames we deliberately ignore at the chat layer:
 * `agentReasoning`, `sourceDocuments`, `usedTools`, `calledTools`,
 * `fileAnnotations`, `artifacts`, `tts_*`, `action`, `agentFlow*`. They are
 * surfaced as `custom` so a richer view can still see them; the basic chat
 * view only consumes `metadata`, `token`, and `error`. `end` carries the
 * literal `[DONE]` sentinel.
 *
 * Heartbeat comment lines (`:heartbeat\n\n`) and stray comments are ignored.
 * `data:` payloads are JSON; the rare non-JSON `data:` line (e.g. the raw
 * `[DONE]` some paths emit without the event envelope) falls back to a string
 * payload.
 */

export type StreamEvent =
  | { event: 'start'; data: string }
  | { event: 'token'; data: string }
  | { event: 'thinking'; data: string; duration?: number }
  | { event: 'metadata'; data: Record<string, unknown> }
  | { event: 'end'; data: '[DONE]' }
  | { event: 'error'; data: string }
  | { event: 'sourceDocuments'; data: unknown }
  | { event: 'usedTools'; data: unknown }
  | { event: 'calledTools'; data: unknown }
  | { event: 'fileAnnotations'; data: unknown }
  | { event: 'artifacts'; data: unknown }
  | { event: 'agentReasoning'; data: unknown }
  | { event: 'action'; data: unknown }
  | { event: 'nextAgent'; data: unknown }
  | { event: 'abort'; data: string }
  | { event: 'custom'; rawEvent: string; data: unknown }

/** Metadata payload sent once at the start of a streamed prediction. */
export interface PredictionMetadata {
  chatId?: string
  chatMessageId?: string
  question?: string
  sessionId?: string
  memoryType?: string
  followUpPrompts?: unknown
  flowVariables?: unknown
  action?: unknown
}

/**
 * Parse one SSE frame's `data:` payload into a typed `StreamEvent`.
 *
 * Payloads are always wrapped as `{ event, data }`, so we expect that shape.
 * A non-object JSON value (e.g. a bare `[DONE]`) degrades to `custom` with the
 * raw string — callers that only care about `token`/`metadata`/`error`/`end`
 * can ignore it.
 */
export function parseFrame(dataLine: string): StreamEvent | null {
  if (!dataLine) return null

  const raw = dataLine.startsWith('data:') ? dataLine.slice(5) : dataLine
  const trimmed = raw.trimStart()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // The `end` path writes `data:[DONE]` inside the envelope, but a few
    // integrations emit a bare `[DONE]`. Surface it as `end` either way.
    if (trimmed === '[DONE]') return { event: 'end', data: '[DONE]' }
    return { event: 'custom', rawEvent: 'raw', data: trimmed }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { event: 'custom', rawEvent: 'raw', data: parsed }
  }

  const obj = parsed as { event?: unknown; data?: unknown; duration?: unknown }
  const eventName = typeof obj.event === 'string' ? obj.event : 'custom'

  switch (eventName) {
    case 'start':
      return { event: 'start', data: typeof obj.data === 'string' ? obj.data : String(obj.data ?? '') }
    case 'token':
      return { event: 'token', data: typeof obj.data === 'string' ? obj.data : String(obj.data ?? '') }
    case 'thinking':
      return {
        event: 'thinking',
        data: typeof obj.data === 'string' ? obj.data : String(obj.data ?? ''),
        duration: typeof obj.duration === 'number' ? obj.duration : undefined,
      }
    case 'metadata':
      return { event: 'metadata', data: (obj.data ?? {}) as Record<string, unknown> }
    case 'end':
      return { event: 'end', data: '[DONE]' }
    case 'error':
      return { event: 'error', data: typeof obj.data === 'string' ? obj.data : String(obj.data ?? '') }
    case 'sourceDocuments':
    case 'usedTools':
    case 'calledTools':
    case 'fileAnnotations':
    case 'artifacts':
    case 'agentReasoning':
    case 'action':
    case 'nextAgent':
      return { event: eventName, data: obj.data }
    case 'abort':
      return { event: 'abort', data: typeof obj.data === 'string' ? obj.data : String(obj.data ?? '') }
    default:
      return { event: 'custom', rawEvent: eventName, data: obj.data }
  }
}

/**
 * Drive an SSE `Response`/`ReadableStream<Uint8Array>` to completion, yielding
 * typed events. Used by the chat view against the `/api/chat` route proxy.
 *
 * The function is transport-agnostic: pass anything `getReader()` works on
 * (a `fetch().body` web stream, a `Response` in a route handler, …). It
 * buffers bytes, splits on `\n\n` frame boundaries, and within each frame
 * reads the `data:` line — matching the standard `message:\ndata:<json>\n\n`
 * framing. Comment/heartbeat lines (`:heartbeat`) and the `message:` event
 * label are ignored.
 */
export async function* consumeStream(
  stream: ReadableStream<Uint8Array> | Response,
): AsyncGenerator<StreamEvent, void, unknown> {
  const body = stream instanceof Response ? stream.body : stream
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on frame boundary. Keep the trailing partial frame in `buffer`.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const ev = parseFrameFromBlock(frame)
        if (ev) yield ev
      }
    }
    // Flush any trailing frame without a final blank line.
    const tail = buffer.trim()
    if (tail) {
      const ev = parseFrameFromBlock(tail)
      if (ev) yield ev
    }
  } finally {
    reader.releaseLock()
  }
}

/** Read the `data:` line out of one raw SSE frame block. */
function parseFrameFromBlock(block: string): StreamEvent | null {
  const lines = block.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Comment / heartbeat / event-label lines are not data.
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('message:')) continue
    if (trimmed.startsWith('data:')) {
      return parseFrame(trimmed)
    }
  }
  return null
}
