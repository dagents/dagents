import { describe, it, expect } from 'vitest'
import { parseRunLiveBlock, createRunLiveParser } from '@/lib/run-live-protocol'

/** run-live SSE 协议解析测试 —— 与 shell-protocol.test 同族：分块边界、
 *  多帧挤 chunk、keepalive、畸形载荷都是出过契约 bug 的缝。 */

describe('parseRunLiveBlock', () => {
  it('hello 块解析（含 replay 数组）', () => {
    const evt = parseRunLiveBlock(
      'event: hello\ndata: {"replay":[{"type":"nodeStart","nodeId":"n1","nodeName":"A"}],"ended":false,"flowId":"f1","startedAt":"2026-09-19T00:00:00.000Z"}',
    )
    expect(evt?.event).toBe('hello')
    if (evt?.event === 'hello') {
      expect(evt.hello.replay).toHaveLength(1)
      expect(evt.hello.ended).toBe(false)
    }
  })

  it('frame 块解析（delta）', () => {
    const evt = parseRunLiveBlock(
      'event: frame\ndata: {"type":"delta","nodeId":"n1","nodeName":"A","delta":{"type":"text","text":"hi"}}',
    )
    expect(evt?.event).toBe('frame')
    if (evt?.event === 'frame') {
      expect(evt.frame.type).toBe('delta')
    }
  })

  it('keepalive 注释块 → null', () => {
    expect(parseRunLiveBlock(': ping')).toBeNull()
  })

  it('畸形 JSON → null（不抛）', () => {
    expect(parseRunLiveBlock('event: frame\ndata: {oops')).toBeNull()
  })

  it('未知 event 名 → null', () => {
    expect(parseRunLiveBlock('event: weird\ndata: {"a":1}')).toBeNull()
  })

  it('frame 类型不在白名单 → null（宽容但不冒充）', () => {
    expect(parseRunLiveBlock('event: frame\ndata: {"type":"bogus"}')).toBeNull()
  })

  it('空 data → null', () => {
    expect(parseRunLiveBlock('event: frame')).toBeNull()
  })
})

describe('createRunLiveParser（增量）', () => {
  it('跨 chunk 的半帧不丢（\\n\\n 被劈开）', () => {
    const p = createRunLiveParser()
    const first = p('event: fra')
    expect(first).toHaveLength(0)
    const second = p('me\ndata: {"type":"runEnd","status":"completed"}\n\n')
    expect(second).toHaveLength(1)
    expect(second[0]?.event).toBe('frame')
  })

  it('一个 chunk 多帧 + 混入 keepalive', () => {
    const p = createRunLiveParser()
    const events = p(
      ': ping\n\n' +
        'event: frame\ndata: {"type":"nodeStart","nodeId":"n1","nodeName":"A"}\n\n' +
        'event: frame\ndata: {"type":"delta","nodeId":"n1","nodeName":"A","delta":{"type":"text","text":"x"}}\n\n',
    )
    expect(events.map((e) => e.event)).toEqual(['frame', 'frame'])
  })

  it('多行 data 拼接（SSE 规范允许 data 续行）', () => {
    const p = createRunLiveParser()
    const events = p('event: frame\ndata: {"type":"truncated",\ndata: "dropped":3}\n\n')
    expect(events).toHaveLength(1)
  })
})
