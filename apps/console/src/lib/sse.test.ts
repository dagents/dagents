import { describe, it, expect } from 'vitest'
import { parseFrame, consumeStream } from './sse'

/**
 * SSE parser tests (P1.10.T2).
 *
 * Flowise frames look like `message:\ndata:{"event":"token","data":"hi"}\n\n`.
 * These tests pin the framing + event typing so the chat view can rely on it.
 */

function frame(dataLine: string): string {
  return `message:\ndata:${dataLine}\n\n`
}

describe('parseFrame', () => {
  it('parses a token event', () => {
    const ev = parseFrame('data:{"event":"token","data":"hel"}')
    expect(ev).toEqual({ event: 'token', data: 'hel' })
  })

  it('parses a metadata event with chatId/sessionId', () => {
    const ev = parseFrame('data:{"event":"metadata","data":{"chatId":"c1","sessionId":"s1"}}')
    expect(ev?.event).toBe('metadata')
    expect((ev as { data: Record<string, unknown> }).data).toEqual({ chatId: 'c1', sessionId: 's1' })
  })

  it('parses an end event', () => {
    expect(parseFrame('data:{"event":"end","data":"[DONE]"}')).toEqual({ event: 'end', data: '[DONE]' })
  })

  it('parses an error event', () => {
    const ev = parseFrame('data:{"event":"error","data":"boom"}')
    expect(ev).toEqual({ event: 'error', data: 'boom' })
  })

  it('parses a thinking event with duration', () => {
    const ev = parseFrame('data:{"event":"thinking","data":"hmm","duration":120}')
    expect(ev).toEqual({ event: 'thinking', data: 'hmm', duration: 120 })
  })

  it('falls back to custom for unknown events', () => {
    const ev = parseFrame('data:{"event":"agentReasoning","data":{"x":1}}')
    expect(ev).toEqual({ event: 'agentReasoning', data: { x: 1 } })
  })

  it('treats a bare [DONE] as end', () => {
    expect(parseFrame('data:[DONE]')).toEqual({ event: 'end', data: '[DONE]' })
  })

  it('returns null for empty/whitespace', () => {
    expect(parseFrame('')).toBeNull()
    expect(parseFrame('data:')).toBeNull()
  })
})

describe('consumeStream', () => {
  function toStream(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(text))
        controller.close()
      },
    })
  }

  async function collect(text: string) {
    const out: string[] = []
    for await (const ev of consumeStream(toStream(text))) {
      if (ev.event === 'token' || ev.event === 'end' || ev.event === 'error') {
        out.push(`${ev.event}:${ev.data}`)
      } else {
        out.push(ev.event)
      }
    }
    return out
  }

  it('splits on \\n\\n frame boundaries and yields events in order', async () => {
    const text =
      frame('{"event":"token","data":"Hello"}') +
      frame('{"event":"token","data":" world"}') +
      frame('{"event":"metadata","data":{"sessionId":"s1"}}') +
      frame('{"event":"end","data":"[DONE]"}')
    expect(await collect(text)).toEqual(['token:Hello', 'token: world', 'metadata', 'end:[DONE]'])
  })

  it('ignores heartbeat comment lines', async () => {
    const text = ':heartbeat\n\n' + frame('{"event":"token","data":"x"}')
    expect(await collect(text)).toEqual(['token:x'])
  })

  it('handles a partial frame split across chunks', async () => {
    const enc = new TextEncoder()
    const tokenFrame = frame('{"event":"token","data":"A"}')
    const part1 = enc.encode(tokenFrame.slice(0, 20))
    const part2 = enc.encode(tokenFrame.slice(20))
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(part1)
        controller.enqueue(part2)
        controller.enqueue(enc.encode(frame('{"event":"end","data":"[DONE]"}')))
        controller.close()
      },
    })
    const out: string[] = []
    for await (const ev of consumeStream(stream)) {
      if (ev.event === 'token') out.push(`t:${ev.data}`)
      if (ev.event === 'end') out.push('end')
    }
    expect(out).toEqual(['t:A', 'end'])
  })

  it('yields error events without throwing', async () => {
    const text = frame('{"event":"error","data":"upstream 500"}')
    expect(await collect(text)).toEqual(['error:upstream 500'])
  })
})
