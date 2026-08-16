import { describe, it, expect } from 'vitest'
import { SseStreamer } from '../engine/sse-streamer.js'

describe('SseStreamer', () => {
  it('collects events for later reading', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'hello')
    streamer.streamTokenEvent('chat-123', ' world')
    streamer.streamEndEvent('chat-123')
    const events = streamer.drain()
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ event: 'token', data: 'hello' })
    expect(events[1]).toEqual({ event: 'token', data: ' world' })
    expect(events[2]).toEqual({ event: 'end', data: '[DONE]' })
  })

  it('ignores events for other chatIds', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('other-chat', 'ignored')
    streamer.streamTokenEvent('chat-123', 'kept')
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('kept')
  })

  it('streamErrorEvent produces an error event', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamErrorEvent('chat-123', 'something broke')
    const events = streamer.drain()
    expect(events[0]).toEqual({ event: 'error', data: 'something broke' })
  })

  it('drain returns empty after first drain', () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'x')
    streamer.drain()
    expect(streamer.drain()).toHaveLength(0)
  })

  it('toReadableStream produces SSE-formatted bytes with JSON-envelope data lines', async () => {
    const streamer = new SseStreamer('chat-123')
    streamer.streamTokenEvent('chat-123', 'hi')
    streamer.streamEndEvent('chat-123')
    const readable = streamer.toReadableStream()
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('event: token')
    expect(text).toContain('data: {"event":"token","data":"hi"}')
    expect(text).toContain('event: end')
    expect(text).toContain('data: {"event":"end","data":"[DONE]"}')
  })

  it('streams live: events pushed after toReadableStream still arrive', async () => {
    const streamer = new SseStreamer('chat-123')
    const readable = streamer.toReadableStream()
    const reader = readable.getReader()
    const decoder = new TextDecoder()

    // Push events AFTER the stream was attached — they must still be
    // delivered (this is the chat streaming path: the route attaches the
    // stream, then the executor pushes tokens as nodes run).
    streamer.streamTokenEvent('chat-123', 'late ')
    streamer.streamTokenEvent('chat-123', 'token')
    streamer.streamEndEvent('chat-123')

    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('{"event":"token","data":"late "}')
    expect(text).toContain('{"event":"token","data":"token"}')
    expect(text).toContain('{"event":"end","data":"[DONE]"}')
  })

  it('closes the stream on error and drops later events', async () => {
    const streamer = new SseStreamer('chat-123')
    const readable = streamer.toReadableStream()
    const reader = readable.getReader()
    streamer.streamErrorEvent('chat-123', 'boom')
    streamer.streamTokenEvent('chat-123', 'after close')

    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('{"event":"error","data":"boom"}')
    expect(text).not.toContain('after close')
    expect(streamer.isClosed).toBe(true)
  })

  it('toReadableStream is idempotent — same stream instance', () => {
    const streamer = new SseStreamer('chat-123')
    expect(streamer.toReadableStream()).toBe(streamer.toReadableStream())
  })
})

describe('SseStreamer (custom events)', () => {
  it('emits custom:* events with the prefixed wire name', async () => {
    const streamer = new SseStreamer('chat-1')
    const readable = streamer.toReadableStream()
    streamer.streamCustomEvent?.('chat-1', 'human_input', { prompt: 'name?' })
    streamer.streamEndEvent('chat-1')

    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('event: custom:human_input')
    expect(text).toContain('"event":"custom:human_input"')
  })
})
