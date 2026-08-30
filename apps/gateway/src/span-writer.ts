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
import type { IExecutedNode } from '@dagents/workflow'

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
   * 节点增量产出（2026-08-30 流式展示）：LLM/Agent 生成过程中逐段文本。
   * 内部按节点累积 + 节流（≥1s）UPDATE 到 output 列 —— 轮询端
   * （画布/详情/旁观）在节点 running 期间就能渲染 live tail。
   * `WHERE status='running'` 保证永不覆盖终态全文（onNodeEnd 语义不变）。
   */
  onNodeDelta: (node: { nodeId: string; nodeName: string }, delta: string) => void
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
  // 每 1s 至多刷一次（旁观端轮询 700ms~1.2s，更快的落库只是白写）。
  // 直接 UPDATE（非 upsert）+ status='running' 守卫：行必已存在（start
  // 先于任何 delta），且永不与终态写入竞争 —— 即使乱序执行，done/failed
  // 行对 UPDATE 免疫，running 行的 partial 也会被 onNodeEnd 全文覆盖。
  const DELTA_FLUSH_INTERVAL_MS = 1000
  const deltaBuffers = new Map<string, string>()
  const deltaLastFlush = new Map<string, number>()

  const flushDelta = (nodeId: string, partial: string): void => {
    deltaLastFlush.set(nodeId, Date.now())
    void runQuery(
      `UPDATE run_node_spans
         SET output = $1::jsonb
       WHERE run_id = $2::uuid AND node_id = $3 AND status = 'running'`,
      [JSON.stringify({ text: partial, content: partial }), runId, nodeId],
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
      // 终态即停：残留 buffer 不再有意义（全文即将/已经覆盖）
      deltaBuffers.delete(en.nodeId)
      const started = en.startedAt ? new Date(en.startedAt) : new Date()
      const finished = en.endedAt ? new Date(en.endedAt) : new Date()
      persist(en.nodeId, en.status === 'failed' ? 'failed' : 'done', {
        startedAt: started,
        finishedAt: finished,
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        tokens: en.tokens ? JSON.stringify(en.tokens) : null,
        error: en.error ?? null,
        input: Object.keys(en.input ?? {}).length > 0 ? JSON.stringify(en.input) : null,
        output: Object.keys(en.output ?? {}).length > 0 ? JSON.stringify(en.output) : null,
      })
    },
    onNodeDelta: (n, delta) => {
      if (delta.length === 0) return
      const prev = deltaBuffers.get(n.nodeId) ?? ''
      const next = prev + delta
      deltaBuffers.set(n.nodeId, next)
      const last = deltaLastFlush.get(n.nodeId) ?? 0
      if (Date.now() - last >= DELTA_FLUSH_INTERVAL_MS) {
        flushDelta(n.nodeId, next)
      }
    },
    writtenNodes,
  }
}
