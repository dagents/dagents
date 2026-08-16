import type { IServerSideEventStreamer, StreamEvent } from '../types/stream.js'

/**
 * SSE streamer — a live, back-pressure-friendly event queue.
 *
 * The executor creates one streamer per flow run. Nodes call `streamTokenEvent`
 * to push tokens; the HTTP route returns `toReadableStream()` as the response
 * body. Events pushed BEFORE the stream is attached are buffered (and stay
 * readable via `drain()` for tests); events pushed AFTER attachment are
 * enqueued to the live stream immediately, so tokens reach the client while
 * the flow is still executing. The stream closes itself when an `end` or
 * `error` event is pushed — routes only need to ensure one of those is
 * eventually emitted.
 *
 * Wire framing (per frame):
 *
 *   event: <type>\n
 *   data: {"event":"<type>","data":<payload>}\n\n
 *
 * The `event:` line keeps standard SSE clients (EventSource) working, while
 * the `data:` line carries the JSON envelope `apps/console/src/lib/sse.ts`
 * expects — its parser reads only the `data:` line and JSON-parses the
 * payload, so a raw (non-JSON) payload would be dropped as `custom`.
 *
 * The `chatId` filter ensures nodes streaming to the wrong chat don't pollute
 * the output (defensive — in practice there's one streamer per chat).
 */
export class SseStreamer implements IServerSideEventStreamer {
  /** Events buffered before a live stream is attached (drain()'s source). */
  private readonly events: StreamEvent[] = []
  private readonly chatId: string
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private stream: ReadableStream<Uint8Array> | null = null
  private closed = false

  constructor(chatId: string) {
    this.chatId = chatId
  }

  streamTokenEvent(chatId: string, token: string): void {
    if (chatId !== this.chatId) return
    this.push({ event: 'token', data: token })
  }

  streamEndEvent(chatId: string): void {
    if (chatId !== this.chatId) return
    this.push({ event: 'end', data: '[DONE]' })
  }

  streamErrorEvent(chatId: string, error: string): void {
    if (chatId !== this.chatId) return
    this.push({ event: 'error', data: error })
  }

  streamMetadataEvent(chatId: string, metadata: Record<string, unknown>): void {
    if (chatId !== this.chatId) return
    this.push({ event: 'metadata', data: metadata })
  }

  streamCustomEvent(chatId: string, event: string, data: unknown): void {
    if (chatId !== this.chatId) return
    this.push({ event: `custom:${event}`, data })
  }

  /** Whether the live stream has already been closed by an end/error event. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Route one event: buffer it (no live stream yet) or enqueue it live.
   * `end`/`error` close the live stream; pushes after close are dropped.
   */
  private push(ev: StreamEvent): void {
    if (this.closed) return

    if (!this.controller) {
      this.events.push(ev)
      return
    }

    this.controller.enqueue(encodeFrame(ev))
    if (ev.event === 'end' || ev.event === 'error') {
      this.closed = true
      try {
        this.controller.close()
      } catch {
        // client already cancelled the stream — nothing to do
      }
    }
  }

  /** Drain all buffered (pre-attachment) events. Returns them and clears the buffer. */
  drain(): StreamEvent[] {
    const out = [...this.events]
    this.events.length = 0
    return out
  }

  /**
   * Get the live ReadableStream of SSE frames. Idempotent — the same stream
   * instance is returned on repeated calls. Buffers any events pushed before
   * the first call, then streams live until an `end`/`error` event closes it.
   */
  toReadableStream(): ReadableStream<Uint8Array> {
    if (this.stream) return this.stream

    const buffered = this.drain()
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
        for (const ev of buffered) {
          controller.enqueue(encodeFrame(ev))
        }
        // A fully synchronous execution may have pushed end/error before
        // attachment — honour it by closing the stream right away.
        const last = buffered[buffered.length - 1]
        if (last && (last.event === 'end' || last.event === 'error')) {
          this.closed = true
          controller.close()
        }
      },
      cancel: () => {
        this.controller = null
        this.closed = true
      },
    })
    return this.stream
  }
}

/** Encode one StreamEvent as an SSE frame (bytes). */
function encodeFrame(ev: StreamEvent): Uint8Array {
  const payload = JSON.stringify({ event: ev.event, data: ev.data })
  const encoder = new TextEncoder()
  return encoder.encode(`event: ${ev.event}\ndata: ${payload}\n\n`)
}
