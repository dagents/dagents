import { describe, it, expect } from 'vitest'
import { DirectReplyNode } from './direct-reply.node.js'
import { SseStreamer } from '../../engine/sse-streamer.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(message: string): INodeData {
  return {
    id: 'n1',
    name: 'directReplyAgentflow',
    inputs: { directReplyMessage: message },
  }
}

function makeContext(opts: Partial<IExecutionContext> = {}): IExecutionContext {
  return {
    chatId: 'c1',
    runId: 'r1',
    state: {},
    isLastNode: false,
    ...opts,
  }
}

describe('DirectReplyNode', () => {
  it('returns the configured message as output.content', async () => {
    const node = new DirectReplyNode()
    const result = await node.run(makeNodeData('hello there'), '', makeContext())
    expect(result.output.content).toBe('hello there')
    expect(result.id).toBe('n1')
    expect(result.name).toBe('directReplyAgentflow')
  })

  it('streams the message when isLastNode and sseStreamer present', async () => {
    const node = new DirectReplyNode()
    const streamer = new SseStreamer('c1')
    await node.run(
      makeNodeData('streamed message'),
      '',
      makeContext({ isLastNode: true, sseStreamer: streamer }),
    )
    const events = streamer.drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'token', data: 'streamed message' })
  })

  it('does not stream when not the last node', async () => {
    const node = new DirectReplyNode()
    const streamer = new SseStreamer('c1')
    await node.run(
      makeNodeData('no stream'),
      '',
      makeContext({ isLastNode: false, sseStreamer: streamer }),
    )
    expect(streamer.drain()).toHaveLength(0)
  })

  it('handles empty message gracefully', async () => {
    const node = new DirectReplyNode()
    const result = await node.run(makeNodeData(''), '', makeContext())
    expect(result.output.content).toBe('')
  })

  it('has correct static metadata', () => {
    const node = new DirectReplyNode()
    expect(node.name).toBe('directReplyAgentflow')
    expect(node.type).toBe('DirectReply')
    expect(node.category).toBe('Agent Flows')
    expect(node.inputs).toHaveLength(1)
    expect(node.inputs[0].name).toBe('directReplyMessage')
  })
})
