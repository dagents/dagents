/**
 * R9b run 完成通知服务端半（design-sharp §6.4 / AC-R9-3）：真 ws-hub 全链路
 * ——HTTP upgrade + ?run= 订阅 + broadcastRun 定向投递 + run-notify 单点
 * 的 claim 幂等与 superseded 抑制。
 *
 * 真服务器而非 mock：帧的 JSON 形状、订阅维度定向（run 维度与 chat 维度
 * 互不串扰）、幂等 claim 的「第二次调用零帧」——只有全链路能钉住。
 * （dev-notes 首批只钉了「不抛」，本文件补齐可观测断言。）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { wsHub } from '../ws-hub.js'
import { notifyRunFinished, resetRunNotifyClaimForTests } from '../lib/run-notify.js'

/** 起真 wsHub 并返回基础 URL；收帧收集器按 runId 过滤。 */
async function startHub(): Promise<{ url: () => string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  wsHub.attachToServer(server)
  const port = (server.address() as { port: number }).port
  return {
    url: () => `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        wsHub.shutdown()
        server.close(() => resolve())
      }),
  }
}

interface FrameCollector {
  frames: Array<Record<string, unknown>>
  /** 订阅就绪（open + connection handler 注册完订阅集的余量）。 */
  ready: Promise<void>
  /** 关闭事件落地（close() 后 await 它，防悬空连接跨用例）。 */
  waitClose: Promise<void>
  close: () => void
}

function connect(url: string): FrameCollector {
  const frames: Array<Record<string, unknown>> = []
  const ws = new WebSocket(url)
  let resolveOpen!: () => void
  const opened = new Promise<void>((resolve) => {
    resolveOpen = resolve
  })
  ws.on('open', resolveOpen)
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)) as Record<string, unknown>)
    } catch {
      /* 非 JSON 忽略 */
    }
  })
  const waitClose = new Promise<void>((resolve) => {
    ws.on('close', resolve)
  })
  return {
    frames,
    ready: (async () => {
      await opened
      // 给订阅注册一点事件循环余量（connection handler 同步注册订阅集）
      await new Promise((r) => setTimeout(r, 50))
    })(),
    waitClose,
    close: () => ws.close(),
  }
}

/** 轮询等待直到条件为真或超时（帧是异步到达的）。 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 30))
  }
  return true
}

describe('R9b run 完成通知（ws-hub 全链路 + claim + superseded 抑制）', () => {
  let hub: Awaited<ReturnType<typeof startHub>>

  beforeAll(async () => {
    hub = await startHub()
  })

  afterAll(async () => {
    await hub.close()
  })

  beforeEach(() => {
    resetRunNotifyClaimForTests()
  })

  it('订阅 ?run=<id> 的客户端收到 run-updated 终态帧（形状含 runId/status/flowId）', async () => {
    const sub = connect(`${hub.url()}?run=run-frame-shape`)
    await sub.ready
    notifyRunFinished({
      runId: 'run-frame-shape',
      flowId: 'flow-1',
      status: 'completed',
    })
    expect(await until(() => sub.frames.length === 1)).toBe(true)
    expect(sub.frames[0]).toMatchObject({
      type: 'run-updated',
      runId: 'run-frame-shape',
      flowId: 'flow-1',
      status: 'completed',
    })
    sub.close()
    await sub.waitClose
  })

  it('claim 幂等：同 runId 第二次发射零新帧（AC-R9-3 至多一次的服务端半）', async () => {
    const sub = connect(`${hub.url()}?run=run-claim-once`)
    await sub.ready
    notifyRunFinished({ runId: 'run-claim-once', status: 'failed' })
    expect(await until(() => sub.frames.length === 1)).toBe(true)
    notifyRunFinished({ runId: 'run-claim-once', status: 'failed' })
    notifyRunFinished({ runId: 'run-claim-once', status: 'completed' })
    await new Promise((r) => setTimeout(r, 150))
    expect(sub.frames).toHaveLength(1)
    sub.close()
    await sub.waitClose
  })

  it('superseded 零发射 + 非终态（awaiting_input/running）零发射（AC-R3-6 最小实现服务端半）', async () => {
    const sub = connect(`${hub.url()}?run=run-suppressed`)
    await sub.ready
    notifyRunFinished({ runId: 'run-suppressed', status: 'stopped', stopReason: 'superseded' })
    notifyRunFinished({ runId: 'run-suppressed', status: 'awaiting_input' })
    notifyRunFinished({ runId: 'run-suppressed', status: 'running' })
    await new Promise((r) => setTimeout(r, 150))
    expect(sub.frames).toHaveLength(0)
    sub.close()
    await sub.waitClose
  })

  it('订阅维度定向：?chat= 客户端不收 run-updated 帧；未订阅该 runId 的客户端同样不收', async () => {
    const chatSub = connect(`${hub.url()}?chat=chat-1`)
    const otherRunSub = connect(`${hub.url()}?run=run-other`)
    await chatSub.ready
    await otherRunSub.ready
    notifyRunFinished({ runId: 'run-dim-target', status: 'completed' })
    // 目标维度另连一个，验证帧只到它
    const target = connect(`${hub.url()}?run=run-dim-target`)
    await target.ready
    notifyRunFinished({ runId: 'run-dim-target-2', status: 'failed' })
    await new Promise((r) => setTimeout(r, 150))
    expect(chatSub.frames).toHaveLength(0)
    expect(otherRunSub.frames).toHaveLength(0)
    expect(target.frames).toHaveLength(0) // 第二个 runId 未被 target 订阅
    for (const c of [chatSub, otherRunSub, target]) {
      c.close()
      await c.waitClose
    }
  })

  it('控制帧动态订阅：subscribe(runId) 后同样收到定向帧（对齐 console ws-client 的 subscribeRun）', async () => {
    const ws = new WebSocket(hub.url())
    const frames: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve) => ws.on('open', resolve))
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)) as Record<string, unknown>)
      } catch {
        /* 非 JSON 忽略 */
      }
    })
    ws.send(JSON.stringify({ type: 'subscribe', runId: 'run-ctrl-sub' }))
    await new Promise((r) => setTimeout(r, 50))
    notifyRunFinished({ runId: 'run-ctrl-sub', status: 'partial_success' })
    expect(await until(() => frames.length === 1)).toBe(true)
    expect(frames[0]).toMatchObject({
      type: 'run-updated',
      runId: 'run-ctrl-sub',
      status: 'partial_success',
    })
    ws.close()
  })
})
