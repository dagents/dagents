/**
 * run-live-protocol.ts — 运行实时终端 SSE 协议的纯逻辑层（无 DOM / 无网络）。
 *
 * 帧形状来自 @dagents/contracts（run-live.ts）—— 双端单一事实源的浏览器侧
 * 消费点。结构与 shell-protocol 同构（分块边界 / 多帧挤 chunk / keepalive
 * 注释行都是出过契约 bug 的缝），但事件族不同：hello（订阅确认 + 回放前缀）
 * 与 frame（nodeStart/nodeEnd/delta/runEnd/truncated）。
 *
 * 使用：feed() 累积 chunk，返回本次新解出的事件；useRunLive 只管把事件
 * 交给 section 构建器 / 状态机，不自己碰字节。
 */

import type { RunLiveFrame, RunLiveHello } from '@dagents/contracts'

/** 解析后的流事件（hello 恰一次在前；frame 零或多条；注释块不产出）。 */
export type RunLiveEvent = { event: 'hello'; hello: RunLiveHello } | { event: 'frame'; frame: RunLiveFrame }

const FRAME_TYPES = new Set(['nodeStart', 'nodeEnd', 'delta', 'runEnd', 'truncated'])

/** 宽容解析单个 SSE 块 —— 注释块（`: ping`）/ 空 data / 畸形 JSON 返回 null。 */
export function parseRunLiveBlock(block: string): RunLiveEvent | null {
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
  if (event === 'hello') {
    // event 名已收窄，payload 形状由网关按同一契约产出（contracts/run-live.ts）。
    return { event: 'hello', hello: payload as RunLiveHello }
  }
  if (event === 'frame') {
    const frame = payload as RunLiveFrame
    if (frame && typeof frame === 'object' && FRAME_TYPES.has(frame.type)) {
      return { event: 'frame', frame }
    }
  }
  return null
}

/**
 * 增量事件解析器：push() 吸收任意分片的文本 chunk，返回其间完整解出的
 * 事件。缓冲区跨 push 保留（半帧不丢）。
 */
export function createRunLiveParser(): (chunk: string) => RunLiveEvent[] {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    const events: RunLiveEvent[] = []
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const evt = parseRunLiveBlock(block)
      if (evt) events.push(evt)
    }
    return events
  }
}
