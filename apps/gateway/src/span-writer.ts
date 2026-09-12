/**
 * 增量 run_node_spans 写入器 — 画布节点实时进度的数据源。
 *
 * 由 DagExecutor 的 onNodeStart/onNodeEnd 钩子驱动：节点开始 → 写/更新
 * `running` 行；节点结束 → 终态（done/failed）+ 耗时/tokens/error。
 * 画布（或任何旁观者）通过 GET /workflows/runs/:runId/node-spans 轮询
 * 这些行,把状态刷到节点徽章上。
 *
 * (run_id, node_id) 无唯一约束 → UPDATE-then-INSERT 保证一行；回调内部
 * fire-and-forget（异常只记日志），绝不阻塞执行波。`writtenNodes` 让
 * 事后的批量落库跳过已增量写过的节点，避免重复行。
 */
import { runQuery, type NodeSpanStatus } from '@dagents/db'
import type { IExecutedNode, IStreamActivityKind, IStreamDelta } from '@dagents/workflow'

export interface SpanWriterDeps {
  runId: string
  flowId: string
  nodeLabelById: Map<string, string | null>
  nodeTypeById: Map<string, string | null>
  log: {
    warn: (msg: string, ctx: Record<string, unknown>) => void
  }
}

export interface IncrementalSpanWriter {
  onNodeStart: (node: { nodeId: string; nodeName: string }) => void
  onNodeEnd: (node: IExecutedNode) => void
  /**
   * 节点增量产出（2026-08-30 流式展示；2026-09-06 终端视图保真扩展）：
   * LLM/Agent 生成过程中的逐段文本与过程事件。内部按节点累积双通道 ——
   * `activity` 环形队列（面板策展摘要）+ `events` 全量日志（终端视图 /
   * 事后回放的数据源）。节流落库到 output 列，`WHERE status='running'`
   * 保证永不覆盖终态（onNodeEnd 语义不变）。
   */
  onNodeDelta: (node: { nodeId: string; nodeName: string }, chunk: IStreamDelta) => void
  /** 已经由增量路径写过的节点 id（事后批量落库据此跳过）。 */
  writtenNodes: Set<string>
}

export function makeIncrementalSpanWriter(deps: SpanWriterDeps): IncrementalSpanWriter {
  const { runId, flowId, nodeLabelById, nodeTypeById, log } = deps
  const writtenNodes = new Set<string>()

  // 按节点串行化写入：onNodeStart/onNodeEnd 是 fire-and-forget，毫秒级
  // 完成的节点两者几乎同时发出 —— 并发 upsert 的提交顺序不确定，start 的
  // running 可能覆盖 end 的终态（表现为节点永久卡「运行中」）。
  // promise 链保证同一节点的写入严格按回调发出顺序落库。
  const nodeQueues = new Map<string, Promise<void>>()
  const enqueue = (nodeId: string, write: () => Promise<void>): void => {
    const prev = nodeQueues.get(nodeId) ?? Promise.resolve()
    const next = prev.then(write, write)
    nodeQueues.set(nodeId, next)
    void next.catch(() => {})
  }

  const persist = (
    nodeId: string,
    status: NodeSpanStatus,
    extra: {
      startedAt?: Date
      finishedAt?: Date
      durationMs?: number
      tokens?: string | null
      error?: string | null
      input?: string | null
      output?: string | null
    },
  ): void => {
    enqueue(nodeId, async () => {
      try {
        // 单条幂等 upsert（依赖 uq_run_node_spans_run_node 唯一索引）：
        // 同一节点 start(running) → end(done) 快速连续触发时也不会产生重复行。
        // started_at 保留首次值（running 行先落库的时间戳）。
        await runQuery(
          `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, tokens, cost, error, input, output)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL, $11, $12, $13)
           ON CONFLICT (run_id, node_id) DO UPDATE SET
             status = EXCLUDED.status,
             finished_at = EXCLUDED.finished_at,
             duration_ms = EXCLUDED.duration_ms,
             tokens = COALESCE(EXCLUDED.tokens, run_node_spans.tokens),
             error = EXCLUDED.error,
             input = COALESCE(EXCLUDED.input, run_node_spans.input),
             output = COALESCE(EXCLUDED.output, run_node_spans.output)`,
          [
            runId,
            flowId,
            nodeId,
            nodeLabelById.get(nodeId) ?? null,
            nodeTypeById.get(nodeId) ?? null,
            status,
            extra.startedAt ?? new Date(),
            extra.finishedAt ?? null,
            extra.durationMs ?? null,
            extra.tokens ?? null,
            extra.error ?? null,
            extra.input ?? null,
            extra.output ?? null,
          ],
        )
      } catch (err) {
        log.warn('incremental span persist failed', { runId, nodeId, error: String(err) })
      }
    })
  }

  // ── 流式 partial（2026-08-30）：按节点累积 + 节流落库 ──
  // 双通道（2026-09-06 终端视图裁决「采集层保全文，展示层做策展」）：
  //  - `events`：全量过程日志（thinking 全文 / 工具参数 JSON / 工具输出 /
  //    status / log / error），终端视图与事后回放的数据源 —— 保真的唯一
  //    载体，只带防膨胀保险丝（条数/单条/总字节），不做语义截断。
  //  - `activity`：环形队列（最近 12 条）—— 摘要面板的策展缓存，summary
  //    是展示派生物（≤80 字单行），全文永远在 events 里。
  // 落库双节拍：text/activity 每 1s（旁观端轮询 700ms~1.2s，更快只是白写）；
  // events 每 5s 同刷一次（全量 JSON 重写随事件数增长，快节拍会让长跑节点
  // 的 UPDATE 载荷线性膨胀）。终态全文由 onNodeEnd 整体覆盖，双通道随终态
  // 保留（过程回放有审计价值）。
  const DELTA_FLUSH_INTERVAL_MS = 1000
  const EVENTS_FLUSH_INTERVAL_MS = 5000
  const ACTIVITY_RING = 12
  // events 保险丝：正常 Agent 运行的事件粒度是「块」（claude stream-json 的
  // thinking/工具调用按 content block 整块发，见 agent-adapters/claude.ts），
  // 数百条已覆盖 9 分钟级长跑；64KB 单条 / 1MB 总量拦的是病态 tool 输出。
  const EVENTS_MAX = 800
  const EVENT_DETAIL_MAX = 64 * 1024
  const EVENTS_BYTES_MAX = 1_000_000

  interface ActivityEntry {
    kind: IStreamActivityKind
    label: string
    /** 展示派生的单行摘要（≤80 字）—— 非数据层截断，全文在 events。 */
    summary: string
    at: string
  }
  interface EventEntry {
    kind: IStreamActivityKind
    label: string
    detail?: string
    at: string
  }
  interface DeltaBuffer {
    text: string
    activity: ActivityEntry[]
    events: EventEntry[]
    /** events 的近似字节量（label+detail 累加），O(1) 维护总量保险丝。 */
    eventBytes: number
  }
  const deltaBuffers = new Map<string, DeltaBuffer>()
  const deltaLastFlush = new Map<string, number>()
  const eventsLastFlush = new Map<string, number>()

  /** detail → 单行摘要（面板策展缓存用；保真数据不受影响）。 */
  const summaryOf = (detail: string | undefined): string => {
    if (!detail) return ''
    const flat = detail.replace(/\s+/g, ' ').trim()
    return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
  }

  const flushDelta = (nodeId: string, buf: DeltaBuffer, includeEvents: boolean): void => {
    deltaLastFlush.set(nodeId, Date.now())
    if (includeEvents) eventsLastFlush.set(nodeId, Date.now())
    void runQuery(
      `UPDATE run_node_spans
         SET output = $1::jsonb
       WHERE run_id = $2::uuid AND node_id = $3 AND status = 'running'`,
      [
        JSON.stringify({
          text: buf.text,
          content: buf.text,
          activity: buf.activity,
          ...(includeEvents ? { events: buf.events } : {}),
        }),
        runId,
        nodeId,
      ],
    ).catch((err: unknown) => {
      log.warn('delta span persist failed', { runId, nodeId, error: String(err) })
    })
  }

  return {
    onNodeStart: (n) => {
      writtenNodes.add(n.nodeId)
      persist(n.nodeId, 'running', { startedAt: new Date() })
    },
    onNodeEnd: (en) => {
      writtenNodes.add(en.nodeId)
      // 终态保留过程（2026-08-30 用户裁决：跑完即丢等于丢掉「它是怎么干的」；
      // 2026-09-06 升级为全量 events —— 终端视图回放的数据源）。
      const buf = deltaBuffers.get(en.nodeId)
      deltaBuffers.delete(en.nodeId)
      let outputJson =
        Object.keys(en.output ?? {}).length > 0 ? JSON.stringify(en.output) : null
      if (buf && (buf.activity.length > 0 || buf.events.length > 0)) {
        let base: Record<string, unknown> = {}
        if (outputJson) {
          try {
            base = JSON.parse(outputJson) as Record<string, unknown>
          } catch {
            base = {}
          }
        }
        outputJson = JSON.stringify({
          ...base,
          activity: buf.activity,
          events: buf.events,
        })
      }
      const started = en.startedAt ? new Date(en.startedAt) : new Date()
      const finished = en.endedAt ? new Date(en.endedAt) : new Date()
      persist(en.nodeId, en.status === 'failed' ? 'failed' : 'done', {
        startedAt: started,
        finishedAt: finished,
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        tokens: en.tokens ? JSON.stringify(en.tokens) : null,
        error: en.error ?? null,
        input: Object.keys(en.input ?? {}).length > 0 ? JSON.stringify(en.input) : null,
        output: outputJson,
      })
    },
    onNodeDelta: (n, chunk) => {
      let buf = deltaBuffers.get(n.nodeId)
      if (!buf) {
        buf = { text: '', activity: [], events: [], eventBytes: 0 }
        deltaBuffers.set(n.nodeId, buf)
      }
      if (chunk.type === 'text') {
        if (chunk.text.length === 0) return
        buf.text += chunk.text
      } else {
        const { kind, label, detail } = chunk
        if (label.length === 0 && !detail) return
        // events：全量保真（保险丝见常量注释）
        let fullDetail = detail
        if (fullDetail && fullDetail.length > EVENT_DETAIL_MAX) {
          fullDetail = fullDetail.slice(0, EVENT_DETAIL_MAX) + '\n…[fuse-truncated]'
        }
        const entry: EventEntry = { kind, label, at: new Date().toISOString() }
        if (fullDetail) entry.detail = fullDetail
        buf.events.push(entry)
        buf.eventBytes += label.length + (fullDetail?.length ?? 0) + 8
        if (buf.events.length > EVENTS_MAX) {
          const dropped = buf.events.shift()
          if (dropped) {
            buf.eventBytes -= dropped.label.length + (dropped.detail?.length ?? 0) + 8
          }
        }
        while (buf.events.length > 1 && buf.eventBytes > EVENTS_BYTES_MAX) {
          const dropped = buf.events.shift()
          if (dropped) {
            buf.eventBytes -= dropped.label.length + (dropped.detail?.length ?? 0) + 8
          }
        }
        // activity 环：面板策展缓存 —— status/log 是噪音不进环（events 里有）
        if (kind !== 'status' && kind !== 'log') {
          buf.activity.push({
            kind,
            label,
            summary: kind === 'tool' || kind === 'tool_result' ? summaryOf(fullDetail) : '',
            at: entry.at,
          })
          if (buf.activity.length > ACTIVITY_RING) buf.activity.shift()
        }
      }
      // user_input 即时落库（2026-09-08 可操作终端）：插话是用户主动动作，
      // stdin 行的回执与终端回显都指望它立即可见 —— 不等 5s events 慢节拍
      //（单条消息载荷可控，不引入膨胀；PRD §7）。
      const now = Date.now()
      if (chunk.type === 'activity' && chunk.kind === 'user_input') {
        flushDelta(n.nodeId, buf, true)
        return
      }
      if (now - (deltaLastFlush.get(n.nodeId) ?? 0) < DELTA_FLUSH_INTERVAL_MS) return
      const includeEvents = now - (eventsLastFlush.get(n.nodeId) ?? 0) >= EVENTS_FLUSH_INTERVAL_MS
      flushDelta(n.nodeId, buf, includeEvents)
    },
    writtenNodes,
  }
}
