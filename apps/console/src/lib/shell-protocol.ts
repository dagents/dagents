/**
 * shell-protocol.ts — 终端 SSE 协议的纯逻辑层（无 DOM / 无网络）。
 *
 * 帧形状来自 @dagents/contracts（shell.ts）—— 双端单一事实源的浏览器侧
 * 消费点。抽取成纯模块是为了可测：分块边界（`\n\n` 被网络分片劈开、多帧
 * 挤在一个 chunk、keepalive 注释行）这些恰恰是之前出过契约 bug 的缝。
 *
 * 使用：feed() 累积 chunk，返回本次新解出的帧；组件只管把帧映射到
 * term.write / 状态机，不自己碰字节。
 */

import type { ShellStreamFrame } from '@dagents/contracts'

/** base64 → UTF-8 字节（term.write 收字节流可正确处理跨块多字节字符）。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** UTF-8 字符串 → base64（键入/粘贴回传 PTY stdin）。 */
export function strToB64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 解析单个 SSE 块（`event: x\ndata: {...}`）—— 注释块（`: ping`）返回 null。 */
export function parseSseBlock(block: string): ShellStreamFrame | null {
  if (!block || block.startsWith(':')) return null
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data += line.slice(6)
  }
  if (!data) return null
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (event === 'hello' || event === 'data' || event === 'exit') {
    // event 名已收窄，但 payload 的 JSON 形状只能断言 —— 网关是同契约的
    // 唯一生产者（@dagents/contracts/shell.ts），双端共享该事实源。
    return { event, data: payload } as ShellStreamFrame
  }
  return null
}

/**
 * 增量帧解析器：push() 吸收任意分片的文本 chunk，返回其间完整解出的帧。
 * 缓冲区跨 push 保留（半帧不丢）。
 */
export function createShellFrameParser(): (chunk: string) => ShellStreamFrame[] {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    const frames: ShellStreamFrame[] = []
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const frame = parseSseBlock(block)
      if (frame) frames.push(frame)
    }
    return frames
  }
}
