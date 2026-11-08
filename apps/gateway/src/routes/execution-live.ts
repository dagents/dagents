/**
 * GET /api/v1/workflows/runs/:runId/live — 运行实时终端（live attach，2026-09）。
 *
 * run 的实时帧流（SSE）：hello（回放前缀 + 订阅后状态）→ frame*（引擎
 * start/end/delta 镜像，含插话 user_input 回显）→ runEnd 后关流。晚订阅者
 * 从 hello.replay 拿全量前缀再追 live；断点续跑/HumanInput 应答回答重开条目时，
 * replay 里的 runEnd 是阶段边界。
 *
 * 可用性阶梯（2026-10-07 R7 升级，design-recover §3.4(c)）：
 *   1. 进程内 live 条目（attachRunLive）——直播/保留期回放，行为不变；
 *   2. 条目 404 → **journal 回放**：run_node_journal 的 event 行按 seq 升序
 *      透明重建 hello.replay（帧形状契约不变，console 双 builder 零改动——
 *      AC-R7-5：运行结束刷新页面轨迹/终端与关闭前一致）。ended/finalStatus
 *      由 runs 行终态判定；有 journal 的 run 不出现 truncated 头部提示
 *      （journal 无环形丢弃），超回放上限（DAGENTS_JOURNAL_REPLAY_MAX，
 *      默认 20k）时头部聚合截断标记如实呈现；
 *   3. 「无 live 条目且无 journal 行」才 404 —— 客户端回退 node-spans 轮询
 *      渲染（真正的未知 run / 旧运行）。
 *
 * 插话不经本流：仍走 POST /runs/:runId/message（排队补话语义），送达回执
 * 以 user_input 活动帧回到本流。协议契约：@dagents/contracts 的 run-live.ts
 * （双端单一事实源，shell.ts 的姊妹篇）。
 */
import { Hono } from 'hono'
import type { RunLiveFrame, RunLiveHello } from '@dagents/contracts'
import { attachRunLive, type RunLiveAttachment } from '../run-live-registry.js'
import { listEventFrames } from '../repositories/run-node-journal.repo.js'
import { getRunStatusAndDuration } from '../repositories/runs.repo.js'

/** Mounted at /api/v1/workflows — GET /runs/:runId/live */
export const runLiveRoutes = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 单次 journal 回放上限（§3.4(c) 诚实截断，与 1.5 保护性上限同族）。 */
const replayMax = (): number => {
  const raw = Number(process.env.DAGENTS_JOURNAL_REPLAY_MAX)
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000
}

/** runs 行终态判定（回放 hello.ended 的数据源；与 console 词表同口径）。 */
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'partial_success',
  'budget_exceeded',
  'failed',
  'stopped',
  'cancelled',
])

/**
 * journal → 回放 hello（§3.4(c)）：event 行 payload = RunLiveFrame 原样
 * （at/seq 原值，不得重打）；run 无 runEnd event 行（崩溃丢失的在途边界帧）
 * 时 ended 仍以 runs 行终态为准——中断事实由 runs 行的 stopped(interrupted)
 * 承载，不静默缺行。runs 行查不到（半记录 run）按未结束处理（SSE 开着，
 * 客户端等不到新帧自然超时回退——与旧 404 行为等价的诚实降级）。
 */
async function journalReplayHello(
  runId: string,
): Promise<{ hello: RunLiveHello } | null> {
  const { frames, total, truncatedHead, flowId } = await listEventFrames(runId, {
    limit: replayMax(),
  })
  if (total === 0 && frames.length === 0) return null
  const replay: RunLiveFrame[] = []
  if (truncatedHead) {
    replay.push({
      type: 'truncated',
      dropped: total - frames.length,
    })
  }
  let startedAtIso: string | null = null
  for (const row of frames) {
    const frame = row.frame as unknown as RunLiveFrame
    if (frame.type !== 'truncated') {
      const at = (frame as { at?: string }).at
      if (startedAtIso == null && at) startedAtIso = at
    }
    replay.push(frame)
  }
  const runRow = await getRunStatusAndDuration(runId).catch(() => null)
  const ended = runRow != null && TERMINAL_RUN_STATUSES.has(runRow.status)
  const hello: RunLiveHello = {
    replay,
    ended,
    ...(runRow?.status != null && ended ? { finalStatus: runRow.status } : {}),
    flowId: flowId ?? '',
    startedAt: startedAtIso ?? new Date().toISOString(),
  }
  return { hello }
}

runLiveRoutes.get('/runs/:runId/live', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return c.json({ success: false, error: 'invalid runId' }, 400)
  }

  // 先 attach 判存在性（null = 无条目 → journal 回放阶梯），再建流。attach 到
  // ReadableStream start 之间是同步代码，帧只会进 prebuffer（实际为空窗），
  // 建流后按序补投 —— 不丢帧。
  const prebuffer: RunLiveFrame[] = []
  let push: (frame: RunLiveFrame) => void = (f) => prebuffer.push(f)
  const attachment: RunLiveAttachment | null = attachRunLive(runId, (f) => push(f))
  // ── journal 回放（R7 §3.4(c)）：live 条目 404 → journal event 行重建
  // hello.replay，SSE 一次性交付后关流；journal 也无行才是真 404。 ──
  let journalHello: RunLiveHello | null = null
  if (!attachment) {
    const replay = await journalReplayHello(runId).catch(() => null)
    if (replay) {
      journalHello = replay.hello
    } else {
      return c.json(
        {
          success: false,
          error: 'run live stream unavailable (unknown run, gateway restarted, or retention expired)',
          runId,
        },
        404,
      )
    }
  }
  const hello = attachment ? attachment.hello : journalHello!
  const ended = attachment ? attachment.hello.ended : journalHello!.ended
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
        attachment?.unsubscribe()
        try {
          controller.close()
        } catch {
          /* 客户端已断开 */
        }
      }

      send('hello', hello)
      if (ended) {
        close()
        return
      }
      // journal 回放但 runs 行未终态（半记录 run / live 条目被逐）：一次性
      // 交付后关流——回放不是直播，没有后续帧可追（旧 404 的等价诚实降级）。
      if (!attachment) {
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
