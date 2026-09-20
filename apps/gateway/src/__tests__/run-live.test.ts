import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import {
  forRunLive,
  attachRunLive,
  sweepRunLive,
  resetRunLiveForTest,
} from '../run-live-registry.js'

/**
 * 运行实时终端（live attach）测试：
 *  - 注册表单元（帧缓冲/回放/截断/重开/清扫）直接驱动 —— 纯内存无 DB。
 *  - 路由走 app.request 全链路，SSE 帧解析与前端同款语义（hello → frame*
 *    → runEnd 关流；404 回退阶梯）。
 */

const RUN = '11111111-1111-4111-8111-111111111111'
const FLOW = '22222222-2222-4222-8222-222222222222'

const ENV_ORIG: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in ENV_ORIG)) ENV_ORIG[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  resetRunLiveForTest()
})

afterEach(() => {
  for (const [k, v] of Object.entries(ENV_ORIG)) setEnv(k, v)
})

interface StreamEvent {
  event: string
  data: Record<string, unknown>
}

/** SSE 事件读取器（shell.test 同款语义：跨 chunk 缓冲 + 逐帧推进）。 */
class EventReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private decoder = new TextDecoder()
  private buf = ''

  constructor(res: Response) {
    if (!res.body) throw new Error('no stream body')
    this.reader = res.body.getReader()
  }

  async until(predicate: (e: StreamEvent) => boolean, timeoutMs = 3000): Promise<StreamEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const idx = this.buf.indexOf('\n\n')
      if (idx >= 0) {
        const block = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        if (!block.startsWith(':')) {
          let event = 'message'
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (data) {
            const evt = { event, data: JSON.parse(data) as Record<string, unknown> }
            if (predicate(evt)) return evt
          }
        }
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for frame; buf=${this.buf}`)
      const { done, value } = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('read timeout')), deadline - Date.now()),
        ),
      ])
      if (done) throw new Error(`stream closed; buf=${this.buf}`)
      this.buf += this.decoder.decode(value, { stream: true })
    }
  }

  /** 继续读到流终点（复用同一 reader —— 流已锁，不能再 getReader）。 */
  async streamEnded(timeoutMs = 3000): Promise<boolean> {
    const { done } = await Promise.race([
      this.reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('read timeout')), timeoutMs),
      ),
    ])
    return done
  }
}

describe('run-live registry（帧缓冲与订阅）', () => {
  it('emit → 晚 attach 拿到全量回放（有序）', () => {
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A' })
    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: 'hello ' })
    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: 'world' })

    const got: unknown[] = []
    const att = attachRunLive(RUN, () => {})
    expect(att).not.toBeNull()
    const replay = att!.hello.replay.map((f) => f.type)
    expect(replay).toEqual(['nodeStart', 'delta', 'delta'])
    expect(att!.hello.flowId).toBe(FLOW)
    expect(att!.hello.ended).toBe(false)
    void got
  })

  it('attach 后实时帧按序到达；finish 推送 runEnd 并入缓冲', () => {
    const tap = forRunLive(RUN, FLOW)
    const live: string[] = []
    const att = attachRunLive(RUN, (f) => live.push(f.type))
    expect(att).not.toBeNull()

    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: 'x' })
    expect(live).toEqual(['delta'])
    tap.finish('completed')
    expect(live).toEqual(['delta', 'runEnd'])

    // 收口后再 attach：hello.ended + finalStatus + 回放含 runEnd，零订阅。
    const after = attachRunLive(RUN, () => {
      throw new Error('ended 条目不应再投帧')
    })
    expect(after!.hello.ended).toBe(true)
    expect(after!.hello.finalStatus).toBe('completed')
    expect(after!.hello.replay.at(-1)?.type).toBe('runEnd')
  })

  it('finish 后新帧重开条目（断点续跑同 runId）', () => {
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A' })
    tap.finish('awaiting_input')

    tap.nodeStart({ nodeId: 'n2', nodeName: 'B' })
    const att = attachRunLive(RUN, () => {})
    expect(att!.hello.ended).toBe(false)
    const types = att!.hello.replay.map((f) => f.type)
    expect(types).toEqual(['nodeStart', 'runEnd', 'nodeStart'])
  })

  it('finish 幂等：多路径重复收口不重发 runEnd（正常 settle + 异常 catch 双保险）', () => {
    const tap = forRunLive(RUN, FLOW)
    const live: string[] = []
    attachRunLive(RUN, (f) => live.push(f.type))
    tap.finish('completed')
    tap.finish('failed')
    tap.finish('cancelled')
    expect(live.filter((t) => t === 'runEnd')).toHaveLength(1)

    // 重开后再收口：恰好一次新的 runEnd
    tap.nodeStart({ nodeId: 'n2', nodeName: 'B' })
    tap.finish('failed')
    expect(live.filter((t) => t === 'runEnd')).toHaveLength(2)
    expect(live[live.length - 1]).toBe('runEnd')
  })

  it('未知 runId attach → null（404 回退阶梯）', () => {
    expect(attachRunLive('33333333-3333-4333-8333-333333333333', () => {})).toBeNull()
  })

  it('缓冲超限头部截断 + truncated 标记（不丢直播帧）', () => {
    setEnv('DAGENTS_RUNLIVE_BUFFER_BYTES', '2048')
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A' })
    for (let i = 0; i < 200; i++) {
      tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: `chunk-${i}-`.repeat(8) })
    }
    const att = attachRunLive(RUN, () => {})
    const head = att!.hello.replay[0]
    expect(head?.type).toBe('truncated')
    expect((head as { dropped: number }).dropped).toBeGreaterThan(0)
    // 尾部保真：最后一帧仍在
    expect(att!.hello.replay.at(-1)?.type).toBe('delta')
  })

  it('噪音闸：空文本与空活动不发射', () => {
    const tap = forRunLive(RUN, FLOW)
    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: '' })
    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'activity', kind: 'status', label: '' })
    const att = attachRunLive(RUN, () => {})
    expect(att!.hello.replay).toHaveLength(0)
  })

  it('nodeEnd 帧携带终态/错误/耗时', () => {
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A' })
    const startedAt = new Date(Date.now() - 1500).toISOString()
    const endedAt = new Date().toISOString()
    tap.nodeEnd({
      nodeId: 'n1',
      nodeName: 'A',
      startedAt,
      endedAt,
      status: 'failed',
      input: {},
      output: {},
      error: 'boom',
    })
    const att = attachRunLive(RUN, () => {})
    const end = att!.hello.replay.find((f) => f.type === 'nodeEnd') as {
      status: string
      error?: string
      durationMs?: number
    }
    expect(end.status).toBe('failed')
    expect(end.error).toBe('boom')
    expect(end.durationMs).toBeGreaterThanOrEqual(1400)
  })
})

describe('run-live sweeper（收敛与回收）', () => {
  it('已结束条目过保留期回收 → attach 404', () => {
    setEnv('DAGENTS_RUNLIVE_RETAIN_MS', '1000')
    const tap = forRunLive(RUN, FLOW)
    tap.finish('completed')
    const t0 = Date.now()
    sweepRunLive(t0, () => false)
    expect(attachRunLive(RUN, () => {})).not.toBeNull()
    sweepRunLive(t0 + 2000, () => false)
    expect(attachRunLive(RUN, () => {})).toBeNull()
  })

  it('无帧且无执行句柄 → 强制收敛 runEnd(unknown)；有句柄不误伤', () => {
    setEnv('DAGENTS_RUNLIVE_IDLE_END_MS', '1000')
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A' })
    const t0 = Date.now()

    // 有句柄：静默 run（如 HumanInput 挂起）不动
    sweepRunLive(t0 + 2000, () => true)
    expect(attachRunLive(RUN, () => {})?.hello.ended).toBe(false)

    // 无句柄：强制收敛并通知订阅者
    const live: string[] = []
    attachRunLive(RUN, (f) => live.push(f.type))
    sweepRunLive(t0 + 2000, () => false)
    expect(live).toContain('runEnd')
    const after = attachRunLive(RUN, () => {})
    expect(after?.hello.ended).toBe(true)
    expect(after?.hello.finalStatus).toBe('unknown')
  })
})

describe('GET /api/v1/workflows/runs/:runId/live（路由全链路）', () => {
  it('未知 run → 404 JSON（非 SSE）', async () => {
    const res = await app.request('/api/v1/workflows/runs/44444444-4444-4444-8444-444444444444/live')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = (await res.json()) as { success: boolean }
    expect(json.success).toBe(false)
  })

  it('非 uuid runId → 400', async () => {
    const res = await app.request('/api/v1/workflows/runs/not-a-uuid/live')
    expect(res.status).toBe(400)
  })

  it('hello 回放 → 实时帧 → runEnd 关流', async () => {
    const tap = forRunLive(RUN, FLOW)
    tap.nodeStart({ nodeId: 'n1', nodeName: 'A', })

    const res = await app.request(`/api/v1/workflows/runs/${RUN}/live`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = new EventReader(res)
    const hello = await reader.until((e) => e.event === 'hello')
    expect((hello.data as { replay: Array<{ type: string }> }).replay[0]?.type).toBe('nodeStart')

    tap.delta({ nodeId: 'n1', nodeName: 'A' }, { type: 'text', text: 'live!' })
    const frame = await reader.until((e) => e.event === 'frame')
    expect((frame.data as { type: string }).type).toBe('delta')

    tap.finish('completed')
    const end = await reader.until(
      (e) => e.event === 'frame' && (e.data as { type: string }).type === 'runEnd',
    )
    expect((end.data as { status: string }).status).toBe('completed')

    // runEnd 后服务端关流：后续 read 得 done
    expect(await reader.streamEnded()).toBe(true)
  })

  it('已结束 run：hello(ended) 后立即关流（无订阅）', async () => {
    const tap = forRunLive(RUN, FLOW)
    tap.finish('failed')

    const res = await app.request(`/api/v1/workflows/runs/${RUN}/live`)
    expect(res.status).toBe(200)
    const reader = new EventReader(res)
    const hello = await reader.until((e) => e.event === 'hello')
    expect((hello.data as { ended: boolean }).ended).toBe(true)
    expect(await reader.streamEnded()).toBe(true)
  })
})
