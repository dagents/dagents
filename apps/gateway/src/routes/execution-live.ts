/**
 * GET /api/v1/workflows/runs/:runId/live — 运行实时终端（live attach，2026-09）。
 *
 * run 的实时帧流（SSE）：hello（回放前缀 + 订阅后状态）→ frame*（引擎
 * start/end/delta 镜像，含插话 user_input 回显）→ runEnd 后关流。晚订阅者
 * 从 hello.replay 拿全量前缀再追 live；断点续跑/HumanInput 应答重开条目时，
 * replay 里的 runEnd 是阶段边界。
 *
 * 404 = 无进程内条目（run 未知 / 网关中途重启 / 保留期已过清扫）—— 客户端
 * 回退 node-spans 轮询渲染（DB 路径永远在），这是诚实的可用性阶梯。
 *
 * 插话不经本流：仍走 POST /runs/:runId/message（排队补话语义），送达回执
 * 以 user_input 活动帧回到本流。协议契约：@dagents/contracts 的 run-live.ts
 * （双端单一事实源，shell.ts 的姊妹篇）。
 */
import { Hono } from 'hono'
import type { RunLiveFrame } from '@dagents/contracts'
import { attachRunLive, type RunLiveAttachment } from '../run-live-registry.js'

/** Mounted at /api/v1/workflows — GET /runs/:runId/live */
export const runLiveRoutes = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

runLiveRoutes.get('/runs/:runId/live', (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return c.json({ success: false, error: 'invalid runId' }, 400)
  }

  // 先 attach 判存在性（null = 无条目 → 404 回退阶梯），再建流。attach 到
  // ReadableStream start 之间是同步代码，帧只会进 prebuffer（实际为空窗），
  // 建流后按序补投 —— 不丢帧。
  const prebuffer: RunLiveFrame[] = []
  let push: (frame: RunLiveFrame) => void = (f) => prebuffer.push(f)
  const attachment: RunLiveAttachment | null = attachRunLive(runId, (f) => push(f))
  if (!attachment) {
    return c.json(
      {
        success: false,
        error: 'run live stream unavailable (unknown run, gateway restarted, or retention expired)',
        runId,
      },
      404,
    )
  }
  const encoder = new TextEncoder()
  const signal = c.req.raw.signal

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (event: string, payload: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`))
        } catch {
          closed = true
        }
      }
      // SSE 保活注释行：防中间层（Next dev 代理等）掐空闲连接；与 shell 同款
      // 15s。无条件创建（ended 条目随即被 close 清掉，代价可忽略）。
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          closed = true
        }
      }, 15_000)
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        attachment.unsubscribe()
        try {
          controller.close()
        } catch {
          /* 客户端已断开 */
        }
      }

      send('hello', attachment.hello)
      if (attachment.hello.ended) {
        close()
        return
      }

      // 正式通道接管（覆盖 prebuffer 收集器），再按序补投空窗帧。
      push = (frame: RunLiveFrame) => {
        send('frame', frame)
        if (frame.type === 'runEnd') close()
      }
      for (const f of prebuffer) push(f)

      // 客户端断开（关页/导航/换 run）即退订；条目本体按保留期清扫。
      signal.addEventListener('abort', close, { once: true })
    },
  })

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-accel-buffering', 'no')
  return c.body(readable)
})
