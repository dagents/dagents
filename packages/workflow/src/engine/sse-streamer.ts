import type { IServerSideEventStreamer, StreamEvent } from '../types/stream.js'

/**
 * SSE streamer — collects events and exposes them as a ReadableStream.
 *
 * The executor creates one streamer per flow run. Nodes call `streamTokenEvent`
 * to push tokens; the HTTP route (Plan C) reads from `toReadableStream()` to
 * pipe to the client.
 *
 * Events are buffered in memory until `drain()` or `toReadableStream()` is
 * called. This keeps the streamer testable without a real HTTP response.
 *
 * The `chatId` filter ensures nodes streaming to the wrong chat don't pollute
 * the output (defensive — in practice there's one streamer per chat).
 */
export class SseStreamer implements IServerSideEventStreamer {
  private readonly events: StreamEvent[] = []
  private readonly chatId: string

  constructor(chatId: string) {
    this.chatId = chatId
  }

  streamTokenEvent(chatId: string, token: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'token', data: token })
  }

  streamEndEvent(chatId: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'end', data: '[DONE]' })
  }

  streamErrorEvent(chatId: string, error: string): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'error', data: error })
  }

  streamMetadataEvent(chatId: string, metadata: Record<string, unknown>): void {
    if (chatId !== this.chatId) return
    this.events.push({ event: 'metadata', data: metadata })
  }

  /** Drain all buffered events. Returns them and clears the buffer. */
  drain(): StreamEvent[] {
    const out = [...this.events]
    this.events.length = 0
    return out
  }

  /**
   * Convert buffered events to a ReadableStream of SSE-formatted bytes.
   *
   * Each event is framed as:
   *   event: <type>\n
   *   data: <json>\n\n
   *
   * This matches the framing in `apps/console/src/lib/sse.ts` (the Flowise
   * SSE parser), so the existing client-side `consumeStream` works unchanged
   * when Plan C switches the chat route to this streamer.
   */
  toReadableStream(): ReadableStream<Uint8Array> {
    const events = this.drain()
    const encoder = new TextEncoder()
    const chunks = events.map((ev) => {
      const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)
      return encoder.encode(`event: ${ev.event}\ndata: ${dataStr}\n\n`)
    })
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
  }
}
