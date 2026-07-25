/**
 * SSE streaming interface — what nodes use to push events to the client.
 *
 * This is the typed replacement for Flowise's `IServerSideEventStreamer`.
 * The actual implementation lives in `engine/sse-streamer.ts`.
 */

/** Event types the streamer can emit. */
export type StreamEvent =
  | { event: 'start'; data: string }
  | { event: 'token'; data: string }
  | { event: 'thinking'; data: string; duration?: number }
  | { event: 'metadata'; data: Record<string, unknown> }
  | { event: 'end'; data: '[DONE]' }
  | { event: 'error'; data: string }

/** Interface every SSE streamer implements. Nodes call these methods. */
export interface IServerSideEventStreamer {
  /** Send a token chunk to the client (streamed assistant reply). */
  streamTokenEvent(chatId: string, token: string): void
  /** Send the end sentinel — closes the stream. */
  streamEndEvent(chatId: string): void
  /** Send an error message to the client. */
  streamErrorEvent(chatId: string, error: string): void
  /** Send a metadata event (run id, node info, etc.). */
  streamMetadataEvent?(chatId: string, metadata: Record<string, unknown>): void
}
