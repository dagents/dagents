import { describe, it, expect } from 'vitest'
import { b64ToBytes, strToB64, parseSseBlock, createShellFrameParser } from '../shell-protocol'

/**
 * 终端 SSE 协议纯逻辑测试 —— 网络分片/多帧/keepalive/畸形帧都是真实链路
 * （BFF 流式代理 → fetch reader）会出现的形状；此前协议内嵌组件零覆盖，
 * hello.replay 契约 bug（原始文本 vs base64）就是从这个缝漏过去的。
 */

describe('base64 helpers', () => {
  it('round-trips ASCII', () => {
    expect(new TextDecoder().decode(b64ToBytes(strToB64('ls -la\r')))).toBe('ls -la\r')
  })

  it('round-trips multibyte UTF-8 (emoji / CJK)', () => {
    const s = '中文🎨 café'
    expect(new TextDecoder().decode(b64ToBytes(strToB64(s)))).toBe(s)
  })

  it('keeps raw bytes for ANSI escapes', () => {
    const bytes = b64ToBytes(Buffer.from('\x1b[31mRED\x1b[0m').toString('base64'))
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x1b, 0x5b, 0x33, 0x31])
  })
})

describe('parseSseBlock', () => {
  it('parses a hello frame with base64 replay', () => {
    const replay = Buffer.from('rowan@host ~ %').toString('base64')
    const f = parseSseBlock(`event: hello\ndata: {"replay":"${replay}","exited":false,"cols":80,"rows":24}`)
    expect(f?.event).toBe('hello')
    if (f?.event === 'hello') {
      expect(new TextDecoder().decode(b64ToBytes(f.data.replay))).toBe('rowan@host ~ %')
      expect(f.data.exited).toBe(false)
    }
  })

  it('skips keepalive comments and empty blocks', () => {
    expect(parseSseBlock(': ping')).toBeNull()
    expect(parseSseBlock('')).toBeNull()
  })

  it('skips malformed JSON without throwing', () => {
    expect(parseSseBlock('event: data\ndata: {oops')).toBeNull()
  })

  it('ignores unknown event names (forward-compat)', () => {
    expect(parseSseBlock('event: future\ndata: {"x":1}')).toBeNull()
  })
})

describe('createShellFrameParser (chunk-boundary safety)', () => {
  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const push = createShellFrameParser()
    const stream =
      'event: hello\ndata: {"replay":"","exited":false,"cols":80,"rows":24}\n\n' +
      ': ping\n\n' +
      'event: data\ndata: {"b64":"aGVsbG8="}\n\n' +
      'event: exit\ndata: {"code":0}\n\n'
    // 按 7 字符一片喂入 —— 所有边界（含 \n\n 劈开、JSON 中段）都必须重组
    const collected = []
    for (let i = 0; i < stream.length; i += 7) {
      collected.push(...push(stream.slice(i, i + 7)))
    }
    expect(collected.map((f) => f.event)).toEqual(['hello', 'data', 'exit'])
    if (collected[1]?.event === 'data') {
      expect(new TextDecoder().decode(b64ToBytes(collected[1].data.b64))).toBe('hello')
    }
    if (collected[2]?.event === 'exit') {
      expect(collected[2].data.code).toBe(0)
    }
  })

  it('keeps a partial tail buffered until the terminator arrives', () => {
    const push = createShellFrameParser()
    expect(push('event: data\ndata: {"b64":"aG')).toEqual([])
    const frames = push('k="}\n\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe('data')
  })

  it('delivers multiple frames packed in one chunk', () => {
    const push = createShellFrameParser()
    const frames = push(
      'event: data\ndata: {"b64":"MQ=="}\n\nevent: data\ndata: {"b64":"Mg=="}\n\n',
    )
    expect(frames.map((f) => f.event)).toEqual(['data', 'data'])
  })
})
