/**
 * journal-writer —— `run_node_journal` 的写侧单点（R1/R7，design-recover
 * §3.4(b)，AD-R1/AD-R2）。
 *
 * 单表两用（kind 判别）：
 *  - `event` 行 = R7 事件流（payload = RunLiveFrame 原样，含 at/seq 原值）。
 *    结构帧（nodeStart/nodeEnd/runEnd）经 run-live-registry 的 emit 单点取号
 *    后 **write-through**：先落库（本 writer 的 per-run 串行链）再发帧——
 *    任意 kill 时机下回放 ⊇ 客户端已收前缀（AC-R7-1）；delta 帧
 *    **write-behind**：微批（64 条 / 200ms 窗口）异步落库，崩溃窗口的
 *    未落库尾部允许丢失、回放侧如实呈现（不劣于现状 live 缓冲重启即全丢）。
 *  - `decision` 行 = R1 决策记录（节点终态 onNodeEnd 相邻写入；无完成记录
 *    = 重跑）。迭代控制器对同一节点会二次触发 onNodeEnd（体内完成后重发）
 *    ——decision upsert 按 (run_id, node_id, ordinal) 幂等（部分唯一索引
 *    uq_run_node_journal_decision 是兜底，AC-R1-2 每 (nodeId, ordinal) 一档）。
 *
 * 与 run_node_spans 的分工：spans 降格为观测投影（(run_id, node_id) 末次
 * 覆盖），本表是唯一真相源；两者并存是「投影 vs 真相源」，不是双写双真相源。
 *
 * 引擎接缝（§3.1(e)）：本 writer 实现 `ExecuteOptions.journal` 的
 * JournalFacade（recordDecision / lookup）——引擎保持 DB-free，宿主注入。
 *
 * 单 run 保护性上限（NFR-7）：`DAGENTS_JOURNAL_MAX_ROWS_PER_RUN`（默认
 * 100_000）——超限后 delta 帧拒收并留痕（一条 journal_overflow event 行 +
 * /metrics 计数器 + warn 日志，不静默丢）。
 */
import type { RunLiveFrame } from '@dagents/contracts'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { JournalDecision, JournalFacade } from '@dagents/workflow'
import { declareCounter, declareGauge } from './lib/metrics.js'
import { findDecision, type JournalDecisionRow } from './repositories/run-node-journal.repo.js'
import type { RunLiveJournalSink } from './run-live-registry.js'

const log = createLogger({ svc: 'gateway:journal-writer' })

const journalRowsTotal = declareCounter(
  'dagents_journal_rows_written_total',
  'run_node_journal rows written, by kind (decision/event)',
  ['kind'],
)
const journalOverflowTotal = declareCounter(
  'dagents_journal_overflow_total',
  'Runs whose journal hit DAGENTS_JOURNAL_MAX_ROWS_PER_RUN — subsequent delta frames are rejected (with a trace row, never silently dropped)',
)
const journalSeqConflictTotal = declareCounter(
  'dagents_journal_seq_conflict_total',
  'Journal inserts rejected by the (run_id, seq) unique index — the single-writer fuse (never expected >0 in normal operation)',
)
/** write-behind 积压 gauge（NFR-6）：delta 微批未落库行数。 */
declareGauge('dagents_journal_delta_lag_rows', 'Delta frames buffered in journal-writer awaiting the write-behind flush (all runs)', {
  collect: () => deltaLagRows,
})

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** 单 run journal 行数保护性上限（NFR-7；0/负值 = 关闭，不推荐）。 */
const journalMaxRowsPerRun = (): number => numEnv('DAGENTS_JOURNAL_MAX_ROWS_PER_RUN', 100_000)
/** delta 微批窗口（条数 / 毫秒，先到先 flush）。 */
const DELTA_BATCH_ROWS = 64
const DELTA_BATCH_MS = 200

let deltaLagRows = 0

/** event 行的 runEnd 帧 node_id（journal 表约定，entity 注释同源）。run 级
 *  过程流事件（预算黄警等）也用它作为 nodeId——终端侧聚合为 run 级段。 */
export const RUN_MARKER_NODE_ID = '__run__'

export interface JournalWriter extends JournalFacade, RunLiveJournalSink {
  /** run 终态收口：flush delta 微批（fire-and-forget，不阻塞 settle）。 */
  close(): void
  /** 已写行数（上限对账 + 测试用）。 */
  rowsWritten(): number
}

export function makeJournalWriter(opts: {
  runId: string
  flowId: string
  /** seq 单点取号（run-live-registry 的 per-run 计数器，AD-R5）。 */
  allocSeq: () => number
}): JournalWriter {
  const { runId, flowId } = opts
  let rows = 0
  let overflowed = false

  // per-run 串行链（span-writer nodeQueues 同款模式）：所有 journal INSERT
  // 排队保序——结构帧 write-through、decision 行、delta 微批 flush 共用，
  // 「decision 与 nodeEnd event 行相邻写入」由此保证（§1.1 同事务性）。
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    chain = chain.then(write, write)
    void chain.catch(() => {})
    return chain
  }

  const insertRows = async (
    rowsToInsert: Array<{
      nodeId: string
      ordinal: number
      kind: 'decision' | 'event'
      seq: number
      eventType: string | null
      payload: unknown
    }>,
  ): Promise<void> => {
    if (rowsToInsert.length === 0) return
    const placeholders: string[] = []
    const values: unknown[] = []
    let i = 1
    for (const row of rowsToInsert) {
      placeholders.push(
        `($${i++}::uuid, $${i++}::text, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb)`,
      )
      values.push(
        runId,
        flowId,
        row.nodeId,
        row.ordinal,
        row.kind,
        row.seq,
        row.eventType,
        JSON.stringify(row.payload),
      )
    }
    try {
      // 不带 ON CONFLICT：撞 (run_id, seq) 唯一索引就抛错——显式报错留痕
      //（AD-R5：单写者模型下该索引只是抢号保险丝，静默 DO NOTHING 会让
      // 乱序/双写者不可见）。
      await runQuery(
        `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, event_type, payload)
         VALUES ${placeholders.join(', ')}`,
        values,
      )
      for (const row of rowsToInsert) journalRowsTotal.inc(1, { kind: row.kind })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/uq_run_node_journal_run_seq/.test(msg)) {
        journalSeqConflictTotal.inc()
        log.warn('journal seq conflict (single-writer fuse tripped)', { runId, error: msg })
      } else {
        log.warn('journal insert failed (non-fatal)', { runId, error: msg })
      }
    }
  }

  // ── delta 微批（write-behind）──
  let deltaBuffer: Array<{ nodeId: string; ordinal: number; seq: number; frame: RunLiveFrame }> =
    []
  let deltaTimer: ReturnType<typeof setTimeout> | null = null

  const flushDeltas = (): void => {
    if (deltaTimer != null) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    if (deltaBuffer.length === 0) return
    const batch = deltaBuffer
    deltaBuffer = []
    deltaLagRows -= batch.length
    void enqueue(() =>
      insertRows(
        batch.map((b) => ({
          nodeId: b.nodeId,
          ordinal: b.ordinal,
          kind: 'event' as const,
          seq: b.seq,
          eventType: 'delta',
          payload: b.frame,
        })),
      ),
    )
  }

  /** 超限留痕行：不是静默丢——一条 event 行如实记录拒收（NFR-7）。 */
  const recordOverflow = (rejectedSoFar: number): void => {
    log.warn('journal per-run row cap reached — delta frames rejected (trace row kept)', {
      runId,
      cap: journalMaxRowsPerRun(),
      rejectedSoFar,
    })
    journalOverflowTotal.inc()
    const seq = opts.allocSeq()
    void enqueue(() =>
      insertRows([
        {
          nodeId: RUN_MARKER_NODE_ID,
          ordinal: 0,
          kind: 'event',
          seq,
          eventType: 'journal_overflow',
          payload: { type: 'journal_overflow', runId, rejectedDeltaFrames: rejectedSoFar, at: new Date().toISOString() },
        },
      ]),
    )
  }

  const underCap = (): boolean => {
    const cap = journalMaxRowsPerRun()
    if (cap <= 0) return true
    return rows < cap
  }

  const writer: JournalWriter = {
    // ── RunLiveJournalSink（registry emit 挂点）──
    captureStructural(rawFrame: RunLiveFrame): Promise<void> {
      // emit 侧只对结构帧调用本方法（truncated/delta 不进）；seq 已由 emit
      // 单点分配——收窄读，缺席兜底取号（防御旧调用路径）。
      const frame = rawFrame as RunLiveFrame & { seq?: number; nodeId?: string; ordinal?: number }
      const seq = frame.seq ?? opts.allocSeq()
      rows += 1
      return enqueue(() =>
        insertRows([
          {
            nodeId:
              frame.type === 'runEnd' ? RUN_MARKER_NODE_ID : (frame.nodeId ?? RUN_MARKER_NODE_ID),
            ordinal: frame.type === 'nodeStart' || frame.type === 'nodeEnd' ? frame.ordinal ?? 0 : 0,
            kind: 'event',
            seq,
            eventType: frame.type,
            payload: frame,
          },
        ]),
      )
    },

    captureDelta(rawFrame: RunLiveFrame): void {
      const frame = rawFrame as RunLiveFrame & { seq?: number; nodeId?: string }
      if (overflowed) return
      if (!underCap()) {
        overflowed = true
        recordOverflow(1)
        return
      }
      deltaBuffer.push({
        nodeId: frame.nodeId ?? RUN_MARKER_NODE_ID,
        ordinal: 0,
        seq: frame.seq ?? opts.allocSeq(),
        frame,
      })
      deltaLagRows += 1
      rows += 1
      if (deltaBuffer.length >= DELTA_BATCH_ROWS) {
        flushDeltas()
        return
      }
      if (deltaTimer == null) {
        deltaTimer = setTimeout(() => flushDeltas(), DELTA_BATCH_MS)
        deltaTimer.unref?.()
      }
    },

    // ── JournalFacade（引擎 ExecuteOptions.journal 接缝，§3.1(e)）──
    recordDecision(entry: JournalDecision): void {
      const seq = opts.allocSeq()
      rows += 1
      // 幂等 upsert（迭代控制器 onNodeEnd 二次触发）：部分唯一索引
      // (run_id, node_id, ordinal) WHERE kind='decision' 兜底，后写覆盖
      // payload（体内完成后的终态快照胜出）。
      void enqueue(async () => {
        try {
          await runQuery(
            `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, event_type, payload)
             VALUES ($1::uuid, $2::text, $3, $4, 'decision', $5, NULL, $6::jsonb)
             ON CONFLICT (run_id, node_id, ordinal) WHERE kind = 'decision'
             DO UPDATE SET payload = EXCLUDED.payload`,
            [
              runId,
              flowId,
              entry.nodeId,
              entry.ordinal,
              seq,
              JSON.stringify({
                status: entry.status,
                ...(entry.inputHash ? { inputHash: entry.inputHash } : {}),
                ...(entry.input != null ? { input: entry.input } : {}),
                ...(entry.output != null ? { output: entry.output } : {}),
                ...(entry.tokens != null ? { tokens: entry.tokens } : {}),
                ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
                ...(entry.lineage ? { lineage: entry.lineage } : {}),
              }),
            ],
          )
          journalRowsTotal.inc(1, { kind: 'decision' })
        } catch (err) {
          log.warn('journal decision insert failed (non-fatal)', {
            runId,
            nodeId: entry.nodeId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    },

    async lookup(nodeId: string, ordinal: number): Promise<JournalDecision | null> {
      try {
        const row: JournalDecisionRow | null = await findDecision(runId, nodeId, ordinal)
        return row ? toFacadeDecision(row) : null
      } catch (err) {
        log.warn('journal lookup failed (non-fatal)', {
          runId,
          nodeId,
          ordinal,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },

    close(): void {
      flushDeltas()
    },

    rowsWritten(): number {
      return rows
    },
  }
  return writer
}

/** repo 行 → 引擎 JournalDecision（payload 形状映射集中在 repo/writer 一线）。 */
function toFacadeDecision(row: JournalDecisionRow): JournalDecision {
  const p = row.payload
  return {
    nodeId: row.nodeId,
    ordinal: row.ordinal,
    status: p.status,
    ...(p.inputHash ? { inputHash: p.inputHash } : {}),
    ...(p.input != null ? { input: p.input } : {}),
    ...(p.output != null ? { output: p.output } : {}),
    ...(p.tokens != null
      ? { tokens: p.tokens as import('@dagents/workflow').ITokenUsage | null }
      : {}),
    ...(p.resolvedModel ? { resolvedModel: p.resolvedModel } : {}),
    ...(p.lineage ? { lineage: p.lineage } : {}),
  }
}
