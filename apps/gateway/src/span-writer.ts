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

  return {
    onNodeStart: (n) => {
      writtenNodes.add(n.nodeId)
      persist(n.nodeId, 'running', { startedAt: new Date() })
    },
    onNodeEnd: (en) => {
      writtenNodes.add(en.nodeId)
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
    writtenNodes,
  }
}
